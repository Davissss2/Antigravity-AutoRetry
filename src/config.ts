import * as vscode from 'vscode';

export class Config {
    private static get cfg() { return vscode.workspace.getConfiguration('autoretry'); }

    static isEnabled():          boolean { return this.cfg.get<boolean>('enabled', true); }
    static getIntervalSeconds(): number  { return this.cfg.get<number>('intervalSeconds', 5); }
    static getCustomCommand():   string  { return this.cfg.get<string>('customCommand', ''); }
    static areNotificationsEnabled(): boolean { return this.cfg.get<boolean>('notificationsEnabled', true); }

    static async setIntervalSeconds(v: number) {
        await this.cfg.update('intervalSeconds', v, vscode.ConfigurationTarget.Global);
    }
    static async setEnabled(v: boolean) {
        await this.cfg.update('enabled', v, vscode.ConfigurationTarget.Global);
    }
}
