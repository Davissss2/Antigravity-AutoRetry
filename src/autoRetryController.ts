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
 * Patterns in the Antigravity IDE log that indicate an agent error.
 * The Go language server uses E<date> prefix for ERROR level logs.
 * "run state not found" appears when the agent is terminated due to error.
 */
const ERROR_PATTERNS = [
    'run state not found',
    'AcknowledgeCodeActionStep',
];

export class AutoRetryController {
    private pollingTimer: NodeJS.Timeout | undefined;
    private countdownTimer: NodeJS.Timeout | undefined;

    // Log file watching
    private logWatcher: fs.FSWatcher | undefined;
    private watchedLogFile: string | undefined;
    private logFileSize = 0;

    // State
    private _isRunning         = false;
    private _countdown         = 0;
    private _totalRetries      = 0;
    private _successRetries    = 0;
    private _failedRetries     = 0;
    private _lastRetryTime: Date | undefined;
    private _hasLoggedCommands = false;

    /** Prevents double-firing: true while we are handling an error */
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
            fs.writeFileSync(outPath, diagStr ?? 'null', 'utf8');
            this.log.log(`📋 Diagnostics saved to diagnostics_test.json`);
        } catch (e) {
            this.log.log(`⚠ Could not fetch diagnostics: ${e}`);
        }
        this._inErrorState = false; // Allow manual retry always
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

    /**
     * Finds the active Antigravity IDE session log.
     * The session directory with an actual window1 subdirectory is the real session.
     * CLI-only sessions (just cli.log) are skipped.
     */
    private _findAntigravityLog(): string | undefined {
        try {
            const logsBase = path.join(
                os.homedir(), 'AppData', 'Roaming', 'Antigravity IDE', 'logs'
            );
            if (!fs.existsSync(logsBase)) {
                this.log.log(`⚠ Logs base not found: ${logsBase}`);
                return undefined;
            }

            // Find all sessions with a window1 directory (real sessions, not CLI installs)
            const sessions = fs.readdirSync(logsBase)
                .filter(name => {
                    try {
                        const w1 = path.join(logsBase, name, 'window1');
                        return fs.existsSync(w1) && fs.statSync(w1).isDirectory();
                    } catch { return false; }
                })
                .sort()
                .reverse(); // Most recent first

            if (!sessions.length) {
                this.log.log('⚠ No real Antigravity session found');
                return undefined;
            }

            const latestSession = sessions[0];
            const logPath = path.join(
                logsBase, latestSession,
                'window1', 'exthost', 'google.antigravity', 'Antigravity IDE.log'
            );

            this.log.log(`🔎 Session: ${latestSession}`);

            if (!fs.existsSync(logPath)) {
                this.log.log(`⚠ Log not found at: ${logPath}`);
                return undefined;
            }

            return logPath;
        } catch (e) {
            this.log.log(`⚠ Error finding log: ${e}`);
            return undefined;
        }
    }

    private _startLogWatcher() {
        const logFile = this._findAntigravityLog();
        if (!logFile) {
            this.log.log('⚠ Could not find Antigravity log — using polling only');
            return;
        }

        this.watchedLogFile = logFile;
        try {
            // Start reading from current end of file (ignore old content)
            this.logFileSize = fs.statSync(logFile).size;
            this.log.log(`👁 Watching: .../${path.basename(logFile)}`);

            this.logWatcher = fs.watch(logFile, (eventType) => {
                if (eventType === 'change') {
                    this._onLogChanged();
                }
            });
        } catch (e) {
            this.log.log(`⚠ Could not start log watcher: ${e}`);
        }
    }

    private _onLogChanged() {
        if (!this.watchedLogFile) { return; }
        try {
            const stat = fs.statSync(this.watchedLogFile);
            if (stat.size <= this.logFileSize) { return; }

            // Read only new content using a read stream from current position
            const fd = fs.openSync(this.watchedLogFile, 'r');
            const newSize = stat.size - this.logFileSize;
            const buf = new Uint8Array(newSize);
            fs.readSync(fd, buf, 0, newSize, this.logFileSize);
            fs.closeSync(fd);
            this.logFileSize = stat.size;

            const newText = Buffer.from(buf).toString('utf8');
            this._checkForError(newText, 'log');
        } catch { /* ignore transient read errors */ }
    }

    private _stopLogWatcher() {
        try { this.logWatcher?.close(); } catch { /* ignore */ }
        this.logWatcher = undefined;
        this.watchedLogFile = undefined;
    }

    // ─── Polling (backup detection) ───────────────────────────────────────────

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
            this.log.log(`🔍 Antigravity commands: ${JSON.stringify(agCmds)}`);
        }

        // Check diagnostics as backup
        try {
            const diags = await vscode.commands.executeCommand('antigravity.getDiagnostics');
            if (diags !== undefined && diags !== null) {
                const diagStr = typeof diags === 'string' ? diags : JSON.stringify(diags);
                this._checkForError(diagStr, 'diagnostics');
            }
        } catch { /* silent */ }
    }

    // ─── Error Detection & Retry ──────────────────────────────────────────────

    private _checkForError(text: string, source: string) {
        if (this._inErrorState) { return; }

        // Check for E-level (error) log lines from Go server
        const lines = text.split('\n');
        const hasGoError = lines.some(l => {
            // Go error format: E0612 HH:MM:SS.NNNNNN ...
            if (/^E\d{4}\s/.test(l.trim())) {
                return ERROR_PATTERNS.some(p => l.includes(p));
            }
            return false;
        });

        if (!hasGoError) { return; }

        // Find the matching line for logging
        const matchedLine = lines.find(l =>
            /^E\d{4}\s/.test(l.trim()) &&
            ERROR_PATTERNS.some(p => l.includes(p))
        ) ?? '';

        this._inErrorState = true;
        this.log.log(`🔴 Agent error detected (${source}): ${matchedLine.trim().substring(0, 120)}`);
        this.log.log('   → Retrying in 1.5s...');

        setTimeout(() => { this._doRetry(); }, 1500);
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
            // Reset after 15s so next error can be caught
            setTimeout(() => { this._inErrorState = false; }, 15000);
        } else {
            this._failedRetries++;
            this._inErrorState = false;
            this.log.log('❌ Retry failed — no working command found');
        }
    }

    // ─── Timers ───────────────────────────────────────────────────────────────

    private _clearTimers() {
        if (this.pollingTimer)   { clearInterval(this.pollingTimer);   this.pollingTimer = undefined; }
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = undefined; }
    }
}
