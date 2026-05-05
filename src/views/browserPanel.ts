import * as vscode from "vscode";
import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns";
import * as net from "node:net";
import { WebviewToExtensionMessage, ExtensionToBrowserMessage } from "../types";
import { GeminiTerminalSession } from "../terminal/session";

const MAX_PROXY_REDIRECTS = 5;
const PROXY_DNS_TIMEOUT_MS = 5000;
const PROXY_REQUEST_TIMEOUT_MS = 8500;
const DNS_FALLBACK_DELAY_MS = 1000;
const DOH_FALLBACK_DELAY_MS = 1800;
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

type ProxyRequestState = {
  startedAt: number;
  phase: string;
  socketAssignedAt?: number;
  dnsStartedAt?: number;
  dnsFinishedAt?: number;
  tcpConnectedAt?: number;
  tlsConnectedAt?: number;
  responseStartedAt?: number;
  errorAt?: number;
  remoteAddress?: string;
  remoteFamily?: number;
  dnsProvider?: string;
  dnsAttempts?: string[];
};

class CookieManager {
  private cookies: Map<string, string> = new Map(); // domain -> cookie string

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = this.context.globalState.get<Record<string, string>>("gemini.browser.cookies");
    if (saved) {
      this.cookies = new Map(Object.entries(saved));
    }
  }

  public getCookies(url: URL): string {
    const domain = url.hostname;
    let cookieStr = "";
    for (const [key, value] of this.cookies.entries()) {
      if (domain.endsWith(key)) {
        cookieStr += (cookieStr ? "; " : "") + value;
      }
    }
    return cookieStr;
  }

  public setCookies(url: URL, setCookieHeaders: string[] | string | undefined) {
    if (!setCookieHeaders) return;
    const domain = url.hostname;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    
    let currentCookies = this.cookies.get(domain) || "";
    const cookieMap = new Map<string, string>();
    
    currentCookies.split(";").forEach(c => {
      const parts = c.trim().split("=");
      if (parts.length >= 2) {
        cookieMap.set(parts[0], parts.slice(1).join("="));
      }
    });

    headers.forEach(h => {
      const parts = h.split(";")[0].split("=");
      if (parts.length >= 2) {
        cookieMap.set(parts[0].trim(), parts.slice(1).join("=").trim());
      }
    });

    const newCookieStr = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    this.cookies.set(domain, newCookieStr);
    
    const toSave: Record<string, string> = {};
    for (const [k, v] of this.cookies.entries()) {
      toSave[k] = v;
    }
    this.context.globalState.update("gemini.browser.cookies", toSave);
  }
}

export class GeminiBrowserPanel {
  public static currentPanel: GeminiBrowserPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private currentUrl: string = "http://localhost:3000";
  private usePlaywright: boolean = false;
  private proxyServer?: http.Server;
  private proxyPort?: number;
  private selectionCounters: Record<string, number> = {};
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private cookieManager: CookieManager;

  readonly onDidDispose = this.disposeEmitter.event;

