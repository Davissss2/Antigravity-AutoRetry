import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';
import { StatusBarManager } from './statusBar';
import { Config } from './config';

/** Command to send a prompt to the Antigravity agent panel */
const SEND_PROMPT_CMD = 'antigravity.sendPromptToAgentPanel';

/**
 * Patterns that indicate the agent has errored and needs a retry.
 * We watch the Antigravity log files for these strings.
 */
const ERROR_PATTERNS = [
    'terminated due to error',
    'Agent terminated',
    'agent terminated',
];

export class AutoRetryController {
    private pollingTimer: NodeJS.Timeout | undefined;
    private countdownTimer: NodeJS.Timeout | undefined;

    // Log file watching
    private logWatcher: fs.FSWatcher | undefined;
    private watchedLogFile: string | undefined;
    private logFilePosition = 0;

    // State
    private _isRunning        = false;
    private _countdown        = 0;
    private _totalRetries     = 0;
    private _successRetries   = 0;
    private _failedRetries    = 0;
    private _lastRetryTime: Date | undefined;
    private _hasLoggedCommands = false;

    /** True while we are in an error state (prevents double-firing) */
    private _inErrorState = false;

    constructor(
        private readonly log: Logger,
        private readonly statusBar: StatusBarManager
    ) {}

    // ─── Public API ──────────────────────────────────────────────────────────

    start() {
        if (this._isRunning) { return; }
        this._isRunning = true;

        this._startLogWatcher();
        this._startPolling();

        this.log.log(`▶ AutoRetry started — watching for agent errors (poll: ${Config.getIntervalSeconds()}s)`);
        this.statusBar.update(true, this._countdown);
    }

    stop() {
        if (!this._isRunning) { return; }
        this._isRunning = false;
        this._stopLogWatcher();
        this._clearTimers();
        this._countdown = 0;
        this.log.log('⏹ AutoRetry stopped');
        this.statusBar.update(false, 0);
    }

    toggle()  { this._isRunning ? this.stop() : this.start(); }
    restart() { this.stop(); this.start(); }

    async retryNow() {
        this.log.log('🔁 Manual retry triggered');
        // Dump diagnostics for debugging
        try {
            const diags = await vscode.commands.executeCommand('antigravity.getDiagnostics');
            const diagStr = typeof diags === 'string' ? diags : JSON.stringify(diags, null, 2);
            const outPath = path.join(os.homedir(), 'Desktop', 'autoretry', 'diagnostics_test.json');
            fs.writeFileSync(outPath, diagStr, 'utf8');
            this.log.log(`📋 Diagnostics saved to diagnostics_test.json`);
        } catch (e) {
            this.log.log(`⚠ Could not fetch diagnostics: ${e}`);
        }
        await this._doRetry();
    }

    onConfigChanged() {
        if (this._isRunning) {
            this.log.log('⚙ Config changed — restarting');
            this.restart();
        }
    }

    isRunning()         { return this._isRunning; }
    getCountdown()      { return this._countdown; }
    getTotalRetries()   { return this._totalRetries; }
    getSuccessRetries() { return this._successRetries; }
    getFailedRetries()  { return this._failedRetries; }
    getLastRetryTime()  { return this._lastRetryTime; }

    // ─── Log File Watching ────────────────────────────────────────────────────

    private _findLatestAntigravityLog(): string | undefined {
        try {
            const logsBase = path.join(
                os.homedir(), 'AppData', 'Roaming', 'Antigravity IDE', 'logs'
            );
            if (!fs.existsSync(logsBase)) { return undefined; }

            // Find newest session directory
            const sessions = fs.readdirSync(logsBase)
                .map(name => ({ name, full: path.join(logsBase, name) }))
                .filter(f => {
                    try { return fs.statSync(f.full).isDirectory(); } catch { return false; }
                })
                .sort((a, b) => b.name.localeCompare(a.name));

            if (!sessions.length) { return undefined; }

            // Primary log: the Antigravity IDE extension log
            const primary = path.join(
                sessions[0].full, 'window1', 'exthost',
                'google.antigravity', 'Antigravity IDE.log'
            );
            if (fs.existsSync(primary)) { return primary; }

            // Fallback: renderer log
            const renderer = path.join(sessions[0].full, 'window1', 'renderer.log');
            if (fs.existsSync(renderer)) { return renderer; }

            return undefined;
        } catch {
            return undefined;
        }
    }

    private _startLogWatcher() {
        const logFile = this._findLatestAntigravityLog();
        if (!logFile) {
            this.log.log('⚠ Antigravity log not found — error detection via polling only');
            return;
        }

        this.watchedLogFile = logFile;
        try {
            // Start reading from current end of file (ignore old content)
            const stat = fs.statSync(logFile);
            this.logFilePosition = stat.size;

            const shortName = logFile.split(path.sep).slice(-3).join('/');
            this.log.log(`👁 Watching: .../${shortName}`);

            this.logWatcher = fs.watch(logFile, (eventType) => {
                if (eventType === 'change') {
                    this._onLogChanged();
                }
            });
        } catch (e) {
            this.log.log(`⚠ Could not watch log: ${e}`);
        }
    }

