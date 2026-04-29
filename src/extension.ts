import * as vscode from "vscode";
import { GeminiChatViewProvider } from "./views/chatView";
import { GeminiTerminalPanel } from "./views/terminalPanel";

const activeSessions = new Set<GeminiTerminalPanel>();

export function activate(context: vscode.ExtensionContext) {
  const chatProvider = new GeminiChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("gemini.chatView", chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand("geminiTerminal.open", () => {
      const panel = new GeminiTerminalPanel(context.extensionUri);
      activeSessions.add(panel);
      panel.onDidDispose(() => activeSessions.delete(panel));
    }),
    vscode.window.registerWebviewPanelSerializer("geminiTerminal", {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        const panel = new GeminiTerminalPanel(context.extensionUri, webviewPanel);
        activeSessions.add(panel);
        panel.onDidDispose(() => activeSessions.delete(panel));
      }
    }),
    {
      dispose: () => {
        for (const session of activeSessions) {
          session.dispose();
        }
        activeSessions.clear();
      }
    }
  );
}

export function deactivate() {
  for (const session of activeSessions) {
    session.dispose();
  }
  activeSessions.clear();
}
