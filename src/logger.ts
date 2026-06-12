import * as vscode from 'vscode';

export class Logger {
    private channel: vscode.OutputChannel;
    private entries: string[] = [];

    constructor() {
        this.channel = vscode.window.createOutputChannel('Antigravity AutoRetry', 'log');
    }

    log(message: string) {
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] ${message}`;
        this.entries.push(entry);
        this.channel.appendLine(entry);
    }

    show() {
        this.channel.show();
    }

    clear() {
        this.entries = [];
        this.channel.clear();
        this.log('Log cleared');
    }

    getEntries(): string[] {
        return [...this.entries];
    }

    dispose() {
        this.channel.dispose();
    }
}
