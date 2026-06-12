import * as vscode from 'vscode';

export class StatusBarManager {
    private item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            'antigravity-autoretry-status',
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'autoretry.toggle';
        this.item.show();
        this.update(false, 0);
    }

    update(running: boolean, countdown: number) {
        if (running) {
            const mins = Math.floor(countdown / 60);
            const secs = countdown % 60;
            const timeStr = mins > 0
                ? `${mins}m${String(secs).padStart(2, '0')}s`
                : `${secs}s`;

            this.item.text = `$(sync~spin) AutoRetry: ${timeStr}`;
            this.item.tooltip = `Antigravity AutoRetry is ACTIVE\nNext retry in ${timeStr}\nClick to open dashboard`;
            this.item.backgroundColor = undefined;
            this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        } else {
            this.item.text = `$(sync) AutoRetry: OFF`;
            this.item.tooltip = `Antigravity AutoRetry is INACTIVE\nClick to open dashboard`;
            this.item.backgroundColor = undefined;
            this.item.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
        }
    }

    setError() {
        this.item.text = `$(error) AutoRetry: ERR`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    dispose() {
        this.item.dispose();
    }
}
