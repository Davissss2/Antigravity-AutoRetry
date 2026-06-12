import * as vscode from 'vscode';
import { AutoRetryController } from './autoRetryController';
import { StatusBarManager } from './statusBar';
import { Logger } from './logger';
import { Config } from './config';

let controller: AutoRetryController | undefined;
let statusBar: StatusBarManager | undefined;
let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext) {
    logger   = new Logger();
    statusBar = new StatusBarManager();
    controller = new AutoRetryController(logger, statusBar);

    logger.log('🚀 Antigravity AutoRetry activated');

    context.subscriptions.push(

        vscode.commands.registerCommand('autoretry.toggle', () => {
            controller!.toggle();
        }),

        vscode.commands.registerCommand('autoretry.enable', () => {
            controller!.start();
            vscode.window.showInformationMessage('✅ AutoRetry enabled');
        }),

        vscode.commands.registerCommand('autoretry.disable', () => {
            controller!.stop();
            vscode.window.showInformationMessage('⏹ AutoRetry disabled');
        }),

        vscode.commands.registerCommand('autoretry.retryNow', () => {
            controller!.retryNow();
        }),

        vscode.commands.registerCommand('autoretry.showLog', () => {
            logger!.show();
        }),

        vscode.commands.registerCommand('autoretry.clearLog', () => {
            logger!.clear();
        }),

        vscode.commands.registerCommand('autoretry.openSettings', () => {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:Davissss2.antigravity-autoretry'
            );
        }),

        vscode.commands.registerCommand('autoretry.setInterval', async () => {
            const val = await vscode.window.showInputBox({
                title: 'AutoRetry – Set Interval',
                prompt: 'Seconds between automatic retries (min 3)',
                value: String(Config.getIntervalSeconds()),
                validateInput: (v: string) => {
                    const n = parseInt(v, 10);
                    if (isNaN(n) || n < 3)   { return 'Minimum 3 seconds'; }
                    if (n > 3600)             { return 'Maximum 3600 seconds'; }
                    return null;
                }
            });
            if (val) {
                await Config.setIntervalSeconds(parseInt(val, 10));
                controller!.restart();
                vscode.window.showInformationMessage(
                    `⏱ AutoRetry interval: ${val}s`
                );
            }
        }),

        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            if (e.affectsConfiguration('autoretry')) {
                controller!.onConfigChanged();
            }
        })
    );

    if (Config.isEnabled()) {
        controller.start();
    }

    logger.log('✅ Ready — interval: ' + Config.getIntervalSeconds() + 's');
}

export function deactivate() {
    controller?.stop();
    statusBar?.dispose();
    logger?.dispose();
}
