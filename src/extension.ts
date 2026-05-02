import * as vscode from "vscode";
import { GeminiChatViewProvider } from "./views/chatView";
import { GeminiTerminalPanel } from "./views/terminalPanel";
import { GeminiBrowserPanel } from "./views/browserPanel";

const activeTerminalSessions = new Set<GeminiTerminalPanel>();
const activeBrowserSessions = new Set<GeminiBrowserPanel>();

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
      activeTerminalSessions.add(panel);
      panel.onDidDispose(() => activeTerminalSessions.delete(panel));
    }),
    vscode.commands.registerCommand("gemini.browser.open", () => {
      const panel = new GeminiBrowserPanel(context.extensionUri);
      activeBrowserSessions.add(panel);
      panel.onDidDispose(() => activeBrowserSessions.delete(panel));
    }),
    vscode.window.registerWebviewPanelSerializer("geminiTerminal", {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        const panel = new GeminiTerminalPanel(context.extensionUri, webviewPanel);
        activeTerminalSessions.add(panel);
        panel.onDidDispose(() => activeTerminalSessions.delete(panel));
      }
    }),
    vscode.window.registerWebviewPanelSerializer("geminiBrowser", {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        const panel = new GeminiBrowserPanel(context.extensionUri, webviewPanel);
        activeBrowserSessions.add(panel);
        panel.onDidDispose(() => activeBrowserSessions.delete(panel));
      }
    }),
    {
      dispose: () => {
        for (const session of activeTerminalSessions) {
          session.dispose();
        }
        activeTerminalSessions.clear();
        for (const session of activeBrowserSessions) {
          session.dispose();
        }
        activeBrowserSessions.clear();
      }
    }
  );
}

export function deactivate() {
  for (const session of activeTerminalSessions) {
    session.dispose();
  }
  activeTerminalSessions.clear();
  for (const session of activeBrowserSessions) {
    session.dispose();
  }
  activeBrowserSessions.clear();
}