  public static createOrShow(context: vscode.ExtensionContext) {
    const extensionUri = context.extensionUri;
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (GeminiBrowserPanel.currentPanel) {
      GeminiBrowserPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "geminiBrowser",
      "Gemini Browser",
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview")
        ]
      }
    );

    GeminiBrowserPanel.currentPanel = new GeminiBrowserPanel(context, panel);
  }

  constructor(private readonly context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.extensionUri = context.extensionUri;
    this.cookieManager = new CookieManager(context);

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "gemini-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "gemini-light.svg")
    };

    this.startProxy()
      .then(() => {
        this.updateHtml();
      })
      .catch((error) => {
        void vscode.window.showErrorMessage(`Failed to start Gemini browser proxy: ${this.formatError(error)}`);
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
        case "browser_toggle_playwright":
          this.usePlaywright = message.enabled;
          if (this.usePlaywright) {
            void vscode.window.showInformationMessage("Playwright mode is experimental and currently only scaffolds the toggle.");
          }
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.dispose();
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
    });
  }

  /**
   * Navigate to a URL. If the browser is open, it updates.
   * Does NOT reveal/focus the panel.
   */
  public navigate(url: string) {
    let normalized = url.trim();
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      // Default to https for external sites, but keep http for localhost
      if (normalized.startsWith("localhost") || normalized.startsWith("127.0.0.1")) {
        normalized = "http://" + normalized;
      } else {
        normalized = "https://" + normalized;
      }
    }
    this.currentUrl = normalized;
    this.panel.webview.postMessage({ type: 'browser_load', url: normalized });
  }

  private async startProxy() {
    this.proxyServer = http.createServer(async (req, res) => {
        const urlPath = req.url || "/";
        console.log(`[BrowserProxy] Incoming request: ${req.method} ${urlPath}`);

        if (!this.currentUrl) {
          console.error("[BrowserProxy] No currentUrl set");
          res.writeHead(404);
          res.end("No URL specified");
          return;
        }

        if (urlPath.startsWith("/__gemini_inspector.js")) {
          res.writeHead(200, { "Content-Type": "application/javascript" });
          res.end(this.getInspectorScript());
          return;
        }

        try {
          let targetUrl: URL;
          const absoluteUrlMatch = urlPath.match(/^\/(https?:\/\/.+)/);
          
          if (absoluteUrlMatch) {
            targetUrl = new URL(absoluteUrlMatch[1]);
          } else if (urlPath === "/" || /^\/\d+\.\d+$/.test(urlPath)) {
            targetUrl = new URL(this.currentUrl);
          } else {
            // Fallback to Referer or currentUrl
            const referer = req.headers.referer;
            let baseForRelative = this.currentUrl;
            if (referer) {
              try {
                const refererUrl = new URL(referer);
                const refererTargetMatch = refererUrl.pathname.match(/^\/(https?:\/\/.+)/);
                if (refererTargetMatch) {
                  baseForRelative = refererTargetMatch[1];
                }
              } catch {}
            }
            const cleanPath = urlPath.replace(/^\/\d+\.\d+/, "");
            targetUrl = new URL(cleanPath || "/", baseForRelative);
          }

          console.log(`[BrowserProxy] Target URL resolved: ${targetUrl.href}`);

        const fetchWithRedirects = (url: URL, depth = 0): void => {
          if (depth > MAX_PROXY_REDIRECTS) {
            console.error(`[BrowserProxy] Too many redirects for ${url.href}`);
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end("<h2>Proxy Error</h2><p>Too many redirects.</p>");
            return;
          }

          console.log(`[BrowserProxy] [Depth ${depth}] Resolving DNS & Fetching: ${url.href}`);
          const startTime = Date.now();
          const requestState: ProxyRequestState = {
            startedAt: startTime,
            phase: "preparing request"
          };

          const protocol = url.protocol === "https:" ? https : http;
          
          // Forward original headers but override specific ones
          const forwardedHeaders = { ...req.headers };
          delete forwardedHeaders["host"];
          delete forwardedHeaders["connection"];
          delete forwardedHeaders["cookie"];
          delete forwardedHeaders["referer"];
          delete forwardedHeaders["origin"];
          delete forwardedHeaders["accept-encoding"]; // Force identity to avoid decompression issues

          const options: any = {
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method: req.method,
            rejectUnauthorized: false,
            agent: false,
            family: 4,
            lookup: this.createTimedLookup(url, depth, requestState),
            headers: { 
              ...forwardedHeaders,
              "accept-encoding": "identity",
              "cookie": this.cookieManager.getCookies(url),
              "host": url.host,
              "origin": url.origin,
              "referer": url.href,
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
          };

          let completed = false;
          const finish = () => {
            completed = true;
            clearTimeout(requestDeadline);
          };
          const sendErrorPage = (err: NodeJS.ErrnoException) => {
            if (completed || res.headersSent || res.writableEnded) {
              return;
            }

            requestState.errorAt = Date.now();
            finish();
            const statusCode = err.code === "ETIMEDOUT" || err.code === "EDNSTIMEOUT" ? 504 : 502;
            res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
            res.end(this.getProxyErrorHtml(url, err, requestState));
          };

          const proxyReq = protocol.request(options, (proxyRes) => {
            const duration = Date.now() - startTime;
            requestState.phase = "receiving response";
            requestState.responseStartedAt = Date.now();
            console.log(`[BrowserProxy] [Depth ${depth}] Response received in ${duration}ms: ${proxyRes.statusCode} for ${url.href}`);

            this.cookieManager.setCookies(url, proxyRes.headers["set-cookie"]);

            // Handle Redirects
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode || 0) && proxyRes.headers.location) {
                finish();
                let location = proxyRes.headers.location;
                try {
                  if (!location.startsWith("http")) {
                      location = new URL(location, url.origin).href;
                  }
                  console.log(`[BrowserProxy] [Depth ${depth}] Redirecting to: ${location}`);
                  if (url.href === this.currentUrl) {
                      this.currentUrl = location;
                  }
                  proxyRes.resume();
                  fetchWithRedirects(new URL(location), depth + 1);
                  return;
                } catch (e) {
                  console.error(`[BrowserProxy] Redirect URL parse error: ${location}`);
                }
            }

            const contentType = proxyRes.headers["content-type"] || "";
            const headers = { ...proxyRes.headers };
            
            delete headers["content-length"];
            delete headers["content-security-policy"];
            delete headers["content-security-policy-report-only"];
            delete headers["x-frame-options"];
            delete headers["frame-options"];
            delete headers["x-content-type-options"];
            delete headers["set-cookie"];
            delete headers["strict-transport-security"];
            delete headers["referrer-policy"];
            
            headers["access-control-allow-origin"] = "*";
            headers["access-control-allow-methods"] = "*";
            headers["access-control-allow-headers"] = "*";

            if (contentType.includes("text/html") || contentType.includes("text/css")) {
              let chunks: Buffer[] = [];
              proxyRes.on("data", (chunk: Buffer) => { chunks.push(chunk); });
              proxyRes.on("end", () => {
                if (completed || res.headersSent || res.writableEnded) {
                  return;
                }

                requestState.phase = "complete";
                let body = Buffer.concat(chunks).toString();
                body = this.rewriteUrls(body, contentType, url);
                
                finish();
                res.writeHead(proxyRes.statusCode || 200, headers);
                res.end(body);
                console.log(`[BrowserProxy] [Depth ${depth}] ${contentType} response sent for ${url.href}`);
              });
            } else {
              requestState.phase = "streaming response";
              finish();
              res.writeHead(proxyRes.statusCode || 200, headers);
              proxyRes.pipe(res, { end: true });
            }
          });

          const requestDeadline = setTimeout(() => {
            const err = new Error(`Connection timed out after ${PROXY_REQUEST_TIMEOUT_MS / 1000}s while ${requestState.phase}`) as NodeJS.ErrnoException;
            err.code = "ETIMEDOUT";
            console.error(`[BrowserProxy] [Depth ${depth}] Hard deadline reached for ${url.href}`);
            proxyReq.destroy(err);
            sendErrorPage(err);
          }, PROXY_REQUEST_TIMEOUT_MS);

          proxyReq.on("socket", (socket) => {
            requestState.socketAssignedAt = Date.now();
            requestState.phase = requestState.dnsStartedAt ? requestState.phase : "waiting for socket";
            console.log(`[BrowserProxy] [Depth ${depth}] Socket assigned for ${url.href}`);
            socket.on("lookup", (err, address, family) => {
              requestState.dnsFinishedAt = Date.now();
              if (err) {
                requestState.phase = "DNS failed";
                console.error(`[BrowserProxy] [Depth ${depth}] DNS Lookup failed for ${url.href}:`, err);
              } else {
                requestState.phase = "opening TCP connection";
                requestState.remoteAddress = String(address);
                requestState.remoteFamily = Number(family) || undefined;
                console.log(`[BrowserProxy] [Depth ${depth}] DNS Lookup finished for ${url.href}`);
              }
            });
            socket.on("connect", () => {
              requestState.tcpConnectedAt = Date.now();
              requestState.phase = url.protocol === "https:" ? "performing TLS handshake" : "waiting for response";
              console.log(`[BrowserProxy] [Depth ${depth}] TCP Connection established for ${url.href}`);
            });
            socket.on("secureConnect", () => {
              requestState.tlsConnectedAt = Date.now();
              requestState.phase = "waiting for response";
              console.log(`[BrowserProxy] [Depth ${depth}] TLS Connection established for ${url.href}`);
            });
          });

          proxyReq.setTimeout(PROXY_REQUEST_TIMEOUT_MS, () => {
            const err = new Error(`Connection timed out after ${PROXY_REQUEST_TIMEOUT_MS / 1000}s while ${requestState.phase}`) as NodeJS.ErrnoException;
            err.code = "ETIMEDOUT";
            console.error(`[BrowserProxy] [Depth ${depth}] Socket timeout for ${url.href}`);
            proxyReq.destroy(err);
            sendErrorPage(err);
          });

          proxyReq.on("error", (err: NodeJS.ErrnoException) => {
            console.error(`[BrowserProxy] [Depth ${depth}] Request error for ${url.href}:`, err);
            sendErrorPage(err);
          });

          // Only pipe body for the first request (depth 0) and if it's not a GET
          if (depth === 0 && req.method !== "GET" && req.method !== "HEAD") {
            req.pipe(proxyReq, { end: true });
          } else {
            proxyReq.end();
          }
        };

        fetchWithRedirects(targetUrl);

      } catch (err: any) {
        console.error("[BrowserProxy] Fatal error:", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h2>Invalid URL</h2><p>${this.escapeHtml(err.message)}</p>`);
      }
    });

    return new Promise<void>((resolve, reject) => {
      const server = this.proxyServer;
      if (!server) {
        reject(new Error("Proxy server was not initialized"));
        return;
      }

      const onError = (error: Error) => {
        reject(error);
      };

      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address() as any;
        this.proxyPort = address.port;
        resolve();
      });
    });
  }

  private createTimedLookup(url: URL, depth: number, requestState: ProxyRequestState): net.LookupFunction {
    return (hostname, options, callback) => {
      if (hostname === "localhost") {
        requestState.dnsStartedAt = Date.now();
        requestState.dnsFinishedAt = requestState.dnsStartedAt;
        requestState.phase = "opening TCP connection";
        requestState.remoteAddress = "127.0.0.1";
        requestState.remoteFamily = 4;
        requestState.dnsProvider = "loopback";
        callback(null, "127.0.0.1", 4);
        return;
      }

      const ipFamily = net.isIP(hostname);
      if (ipFamily !== 0) {
        requestState.dnsStartedAt = Date.now();
        requestState.dnsFinishedAt = requestState.dnsStartedAt;
        requestState.phase = "opening TCP connection";
        requestState.remoteAddress = hostname;
        requestState.remoteFamily = ipFamily;
        requestState.dnsProvider = "literal IP";
        callback(null, hostname, ipFamily);
        return;
      }

      let done = false;
      const startedAt = Date.now();
      const pendingAttempts = new Set<string>();
      const launchTimers: NodeJS.Timeout[] = [];
      let launchedDoH = false;

      requestState.dnsStartedAt = startedAt;
      requestState.phase = "resolving DNS";
      requestState.dnsAttempts = [];

      const clearLaunchTimers = () => {
        while (launchTimers.length > 0) {
          clearTimeout(launchTimers.pop());
        }
      };

      const finish = (err: NodeJS.ErrnoException | null, address: string, family: number) => {
        if (done) {
          return;
        }
        done = true;
        clearLaunchTimers();
        callback(err, address, family);
      };

      // 1. Native DNS
      pendingAttempts.add("native");
      dns.lookup(hostname, { family: 4 }, (err, address, family) => {
        pendingAttempts.delete("native");
        if (!done && !err) {
          requestState.dnsProvider = "native";
          finish(null, String(address), Number(family));
        } else if (pendingAttempts.size === 0) {
          finish(err as any, "", 0);
        }
      });

      // 2. Fallback DNS (Public Servers)
      launchTimers.push(setTimeout(() => {
        if (done) return;
        PUBLIC_DNS_SERVERS.forEach(server => {
          const resolver = new dns.Resolver();
          resolver.setServers([server]);
          const attemptId = `public-${server}`;
          pendingAttempts.add(attemptId);
          resolver.resolve4(hostname, (err, addresses) => {
            pendingAttempts.delete(attemptId);
            if (!done && !err && addresses.length > 0) {
              requestState.dnsProvider = `public-${server}`;
              finish(null, addresses[0], 4);
            } else if (pendingAttempts.size === 0) {
              finish(err as any, "", 0);
            }
          });
        });
      }, DNS_FALLBACK_DELAY_MS));

      // 3. DoH Fallback (Cloudflare/Google over HTTPS)
      launchTimers.push(setTimeout(() => {
        if (done) return;
        const dohProviders = [
          { name: "cloudflare-doh", url: `https://1.1.1.1/dns-query?name=${hostname}&type=A` },
          { name: "google-doh", url: `https://8.8.8.8/resolve?name=${hostname}&type=A` }
        ];

        dohProviders.forEach(provider => {
          pendingAttempts.add(provider.name);
          https.get(provider.url, { headers: { "accept": "application/dns-json" } }, (dohRes) => {
            let data = "";
            dohRes.on("data", c => data += c);
            dohRes.on("end", () => {
              pendingAttempts.delete(provider.name);
              if (done) return;
              try {
                const json = JSON.parse(data);
                const answer = json.Answer?.find((a: any) => a.type === 1);
                if (answer) {
                  requestState.dnsProvider = provider.name;
                  finish(null, answer.data, 4);
                }
              } catch {}
              if (pendingAttempts.size === 0) {
                finish(new Error("DNS resolution failed all methods") as any, "", 0);
              }
            });
          }).on("error", () => {
            pendingAttempts.delete(provider.name);
            if (pendingAttempts.size === 0) finish(new Error("DNS resolution failed all methods") as any, "", 0);
          });
        });
      }, DOH_FALLBACK_DELAY_MS));
    };
  }

  private rewriteUrls(body: string, contentType: string, baseUrl: URL): string {
    const proxyUrl = `http://127.0.0.1:${this.proxyPort}`;
    
    if (contentType.includes("text/html")) {
      // Inject inspector script
      body = body.replace("<head>", `<head><script src="${proxyUrl}/__gemini_inspector.js"></script>`);
      
      // Rewrite src and href to go through proxy
      // Regex to find absolute URLs and make them relative to our proxy
      // Pattern: (src|href)="https://..." -> (src|href)="http://127.0.0.1:port/https://..."
      body = body.replace(/(src|href|action)=["'](https?:\/\/.*?)["']/gi, (match, attr, url) => {
        return `${attr}="${proxyUrl}/${url}"`;
      });

      // Relative URLs are handled naturally if we are the "base" of the iframe
    } else if (contentType.includes("text/css")) {
      body = body.replace(/url\(["']?(https?:\/\/.*?)["']?\)/gi, (match, url) => {
        return `url("${proxyUrl}/${url}")`;
      });
    }

    return body;
  }

  private handleElementSelected(html: string, url?: string) {
    const tagNameMatch = html.match(/^<([a-z0-9]+)/i);
    const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : 'element';
    const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 30);
    const label = "[" + tagName + ": " + (textContent || '...') + "]";

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

    setTimeout(() => {
        const prompt = "\n[CONTEXT: Browser Selection]\n[URL: " + displayUrl + "]\n```html\n" + html + "\n```\n";
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
        <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; frame-src *; img-src * data:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline';">
        <title>Gemini Browser</title>
        <style>
          body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; color: #f1f1f1; font-family: var(--vscode-font-family); }
          .container { display: flex; flex-direction: column; width: 100%; height: 100%; }
          .toolbar { display: flex; align-items: center; padding: 4px 8px; background: #252526; border-bottom: 1px solid #333; gap: 4px; }
          .toolbar input { flex: 1; background: #3c3c3c; color: #cccccc; border: 1px solid #3c3c3c; padding: 4px 8px; border-radius: 2px; outline: none; min-width: 0; }
          .toolbar button { background: transparent; color: #cccccc; border: none; cursor: pointer; padding: 4px; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex: 0 0 auto; }
          .toolbar button:hover { background: #37373d; }
          .toolbar button.active { background: #007acc; color: white; }
          .browser-content { flex: 1; border: none; background: white; width: 100%; height: 100%; }
          
          .dropdown { position: relative; display: inline-block; }
          .dropdown-content { display: none; position: absolute; right: 0; top: 28px; background-color: #252526; min-width: 120px; box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.4); border: 1px solid #333; z-index: 100; }
          .dropdown-content button { width: 100%; padding: 8px 12px; text-align: left; border-radius: 0; border-bottom: 1px solid #333; display: block; }
          .show { display: block; }
          .overflow-menu { display: none; }

          @media (max-width: 340px) {
            #back, #forward, #refresh, #go, #inspect, #playwright { display: none; }
            .overflow-menu { display: inline-block; }
          }
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
            <button id="playwright" title="Use Playwright (Experimental)" class="${this.usePlaywright ? 'active' : ''}">🎭</button>
            
            <div class="dropdown overflow-menu">
               <button id="moreBtn" title="More Actions">⋮</button>
               <div id="moreDropdown" class="dropdown-content">
                  <button id="menuBack">Back</button>
                  <button id="menuForward">Forward</button>
                  <button id="menuRefresh">Refresh</button>
                  <button id="menuInspect">Inspect Mode</button>
                  <button id="menuPlaywright">Playwright</button>
               </div>
            </div>
          </div>
          <iframe id="browserFrame" class="browser-content" src="${proxyUrl}"></iframe>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          const frame = document.getElementById('browserFrame');
          const urlInput = document.getElementById('urlInput');
          const goBtn = document.getElementById('go');
          const refreshBtn = document.getElementById('refresh');
          const inspectBtn = document.getElementById('inspect');
          const playwrightBtn = document.getElementById('playwright');
          
          const moreBtn = document.getElementById('moreBtn');
          const moreDropdown = document.getElementById('moreDropdown');
          const menuBack = document.getElementById('menuBack');
          const menuForward = document.getElementById('menuForward');
          const menuRefresh = document.getElementById('menuRefresh');
          const menuInspect = document.getElementById('menuInspect');
          const menuPlaywright = document.getElementById('menuPlaywright');

          moreBtn.onclick = (e) => {
            moreDropdown.classList.toggle('show');
            e.stopPropagation();
          };
          
          window.onclick = () => { moreDropdown.classList.remove('show'); };

          menuBack.onclick = () => { frame.contentWindow.history.back(); };
          menuForward.onclick = () => { frame.contentWindow.history.forward(); };
          menuRefresh.onclick = () => { refreshBtn.click(); };
          menuInspect.onclick = () => { inspectBtn.click(); };
          menuPlaywright.onclick = () => { playwrightBtn.click(); };

          let isInspectMode = false;
          let isPlaywright = ${this.usePlaywright};

          playwrightBtn.onclick = () => {
            isPlaywright = !isPlaywright;
            playwrightBtn.classList.toggle('active', isPlaywright);
            vscode.postMessage({ type: 'browser_toggle_playwright', enabled: isPlaywright });
          };

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

  private getInspectorScript() {
    return `
      (function() {
        let hoveredElement = null;
        let overlay = null;

        function init() {
          overlay = document.createElement('div');
          overlay.style.position = 'fixed';
          overlay.style.pointerEvents = 'none';
          overlay.style.border = '2px solid #007acc';
          overlay.style.backgroundColor = 'rgba(0, 122, 204, 0.2)';
          overlay.style.zIndex = '999999';
          overlay.style.display = 'none';
          document.body.appendChild(overlay);
        }

        const notifyUrl = () => {
           window.parent.postMessage({ type: 'browser_url_changed', url: window.location.href }, '*');
        };

        const originalPushState = history.pushState;
        history.pushState = function() {
          originalPushState.apply(this, arguments);
          notifyUrl();
        };
        window.addEventListener('popstate', notifyUrl);

        window.addEventListener('message', e => {
          if (e.data && e.data.type === 'inspect_mode') {
            if (!overlay) init();
            window.__GEMINI_INSPECT_MODE__ = e.data.enabled;
            if (!e.data.enabled && overlay) overlay.style.display = 'none';
          }
        });

        document.addEventListener('mousemove', e => {
          if (!window.__GEMINI_INSPECT_MODE__) return;
          if (!overlay) init();
          if (!overlay) return;
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
          if (!overlay) init();
          e.preventDefault(); e.stopPropagation();
          if (hoveredElement) {
            window.parent.postMessage({
              type: 'browser_element_selected',
              context: hoveredElement.outerHTML,
              url: window.location.href
            }, '*');
            window.__GEMINI_INSPECT_MODE__ = false;
            if (overlay) overlay.style.display = 'none';
          }
        }, true);
      })();
    `;
  }

  private getProxyErrorHtml(url: URL, err: any, state: any) {
    return `
      <html>
      <head><style>body { font-family: sans-serif; padding: 20px; line-height: 1.5; background: #1e1e1e; color: #ccc; }</style></head>
      <body>
        <h2>Proxy Error</h2>
        <p>Failed to load: <b>${url.href}</b></p>
        <p>Error: ${err.message}</p>
        <hr>
        <small>Phase: ${state.phase}</small>
      </body>
      </html>
    `;
  }

  private escapeHtml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private formatError(error: any): string {
    return error.message || String(error);
  }

  public dispose() {
    GeminiBrowserPanel.currentPanel = undefined;
    this.proxyServer?.close();
    this.panel.dispose();
  }
}
