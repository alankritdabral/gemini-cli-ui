import * as vscode from "vscode";
import { GeminiTerminalSession } from "../terminal/session";

export class GeminiChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private terminalSession?: GeminiTerminalSession;

  constructor(private readonly extensionUri: vscode.Uri) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "webview"),
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm")
      ]
    };

    this.terminalSession = new GeminiTerminalSession(
      this.extensionUri,
      webviewView.webview
    );

    webviewView.onDidDispose(() => {
      this.terminalSession?.dispose();
      this.terminalSession = undefined;
    });
  }
}
