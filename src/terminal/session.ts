import * as cp from "node:child_process";
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
import { GeminiBrowserPanel } from "../views/browserPanel";

export class GeminiTerminalSession {

  private static readonly activeSessions = new Set<GeminiTerminalSession>();
  private readonly disposables: vscode.Disposable[] = [];
  private terminalProcess: NodePty.IPty | undefined;
  private inputBuffer: string[] = [];
  private isStarting = false;
  private startupTimeout: NodeJS.Timeout | undefined;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;
  private isDisposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly webview: vscode.Webview
  ) {
    this.webview.html = this.getHtml();
    GeminiTerminalSession.activeSessions.add(this);

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
    GeminiTerminalSession.activeSessions.delete(this);
    this.killTerminalProcess();

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  public static sendToActiveSessions(data: string) {
    for (const session of this.activeSessions) {
      session.terminalProcess?.write(data);
    }
  }

  private handleWebviewMessage(message: WebviewToExtensionMessage) {
    switch (message.type) {
      case "ready":
        this.startTerminalProcess();
        break;
      case "input":
        if (this.terminalProcess) {
          this.terminalProcess.write(message.data);
        } else if (this.isStarting) {
          this.inputBuffer.push(message.data);
        }
        break;
      case "resize":
        this.resizeTerminal(message.cols, message.rows);
        break;
      case "restart":
        this.restartTerminalProcess(true);
        break;
      case "newChat":
        this.restartTerminalProcess(false);
        break;
      case "listSessions":
        void this.showSessionPicker();
        break;
      case "resumeSession":
        this.restartTerminalProcess(message.id);
        break;
      case "browser_switch":
        void vscode.commands.executeCommand("gemini.browser.open");
        break;
    }
  }

  private async showSessionPicker() {
    const options = this.getPtyOptions();
    
    // Run gemini --list-sessions
    const command = process.platform === "win32" ? "gemini --list-sessions" : "bash -lc 'gemini --list-sessions'";
    
    cp.exec(command, { cwd: options.cwd, env: options.env }, async (error, stdout) => {
      if (error) {
        // Try npx fallback
        const npxCommand = process.platform === "win32" ? "npx -y @google/gemini-cli --list-sessions" : "bash -lc 'npx -y @google/gemini-cli --list-sessions'";
        cp.exec(npxCommand, { cwd: options.cwd, env: options.env }, async (npxError, npxStdout) => {
          if (npxError) {
            void vscode.window.showErrorMessage(`Failed to list sessions: ${formatError(npxError)}`);
            return;
          }
          this.processSessionList(npxStdout);
        });
        return;
      }
      this.processSessionList(stdout);
    });
  }

  private processSessionList(output: string) {
    // Parse: 1. Summary (Date) [UUID]
    const lines = output.split("\n");
    const sessions: { label: string; description: string; id: string }[] = [];
    
    // Improved regex to be more forgiving with whitespace and formatting
    const regex = /^\s*\d+\.\s+(.*?)\s+\((.*?)\)\s+\[([a-fA-F0-9-]+)\]\s*$/;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }
      
      const match = trimmedLine.match(regex);
      if (match) {
        sessions.push({
          label: match[1].trim(),
          description: match[2].trim(),
          id: match[3].trim()
        });
      }
    }

    // Always send the list (even if empty) to update the webview state
    void this.webview.postMessage({ type: "sessionsList", sessions });
  }

  private startTerminalProcess(resume: boolean | string = true) {
    if (this.isDisposed) {
      return;
    }

    this.killTerminalProcess();
    
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
    }
    
    this.isStarting = true;
    this.inputBuffer = [];

    // Safety timeout: if process doesn't start in 10s, stop buffering
    this.startupTimeout = setTimeout(() => {
      this.isStarting = false;
      this.startupTimeout = undefined;
    }, 10000);

    void this.webview.postMessage({ type: "clear" });

    const options = this.getPtyOptions();
    const command = getShellLaunchCommand(resume);

    try {
      const nodePty = loadNodePty();
      const ptyProcess = nodePty.spawn(command.file, command.args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env
      });
      this.terminalProcess = ptyProcess;

      ptyProcess.onData((data) => {
        if (this.terminalProcess === ptyProcess) {
          void this.webview.postMessage({ type: "output", data });
          this.handleTerminalData(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (this.terminalProcess === ptyProcess) {
          this.terminalProcess = undefined;
          this.isStarting = false;
          void this.webview.postMessage({
            type: "exit",
            exitCode,
            signal
          });
        }
      });

      // Flush buffered input once the process has started
      if (this.inputBuffer.length > 0) {
        const bufferedInput = this.inputBuffer.join("");
        this.inputBuffer = [];
        ptyProcess.write(bufferedInput);
      }
      
      this.isStarting = false;
      if (this.startupTimeout) {
        clearTimeout(this.startupTimeout);
        this.startupTimeout = undefined;
      }
    } catch (error) {
      this.isStarting = false;
      const message = `Failed to start Gemini CLI: ${formatError(error)}`;
      void vscode.window.showErrorMessage(message);
      void this.webview.postMessage({
        type: "output",
        data: `\r\n\x1b[31m${message}\x1b[0m\r\n`
      });
      return;
    }
  }

  private restartTerminalProcess(resume: boolean | string = true) {
    this.startTerminalProcess(resume);
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
      ).toString(),
      "{{platform}}": process.platform
    };

    let html = fs.readFileSync(templatePath, "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      html = html.replaceAll(token, value);
    }

    return html;
  }

  private handleTerminalData(data: string) {
    // Basic regex to detect browser commands in the stream
    // Pattern: <<BROWSER_COMMAND:ARGS>>
    const navigateMatch = data.match(/<<BROWSER_NAVIGATE:(.*?)>>/);
    if (navigateMatch) {
      const url = navigateMatch[1].trim();
      void vscode.commands.executeCommand("gemini.browser.navigate", url);
      
      // Notify the user via a less intrusive message if browser isn't open
      if (!GeminiBrowserPanel.currentPanel) {
         void vscode.window.showInformationMessage(`Gemini suggested navigating to ${url}. Click "Browser" to see it.`);
      }
    }
  }
}
