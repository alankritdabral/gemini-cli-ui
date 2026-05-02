import * as vscode from "vscode";
import * as http from "node:http";
import * as https from "node:https";
import { WebviewToExtensionMessage, ExtensionToBrowserMessage } from "../types";
import { GeminiTerminalSession } from "../terminal/session";

export class GeminiBrowserPanel {
  private readonly panel: vscode.WebviewPanel;
  private currentUrl: string = "http://localhost:3000";
  private proxyServer?: http.Server;
  private proxyPort?: number;
  private selectionCounters: Record<string, number> = {};
  private readonly disposeEmitter = new vscode.EventEmitter<void>();

  readonly onDidDispose = this.disposeEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri, panel?: vscode.WebviewPanel) {
    if (panel) {
      this.panel = panel;
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "geminiBrowser",
        "Gemini Browser",
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(extensionUri, "webview")
          ]
        }
      );
    }

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "gemini-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "gemini-dark.svg")
    };

    this.startProxy().then(() => {
      this.updateHtml();
    });

    this.panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      switch (message.type) {
        case "browser_navigate":
          this.navigate(message.url);
          break;
        case "browser_inspect_mode":
          this.broadcastToIframe({ type: 'inspect_mode', enabled: message.enabled });
          break;
        case "browser_element_selected":
          this.handleElementSelected(message.context, message.url);
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.proxyServer?.close();
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
    });
  }

  private navigate(url: string) {
    let normalized = url.trim();
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      normalized = "http://" + normalized;
    }
    this.currentUrl = normalized;
    this.panel.webview.postMessage({ type: 'browser_load', url: normalized });
  }

  private async startProxy() {
    this.proxyServer = http.createServer((req, res) => {
      if (!this.currentUrl) {
        res.writeHead(404);
        res.end("No URL specified");
        return;
      }

      if (req.url === "/__gemini_inspector.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(this.getInspectorScript());
        return;
      }

      try {
        const targetUrl = new URL(this.currentUrl);
        const protocol = targetUrl.protocol === "https:" ? https : http;
        
        const requestUrl = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
        const requestPath = requestUrl.pathname + requestUrl.search;

        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
          path: requestPath,
          method: req.method,
          headers: { ...req.headers, host: targetUrl.host, "accept-encoding": "identity" }
        };

        delete options.headers["content-length"];
        delete options.headers["connection"];

        const proxyReq = protocol.request(options, (proxyRes) => {
          const contentType = proxyRes.headers["content-type"] || "";
          const headers = { ...proxyRes.headers };
          delete headers["content-length"];
          delete headers["content-security-policy"]; 

          if (contentType.includes("text/html")) {
            let chunks: Buffer[] = [];
            proxyRes.on("data", (chunk) => { chunks.push(chunk); });
            proxyRes.on("end", () => {
              let body = Buffer.concat(chunks).toString();
              const injection = '<script src="/__gemini_inspector.js"></script>';
              body = body.includes("</body>") ? body.replace("</body>", injection + "</body>") : body + injection;
              res.writeHead(proxyRes.statusCode || 200, headers);
              res.end(body);
            });
          } else {
            res.writeHead(proxyRes.statusCode || 200, headers);
            proxyRes.pipe(res, { end: true });
          }
        });

        proxyReq.on("error", (err) => {
          res.writeHead(500);
          res.end("Proxy Error: " + err.message);
        });

        req.pipe(proxyReq, { end: true });
      } catch (err: any) {
        res.writeHead(500);
        res.end("Invalid URL: " + err.message);
      }
    });

    return new Promise<void>((resolve) => {
      this.proxyServer?.listen(0, "127.0.0.1", () => {
        const address = this.proxyServer?.address() as any;
        this.proxyPort = address.port;
        resolve();
      });
    });
  }

  private getInspectorScript() {
    return `
      (function() {
        console.log('Gemini Inspector Injected');
        window.__GEMINI_INSPECT_MODE__ = false;
        let hoveredElement = null;
        let overlay = document.createElement('div');
        overlay.id = 'gemini-inspector-overlay';
        overlay.style.cssText = 'position:fixed; pointer-events:none; z-index:2147483647; border:2px solid #007acc; background:rgba(0,122,204,0.1); display:none; transition: all 0.05s ease;';
        document.body.appendChild(overlay);

        const notifyUrl = () => {
          window.parent.postMessage({ type: 'browser_url_changed', url: window.location.href }, '*');
        };
        notifyUrl();

        const originalPushState = history.pushState;
        history.pushState = function() {
          originalPushState.apply(this, arguments);
          notifyUrl();
        };
        window.addEventListener('popstate', notifyUrl);

        window.addEventListener('message', e => {
          if (e.data && e.data.type === 'inspect_mode') {
            window.__GEMINI_INSPECT_MODE__ = e.data.enabled;
            if (!e.data.enabled) overlay.style.display = 'none';
          }
        });

        document.addEventListener('mousemove', e => {
          if (!window.__GEMINI_INSPECT_MODE__) return;
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (el && el !== overlay && !overlay.contains(el)) {
            hoveredElement = el;
            const rect = el.getBoundingClientRect();
            overlay.style.top = rect.top + 'px';
            overlay.style.left = rect.left + 'px';
            overlay.style.width = rect.width + 'px';
            overlay.style.height = rect.height + 'px';
            overlay.style.display = 'block';
          }
        }, true);

        document.addEventListener('click', e => {
          if (!window.__GEMINI_INSPECT_MODE__) return;
          e.preventDefault(); e.stopPropagation();
          if (hoveredElement) {
            window.parent.postMessage({ 
              type: 'browser_element_selected', 
              context: hoveredElement.outerHTML,
              url: window.location.href
            }, '*');
            window.__GEMINI_INSPECT_MODE__ = false;
            overlay.style.display = 'none';
          }
        }, true);
      })();
    `;
  }

  private handleElementSelected(html: string, url?: string) {
    // 1. Identify the tag name
    const tagNameMatch = html.match(/^<([a-z0-9]+)/i);
    const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : 'element';
    
    // 2. Extract inner text for the label
    const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 30);
    const label = "[" + tagName + ": " + (textContent || '...') + "]";
    
    // 3. Handle URL mapping
    let displayUrl = url || "unknown";
    try {
      const u = new URL(displayUrl);
      if (u.port === this.proxyPort?.toString()) {
        const targetBase = new URL(this.currentUrl);
        u.protocol = targetBase.protocol;
        u.host = targetBase.host;
        displayUrl = u.href;
      }
    } catch (e) {}

    // 4. Send the label and use Bracketed Paste for the full context
    // This triggers the CLI's internal [Pasted text] feature
    GeminiTerminalSession.sendToActiveSessions("\n" + label + "\n");
    
    setTimeout(() => {
        const prompt = "\n[CONTEXT: Browser Selection]\n[URL: " + displayUrl + "]\n```html\n" + html + "\n```\n";
        // \x1b[200~ is start of bracketed paste, \x1b[201~ is end
        const bracketedPaste = "\x1b[200~" + prompt + "\x1b[201~";
        GeminiTerminalSession.sendToActiveSessions(bracketedPaste + "\n");
    }, 50);
    
    vscode.window.showInformationMessage("Captured element " + label + " and sent to Gemini Chat.");
    void vscode.commands.executeCommand("gemini.chatView.focus");
  }

  private broadcastToIframe(message: any) {
    this.panel.webview.postMessage({ type: 'forward_to_iframe', data: message });
  }

  private updateHtml() {
    this.panel.webview.html = this.getHtml();
  }

  private getHtml() {
    const proxyUrl = "http://127.0.0.1:" + this.proxyPort;
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gemini Browser</title>
        <style>
          body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
          .container { display: flex; flex-direction: column; width: 100%; height: 100%; }
          .toolbar { display: flex; align-items: center; padding: 4px 8px; background: var(--vscode-breadcrumb-background); border-bottom: 1px solid var(--vscode-panel-border); gap: 8px; }
          .toolbar input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 2px; outline: none; }
          .toolbar button { background: transparent; color: var(--vscode-foreground); border: none; cursor: pointer; padding: 4px; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
          .toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
          .toolbar button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
          .browser-content { flex: 1; border: none; background: white; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="toolbar">
            <button id="back" title="Back">◀</button>
            <button id="forward" title="Forward">▶</button>
            <button id="refresh" title="Refresh">↻</button>
            <input type="text" id="urlInput" value="${this.currentUrl}" placeholder="Enter any URL (e.g. google.com)">
            <button id="go">Go</button>
            <button id="inspect" title="Inspect Element">🔍</button>
          </div>
          <iframe id="browserFrame" class="browser-content" src="${proxyUrl}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          const frame = document.getElementById('browserFrame');
          const urlInput = document.getElementById('urlInput');
          const goBtn = document.getElementById('go');
          const refreshBtn = document.getElementById('refresh');
          const inspectBtn = document.getElementById('inspect');

          let isInspectMode = false;

          inspectBtn.onclick = () => {
            isInspectMode = !isInspectMode;
            inspectBtn.classList.toggle('active', isInspectMode);
            vscode.postMessage({ type: 'browser_inspect_mode', enabled: isInspectMode });
          };

          goBtn.onclick = () => {
            const url = urlInput.value;
            vscode.postMessage({ type: 'browser_navigate', url: url });
          };

          urlInput.onkeydown = (e) => { if (e.key === 'Enter') goBtn.onclick(); };
          refreshBtn.onclick = () => { frame.src = frame.src; };

          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'forward_to_iframe') {
              frame.contentWindow.postMessage(message.data, '*');
            } else if (message.type === 'browser_element_selected') {
              isInspectMode = false;
              inspectBtn.classList.remove('active');
              vscode.postMessage(message);
            } else if (message.type === 'browser_load') {
              frame.src = '${proxyUrl}/' + Math.random();
              urlInput.value = message.url;
            } else if (message.type === 'browser_url_changed') {
              try {
                const url = new URL(message.url);
                if (url.port === '${this.proxyPort}') {
                   const targetBase = new URL('${this.currentUrl}');
                   url.protocol = targetBase.protocol;
                   url.host = targetBase.host;
                }
                urlInput.value = url.href;
              } catch (e) {
                urlInput.value = message.url;
              }
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  dispose() {
    this.proxyServer?.close();
    this.panel.dispose();
  }
}
