import * as vscode from "vscode";
import { GeminiTerminalSession } from "../terminal/session";

export class GeminiTerminalPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly session: GeminiTerminalSession;
  private readonly disposeEmitter = new vscode.EventEmitter<void>();

  readonly onDidDispose = this.disposeEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "geminiTerminal",
      "Gemini CLI UI",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview"),
          vscode.Uri.joinPath(extensionUri, "node_modules", "@xterm")
        ]
      }
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "gemini-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "gemini-dark.svg")
    };

    this.session = new GeminiTerminalSession(this.extensionUri, this.panel.webview);

    this.panel.onDidDispose(() => {
      this.session.dispose();
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
    });
  }

  dispose() {
    this.panel.dispose();
  }
}
