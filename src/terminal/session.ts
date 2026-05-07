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
  private readonly injectedFiles = new Set<string>();
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
        void this.initializeSession();
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
        // 1. Immediately clear the webview UI to feel "instant"
        void this.webview.postMessage({ type: "clear" });
        
        if (this.terminalProcess) {
          // 2. Kill the old process
          this.killTerminalProcess();
          this.startTerminalProcess(message.id);
        } else {
          this.startTerminalProcess(message.id);
        }
        break;
      case "addFile":
        void this.handleAddFile();
        break;
      case "browser_switch":
        void vscode.commands.executeCommand("gemini.browser.open");
        break;
      case "fetchQuota":
        void this.fetchQuota();
        break;
    }
  }

  private async handleAddFile() {
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Add to Gemini Chat"
    });

    if (files && files.length > 0) {
      this.injectFiles(files.map(f => ({ path: f.fsPath, name: path.basename(f.fsPath) })));
    }
  }

  private async fetchQuota() {
    let accessToken: string | undefined;
    let projectId = "tool";

    try {
      const geminiHome = process.env["GEMINI_CLI_HOME"] || path.join(os.homedir(), ".gemini");
      const credsReq = path.join(geminiHome, "oauth_creds.json");
      const projectsReq = path.join(geminiHome, "projects.json");

      if (!fs.existsSync(credsReq)) {
        void this.webview.postMessage({ type: "output", data: `\r\n\x1b[33mQuota unavailable: No credentials found. Run 'gemini login' in terminal.\x1b[0m\r\n` });
        return;
      }

      const creds = JSON.parse(fs.readFileSync(credsReq, "utf8"));
      accessToken = creds.access_token;
      if (!accessToken) {
        void this.webview.postMessage({ type: "output", data: `\r\n\x1b[33mQuota unavailable: Access token missing. Run 'gemini login' again.\x1b[0m\r\n` });
        return;
      }

      if (fs.existsSync(projectsReq)) {
        try {
          const projectsData = JSON.parse(fs.readFileSync(projectsReq, "utf8"));
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceFolder && projectsData.projects?.[workspaceFolder]) {
            projectId = projectsData.projects[workspaceFolder];
          }
        } catch (e) { /* ignore */ }
      }

      // Try direct fetch with a short timeout (3s)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      try {
        const response = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ project: projectId }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json() as any;
          void this.webview.postMessage({ type: "quotaUpdate", buckets: data.buckets });
          return;
        }
      } catch (e) {
        clearTimeout(timeoutId);
        // Fall through to shell fallback
      }

      // If direct fetch fails or times out, use shell fallback
      void this.fetchQuotaViaShell(accessToken, projectId);
    } catch (error) {
      void this.webview.postMessage({ type: "output", data: `\r\n\x1b[31mQuota fetch error: ${formatError(error)}\x1b[0m\r\n` });
    }
  }

  private async fetchQuotaViaShell(token: string, projectId: string) {
    const isWindows = process.platform === "win32";
    const url = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
    const payload = JSON.stringify({ project: projectId });
    const ptyOptions = this.getPtyOptions();

    // Strategy 1: Fast shell (uses the environment we already have for the PTY)
    // We add -4 to curl to avoid IPv6 resolution delays
    const fastCommand = isWindows
      ? `powershell.exe -NoProfile -Command "Invoke-RestMethod -Uri '${url}' -Method Post -Headers @{ Authorization = 'Bearer ${token}'; 'Content-Type' = 'application/json' } -Body '${payload.replace(/'/g, "''")}' | ConvertTo-Json -Compress"`
      : `curl -s -4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '${payload}' ${url}`;

    cp.exec(fastCommand, { env: ptyOptions.env, cwd: ptyOptions.cwd }, (error, stdout) => {
      if (!error) {
        try {
          const data = JSON.parse(stdout);
          if (data.buckets) {
            void this.webview.postMessage({ type: "quotaUpdate", buckets: data.buckets });
            return;
          }
        } catch (e) { /* ignore and try slow fallback */ }
      }

      // Strategy 2: Slow fallback (login shell) - only if fast shell fails
      if (!isWindows) {
        const slowCommand = `bash -lc "curl -s -4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '${payload}' ${url}"`;
        cp.exec(slowCommand, (slowError, slowStdout, slowStderr) => {
          if (slowError) {
            void this.webview.postMessage({ 
              type: "output", 
              data: `\r\n\x1b[31mQuota fetch failed.\r\n\x1b[33mError: ${slowStderr || slowError.message}\x1b[0m\r\n` 
            });
            return;
          }
          try {
            const data = JSON.parse(slowStdout);
            void this.webview.postMessage({ type: "quotaUpdate", buckets: data.buckets });
          } catch (e) {
            void this.webview.postMessage({ type: "output", data: `\r\n\x1b[31mQuota response invalid\x1b[0m\r\n` });
          }
        });
      }
    });
  }

  private injectFiles(files: { path: string; name: string }[]) {
    if (!this.terminalProcess || files.length === 0) {
      return;
    }

    // Deduplicate within the current selection and against already injected files
    const uniqueFiles = files.filter((file, index, self) => {
      const isFirstInSelection = self.findIndex(f => f.path === file.path) === index;
      const hasNotBeenInjected = !this.injectedFiles.has(file.path);
      return isFirstInSelection && hasNotBeenInjected;
    });

    if (uniqueFiles.length === 0) {
      void vscode.window.showInformationMessage("Selected file(s) are already in the chat context.");
      return;
    }

    const fileList = uniqueFiles.map(f => f.name).join(", ");
    void vscode.window.showInformationMessage(`Adding files: ${fileList}`);

    for (const file of uniqueFiles) {
      // Format: [File Attached: /path/to/file] [filename]
      // Adding \n at the end to "submit" it to the terminal buffer
      const data = `\x1b[200~[File Attached: ${file.path}] [${file.name}]\x1b[201~\n`;
      this.terminalProcess?.write(data);
      this.injectedFiles.add(file.path);
    }
    
    // Ensure the webview regains focus after injection
    void this.webview.postMessage({ type: "focus" });
    void vscode.window.showInformationMessage(`Injected ${uniqueFiles.length} new file(s) into Gemini CLI.`);
  }

  private async initializeSession() {
    // 1. Show history list
    void this.showSessionPicker();
    
    // 2. Start a NEW session in background
    // We pass false to getShellLaunchCommand to start a fresh session
    this.startTerminalProcess(false);

    // 3. Pre-fetch quota so it's ready when user clicks Models
    void this.fetchQuota();
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return "just now";
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    if (diffInSeconds < 172800) return "yesterday";
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
    
    return date.toLocaleDateString();
  }

  private async showSessionPicker(query?: string) {
    try {
      const geminiHome = process.env["GEMINI_CLI_HOME"] || path.join(os.homedir(), ".gemini");
      const projectsFile = path.join(geminiHome, "projects.json");
      
      // 1. Determine Project ID
      let projectId = "tool"; // Default fallback
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      
      if (fs.existsSync(projectsFile) && workspaceFolder) {
        try {
          const projectsData = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
          const normalizedWorkspace = path.normalize(workspaceFolder);
          
          if (projectsData.projects?.[normalizedWorkspace]) {
            projectId = projectsData.projects[normalizedWorkspace];
          } else {
            const sortedPaths = Object.keys(projectsData.projects).sort((a, b) => b.length - a.length);
            for (const pPath of sortedPaths) {
              const normalizedPPath = path.normalize(pPath);
              if (normalizedWorkspace === normalizedPPath || normalizedWorkspace.startsWith(normalizedPPath + path.sep)) {
                projectId = projectsData.projects[pPath];
                break;
              }
            }
          }
        } catch (e) { 
           // ignore
        }
      }

      const chatsDir = path.join(geminiHome, "tmp", projectId, "chats");

      if (!fs.existsSync(chatsDir)) {
        void this.webview.postMessage({ type: "sessionsList", sessions: [] });
        return;
      }

      // 2. Find all .json and .jsonl files recursively
      const getAllChatFiles = (dir: string): string[] => {
        let results: string[] = [];
        try {
          const list = fs.readdirSync(dir);
          for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat && stat.isDirectory()) {
              results = results.concat(getAllChatFiles(filePath));
            } else if (file.endsWith(".jsonl") || file.endsWith(".json")) {
              results.push(filePath);
            }
          }
        } catch (e) {}
        return results;
      };

      const files = getAllChatFiles(chatsDir);
      
      const sessionsMap = new Map<string, { label: string; description: string; id: string; mtime: number }>();

      for (const filePath of files) {
        try {
          const content = fs.readFileSync(filePath, "utf8");
          let sessionId: string | undefined;
          let startTime: string | undefined;
          let kind: string | undefined;
          let label = "New Session";
          let fullSearchText = content.toLowerCase();

          const extractLabel = (item: any) => {
            if (!item) return null;
            if (typeof item === "string") return item;
            if (Array.isArray(item)) {
              return item.map(p => p.text || "").join("").trim();
            }
            if (item.text) return item.text;
            return null;
          };

          let lastActivityTime: number = 0;

          if (filePath.endsWith(".jsonl")) {
            const lines = content.split("\n").filter(l => l.trim().length > 0);
            let summaryField: string | undefined;
            let firstUserText: string | undefined;

            for (const line of lines) {
              const trimmedLine = line.trim();
              try {
                const entry = JSON.parse(trimmedLine);
                if (entry.sessionId) {
                  sessionId = entry.sessionId;
                  startTime = entry.startTime;
                  kind = entry.kind;
                  if (entry.summary) summaryField = entry.summary;
                  if (entry.lastUpdated) {
                    const t = new Date(entry.lastUpdated).getTime();
                    if (t > lastActivityTime) lastActivityTime = t;
                  }
                }
                
                if (entry.timestamp) {
                  const t = new Date(entry.timestamp).getTime();
                  if (t > lastActivityTime) lastActivityTime = t;
                }

                if (entry.type === "user" && !firstUserText) {
                  firstUserText = extractLabel(entry.content);
                }
              } catch (e) {}
            }
            label = summaryField || firstUserText || "New Session";
          } else {
            // Standard JSON
            try {
              const data = JSON.parse(content);
              sessionId = data.sessionId;
              startTime = data.startTime;
              kind = data.kind || "main";
              
              if (data.lastUpdated) {
                lastActivityTime = new Date(data.lastUpdated).getTime();
              }
              
              // Also check last message timestamp
              if (data.messages && data.messages.length > 0) {
                const lastMsg = data.messages[data.messages.length - 1];
                if (lastMsg.timestamp) {
                  const t = new Date(lastMsg.timestamp).getTime();
                  if (t > lastActivityTime) lastActivityTime = t;
                }
              }

              const summaryField = data.summary;
              const firstUserMsg = data.messages?.find((m: any) => m.type === "user");
              const firstUserText = firstUserMsg ? extractLabel(firstUserMsg.content) : undefined;
              
              label = summaryField || firstUserText || "New Session";
            } catch (e) {}
          }

          if (label && label.length > 80) label = label.substring(0, 77) + "...";

          if (!sessionId || kind === "subagent") continue;

          if (query && !fullSearchText.includes(query.toLowerCase())) {
            continue;
          }

          // Fallback to filesystem mtime if no internal timestamps found
          if (lastActivityTime === 0) {
            lastActivityTime = fs.statSync(filePath).mtime.getTime();
          }

          // De-duplicate: only keep the version with the newest activity
          const existing = sessionsMap.get(sessionId);
          if (!existing || lastActivityTime > existing.mtime) {
            sessionsMap.set(sessionId, {
              label,
              description: this.formatTime(new Date(lastActivityTime)),
              id: sessionId,
              mtime: lastActivityTime
            });
          }
        } catch (e) { /* skip */ }
      }

      const sessions = Array.from(sessionsMap.values());
      // Sort by newest first
      sessions.sort((a, b) => b.mtime - a.mtime);

      void this.webview.postMessage({ type: "sessionsList", sessions });

    } catch (error) {
      void this.webview.postMessage({ type: "sessionsList", sessions: [] });
    }
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
    this.injectedFiles.clear();
    
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
      
      // Auto-enable mouse mode if configured
      if (vscode.workspace.getConfiguration("gemini.terminal").get("enableMouseMode")) {
        if (this.terminalProcess === ptyProcess) {
          this.terminalProcess.write("\x13"); // Send Ctrl+S
        }
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
    // Browser navigation detection removed per user request
  }
}