    private _onLogChanged() {
        if (!this.watchedLogFile) { return; }
        try {
            const stat = fs.statSync(this.watchedLogFile);
            if (stat.size <= this.logFilePosition) { return; }

            // Read only the new bytes
            const newBytes = stat.size - this.logFilePosition;
            const buf = Buffer.alloc(newBytes);
            const fd = fs.openSync(this.watchedLogFile, 'r');
            fs.readSync(fd, buf, 0, newBytes, this.logFilePosition);
            fs.closeSync(fd);
            this.logFilePosition = stat.size;

            const newText = buf.toString('utf8');
            this._checkForError(newText, 'log file');
        } catch { /* ignore transient read errors */ }
    }

    private _stopLogWatcher() {
        try { this.logWatcher?.close(); } catch { /* ignore */ }
        this.logWatcher = undefined;
        this.watchedLogFile = undefined;
    }

    // ─── Polling (backup detection via getDiagnostics) ────────────────────────

    private _startPolling() {
        const sec = Config.getIntervalSeconds();
        this._countdown = sec;
        this.statusBar.update(true, this._countdown);

        this.countdownTimer = setInterval(() => {
            this._countdown = Math.max(0, this._countdown - 1);
            this.statusBar.update(true, this._countdown);
        }, 1000);

        this.pollingTimer = setInterval(async () => {
            await this._pollDiagnostics();
            this._countdown = Config.getIntervalSeconds();
        }, sec * 1000);
    }

    private async _pollDiagnostics() {
        // Log available commands once
        if (!this._hasLoggedCommands) {
            this._hasLoggedCommands = true;
            const allCmds = await vscode.commands.getCommands(true);
            const agCmds = allCmds.filter(c =>
                c.toLowerCase().includes('antigravity') && !c.includes('autoretry')
            );
            this.log.log(`🔍 Antigravity commands available: ${JSON.stringify(agCmds)}`);
        }

        try {
            const diags = await vscode.commands.executeCommand('antigravity.getDiagnostics');
            if (diags !== undefined && diags !== null) {
                const diagStr = typeof diags === 'string' ? diags : JSON.stringify(diags);
                this._checkForError(diagStr, 'diagnostics');
            }
        } catch { /* getDiagnostics unavailable — silent */ }
    }

    // ─── Error Detection & Retry ──────────────────────────────────────────────

    private _checkForError(text: string, source: string) {
        if (this._inErrorState) { return; } // Already handling

        const lower = text.toLowerCase();
        const matched = ERROR_PATTERNS.find(p => lower.includes(p.toLowerCase()));
        if (!matched) { return; }

        this._inErrorState = true;
        this.log.log(`🔴 Error detected (${source}): "${matched}" → retrying in 1s...`);

        // Small delay to let the UI settle before sending
        setTimeout(() => { this._doRetry(); }, 1000);
    }

    private async _doRetry() {
        const allCmds = await vscode.commands.getCommands(true);
        let ok = false;

        // Primary: sendPromptToAgentPanel with "Continue"
        if (allCmds.includes(SEND_PROMPT_CMD)) {
            try {
                await vscode.commands.executeCommand(SEND_PROMPT_CMD, 'Continue');
                ok = true;
            } catch (err) {
                this.log.log(`  → ✗ sendPromptToAgentPanel failed: ${err}`);
            }
        }

        // Fallback: user custom command
        if (!ok) {
            const custom = Config.getCustomCommand();
            if (custom && allCmds.includes(custom)) {
                try {
                    await vscode.commands.executeCommand(custom);
                    ok = true;
                } catch (err) {
                    this.log.log(`  → ✗ Custom command ${custom} failed: ${err}`);
                }
            }
        }

        if (ok) {
            this._totalRetries++;
            this._lastRetryTime = new Date();
            this._successRetries++;
            this.log.log(`✅ [Retry #${this._totalRetries}] Sent "Continue" at ${this._lastRetryTime.toLocaleTimeString()}`);
            if (Config.areNotificationsEnabled()) {
                vscode.window.setStatusBarMessage(`$(sync~spin) AutoRetry: fired #${this._totalRetries}`, 3000);
            }
            // Reset error state after a delay so we can detect future errors
            setTimeout(() => { this._inErrorState = false; }, 10000);
        } else {
            this._failedRetries++;
            this._inErrorState = false; // Reset so we can try again next detection
            this.log.log(`❌ Retry failed — could not find a working command`);
        }
    }

    // ─── Timers ───────────────────────────────────────────────────────────────

    private _clearTimers() {
        if (this.pollingTimer)   { clearInterval(this.pollingTimer);   this.pollingTimer = undefined; }
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = undefined; }
    }
}
