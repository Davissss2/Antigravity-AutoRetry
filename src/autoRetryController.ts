import * as vscode from 'vscode';
import { Logger } from './logger';
import { StatusBarManager } from './statusBar';
import { Config } from './config';

/** Antigravity / VS Code commands to try — in priority order */
const RETRY_COMMANDS = [
    'antigravity.retry',
    'antigravity.retryLastRequest',
    'antigravity.agent.retry',
    'antigravity.retryAgent',
    'workbench.action.chat.retry',
    'workbench.action.chat.resendRequest',
];

export class AutoRetryController {
    private timer: NodeJS.Timeout | undefined;
    private countdownTimer: NodeJS.Timeout | undefined;

    private _isRunning   = false;
    private _countdown   = 0;
    private _totalRetries   = 0;
    private _successRetries = 0;
    private _failedRetries  = 0;
    private _lastRetryTime: Date | undefined;

    constructor(
        private readonly log: Logger,
        private readonly statusBar: StatusBarManager
    ) {}

    // ─── Public API ──────────────────────────────────────────────────────────

    start() {
        if (this._isRunning) { return; }
        this._isRunning = true;
        this._scheduleRetry();
        this.log.log(`▶ AutoRetry started — interval: ${Config.getIntervalSeconds()}s`);
        this.statusBar.update(true, this._countdown);
    }

    stop() {
        if (!this._isRunning) { return; }
        this._isRunning = false;
        this._clearTimers();
        this._countdown = 0;
        this.log.log('⏹ AutoRetry stopped');
        this.statusBar.update(false, 0);
    }

    toggle() {
        this._isRunning ? this.stop() : this.start();
    }

    restart() {
        this.stop();
        this.start();
    }

    async retryNow() {
        this.log.log('🔁 Manual retry triggered');
        await this._executeRetry();
        if (this._isRunning) {
            this._clearTimers();
            this._scheduleRetry();
        }
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

    // ─── Private ─────────────────────────────────────────────────────────────

    private _scheduleRetry() {
        const sec = Config.getIntervalSeconds();
        this._countdown = sec;
        this.statusBar.update(true, this._countdown);

        // tick every second to update countdown
        this.countdownTimer = setInterval(() => {
            this._countdown = Math.max(0, this._countdown - 1);
            this.statusBar.update(true, this._countdown);
        }, 1000);

        // main retry interval
        this.timer = setInterval(async () => {
            await this._executeRetry();
            this._countdown = Config.getIntervalSeconds();
        }, sec * 1000);
    }

    private async _executeRetry() {
        this._totalRetries++;
        this._lastRetryTime = new Date();
        this.log.log(`🔄 Retry #${this._totalRetries} at ${this._lastRetryTime.toLocaleTimeString()}`);

        const ok = await this._triggerRetry();
        if (ok) {
            this._successRetries++;
            this.log.log(`✅ Retry #${this._totalRetries} sent`);
            vscode.window.setStatusBarMessage(`$(sync~spin) AutoRetry: fired #${this._totalRetries}`, 3000);
        } else {
            this._failedRetries++;
            this.log.log(`⚠ Retry #${this._totalRetries} — no command found (set autoretry.customCommand)`);
        }
    }

    /** Try every known command until one succeeds */
    private async _triggerRetry(): Promise<boolean> {
        const allCmds = await vscode.commands.getCommands(true);

        // 1. Built-in Antigravity commands
        for (const cmd of RETRY_COMMANDS) {
            if (allCmds.includes(cmd)) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    this.log.log(`  → ✓ ${cmd}`);
                    return true;
                } catch (err) {
                    this.log.log(`  → ✗ ${cmd}: ${err}`);
                }
            }
        }

        // 2. User-configured custom command
        const custom = Config.getCustomCommand();
        if (custom) {
            try {
                await vscode.commands.executeCommand(custom);
                this.log.log(`  → ✓ custom: ${custom}`);
                return true;
            } catch (err) {
                this.log.log(`  → ✗ custom: ${err}`);
            }
        }

        // 3. Scan all registered commands for "retry"-like names from Antigravity
        const retryLike = allCmds.filter((c: string) =>
            (c.includes('antigravity') || c.includes('antigravity')) &&
            (c.toLowerCase().includes('retry') || c.toLowerCase().includes('rerun'))
        );
        if (retryLike.length > 0) {
            try {
                this.log.log(`  → Found: ${retryLike[0]}`);
                await vscode.commands.executeCommand(retryLike[0]);
                return true;
            } catch { /* continue */ }
        }

        return false;
    }

    private _clearTimers() {
        if (this.timer)          { clearInterval(this.timer);          this.timer = undefined; }
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = undefined; }
    }
}
