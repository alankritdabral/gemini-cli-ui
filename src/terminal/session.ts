import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as NodePty from "node-pty";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  PtySessionOptions,
  WebviewToExtensionMessage
} from "../types";
import { formatError, getNonce } from "../utils";
import { getShellLaunchCommand, getTerminalEnvironment, loadNodePty } from "./pty";

export class GeminiTerminalSession {
  private readonly disposables: vscode.Disposable[] = [];
  private terminalProcess: NodePty.IPty | undefined;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;
  private isDisposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly webview: vscode.Webview
  ) {
    this.webview.html = this.getHtml();

    this.disposables.push(
      this.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        this.handleWebviewMessage(message);
      })
    );
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.killTerminalProcess();

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private handleWebviewMessage(message: WebviewToExtensionMessage) {
    switch (message.type) {
      case "ready":
        this.startTerminalProcess();
        break;
      case "input":
        this.terminalProcess?.write(message.data);
        break;
      case "resize":
        this.resizeTerminal(message.cols, message.rows);
        break;
      case "restart":
        this.restartTerminalProcess();
        break;
    }
  }

  private startTerminalProcess() {
    if (this.terminalProcess || this.isDisposed) {
      return;
    }

    const options = this.getPtyOptions();
    const command = getShellLaunchCommand();

    try {
      const nodePty = loadNodePty();
      this.terminalProcess = nodePty.spawn(command.file, command.args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env
      });
    } catch (error) {
      const message = `Failed to start Gemini CLI: ${formatError(error)}`;
      void vscode.window.showErrorMessage(message);
      void this.webview.postMessage({
        type: "output",
        data: `\r\n\x1b[31m${message}\x1b[0m\r\n`
      });
      return;
    }

    this.terminalProcess.onData((data) => {
      void this.webview.postMessage({ type: "output", data });
    });

    this.terminalProcess.onExit(({ exitCode, signal }) => {
      this.terminalProcess = undefined;
      void this.webview.postMessage({
        type: "exit",
        exitCode,
        signal
      });
    });
  }

  private restartTerminalProcess() {
    this.killTerminalProcess();
    void this.webview.postMessage({ type: "clear" });
    this.startTerminalProcess();
  }

  private killTerminalProcess() {
    if (!this.terminalProcess) {
      return;
    }

    const terminalProcess = this.terminalProcess;
    this.terminalProcess = undefined;

    try {
      terminalProcess.kill();
    } catch {
      // Process may already be gone; disposal should remain best effort.
    }
  }

  private resizeTerminal(cols: number, rows: number) {
    const normalizedCols = Math.max(2, Math.floor(cols));
    const normalizedRows = Math.max(1, Math.floor(rows));

    if (normalizedCols === this.cols && normalizedRows === this.rows) {
      return;
    }

    this.cols = normalizedCols;
    this.rows = normalizedRows;

    try {
      this.terminalProcess?.resize(this.cols, this.rows);
    } catch {
      // Some PTY backends throw if resizing races with process exit.
    }
  }

  private getPtyOptions(): PtySessionOptions {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return {
      cwd: workspaceFolder ?? os.homedir(),
      env: getTerminalEnvironment(process.env),
      cols: this.cols,
      rows: this.rows
    };
  }

  private getHtml(): string {
    const webview = this.webview;
    const templatePath = path.join(this.extensionUri.fsPath, "webview", "index.html");
    const nonce = getNonce();

    const replacements: Record<string, string> = {
      "{{cspSource}}": webview.cspSource,
      "{{nonce}}": nonce,
      "{{xtermCssUri}}": webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm", "xterm", "css", "xterm.css")
      ).toString(),
      "{{stylesUri}}": webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "webview", "styles.css")
      ).toString(),
      "{{xtermJsUri}}": webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm", "xterm", "lib", "xterm.js")
      ).toString(),
      "{{fitAddonJsUri}}": webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")
      ).toString(),
      "{{webLinksAddonJsUri}}": webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.js")
      ).toString(),
      "{{mainJsUri}}": webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "webview", "main.js")
      ).toString()
    };

    let html = fs.readFileSync(templatePath, "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      html = html.replaceAll(token, value);
    }

    return html;
  }
}
