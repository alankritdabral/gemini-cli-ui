import * as vscode from "vscode";
import { GeminiChatViewProvider } from "./views/chatView";
import { GeminiBrowserPanel } from "./views/browserPanel";

export function activate(context: vscode.ExtensionContext) {
  const chatProvider = new GeminiChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("gemini.chatView", chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand("geminiTerminal.open", () => {
      void vscode.commands.executeCommand("gemini.chatView.focus");
    }),
    vscode.commands.registerCommand("gemini.browser.open", () => {
      GeminiBrowserPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand("gemini.browser.navigate", (url: string) => {
      GeminiBrowserPanel.createOrShow(context);
      GeminiBrowserPanel.currentPanel?.navigate(url);
    }),
    vscode.window.registerWebviewPanelSerializer("geminiBrowser", {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        const panel = new GeminiBrowserPanel(context, webviewPanel);
        GeminiBrowserPanel.currentPanel = panel;
      }
    })
  );
}

export function deactivate() {
}
