import * as vscode from "vscode";
import { createCoreApi } from "./core-api.js";
import { dispatchCommand, vscodeCommands, type AidlcUi } from "./router.js";

export function activate(context: vscode.ExtensionContext): void {
  const api = createCoreApi();
  const channel = vscode.window.createOutputChannel("AIDLC");
  context.subscriptions.push(channel);
  const ui = createUi(channel);
  for (const command of vscodeCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command.id, async () => {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const config = vscode.workspace.getConfiguration("aidlc");
        await dispatchCommand(command.id, api, ui, folder, {
          yes: config.get<boolean>("yes") ?? false,
          dryRun: config.get<boolean>("dryRun") ?? false,
        });
      }),
    );
  }
}

export function deactivate(): void {
  // The output channel is disposed with the extension context.
}

function createUi(channel: vscode.OutputChannel): AidlcUi {
  return {
    output(line) {
      channel.appendLine(line);
    },
    info(message) {
      void vscode.window.showInformationMessage(message);
    },
    error(message) {
      channel.appendLine(message);
      void vscode.window.showErrorMessage(message);
    },
    async input(prompt) {
      return vscode.window.showInputBox({ prompt, ignoreFocusOut: true });
    },
    async confirm(prompt) {
      const choice = await vscode.window.showInformationMessage(prompt, { modal: true }, "Continue");
      return choice === "Continue";
    },
    async progress(title, work) {
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return work((message) => progress.report({ message }), controller.signal);
      });
    },
  };
}
