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
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "gemini-dark.svg")
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
        clearTimeout(timer);
        clearLaunchTimers();
        requestState.dnsFinishedAt = Date.now();

        if (err) {
          requestState.phase = err.code === "EDNSTIMEOUT" ? "DNS timed out" : "DNS failed";
        } else {
          requestState.phase = "opening TCP connection";
          requestState.remoteAddress = address;
          requestState.remoteFamily = family;
        }

        callback(err, address, family);
      };

      const maybeFailAfterAttempts = () => {
        if (!done && launchedDoH && pendingAttempts.size === 0) {
          const err = new Error(`DNS lookup failed for ${hostname}: ${requestState.dnsAttempts?.join("; ") || "no usable A records"}`) as NodeJS.ErrnoException;
          err.code = "ENOTFOUND";
          finish(err, "", 4);
        }
      };

      const startAttempt = (label: string, resolver: () => Promise<string[]>) => {
        if (done) {
          return;
        }

        pendingAttempts.add(label);
        const attemptStartedAt = Date.now();
        requestState.dnsAttempts?.push(`${label}: started`);
        console.log(`[BrowserProxy] [Depth ${depth}] ${label} started for ${url.href}`);

        resolver()
          .then((addresses) => {
            pendingAttempts.delete(label);
            if (done) {
              return;
            }

            const address = addresses.find((candidate) => net.isIP(candidate) === 4);
            const duration = Date.now() - attemptStartedAt;
            if (address) {
              requestState.dnsProvider = label;
              requestState.dnsAttempts?.push(`${label}: ${address} in ${duration}ms`);
              console.log(`[BrowserProxy] [Depth ${depth}] ${label} resolved ${url.href} to ${address} in ${duration}ms`);
              finish(null, address, 4);
              return;
            }

            requestState.dnsAttempts?.push(`${label}: no A record in ${duration}ms`);
            maybeFailAfterAttempts();
          })
          .catch((err: NodeJS.ErrnoException) => {
            pendingAttempts.delete(label);
            if (done) {
              return;
            }

            const duration = Date.now() - attemptStartedAt;
            requestState.dnsAttempts?.push(`${label}: ${err.code || err.message} in ${duration}ms`);
            console.error(`[BrowserProxy] [Depth ${depth}] ${label} failed for ${url.href}:`, err);
            maybeFailAfterAttempts();
          });
      };

      const timer = setTimeout(() => {
        const err = new Error(`DNS lookup timed out after ${PROXY_DNS_TIMEOUT_MS / 1000}s for ${hostname}`) as NodeJS.ErrnoException;
        err.code = "EDNSTIMEOUT";
        console.error(`[BrowserProxy] [Depth ${depth}] DNS timeout for ${url.href}`);
        finish(err, "", 4);
      }, PROXY_DNS_TIMEOUT_MS);

      startAttempt("system dns.resolve4", () => this.resolveWithSystemDns(hostname));
      launchTimers.push(setTimeout(() => {
        startAttempt("public dns.resolve4", () => this.resolveWithPublicDns(hostname));
      }, DNS_FALLBACK_DELAY_MS));
      launchTimers.push(setTimeout(() => {
        launchedDoH = true;
        startAttempt("cloudflare dns-over-https", () => this.resolveWithDnsOverHttps(hostname, Math.max(1000, PROXY_DNS_TIMEOUT_MS - (Date.now() - startedAt) - 250)));
      }, DOH_FALLBACK_DELAY_MS));
    };
  }

  private resolveWithSystemDns(hostname: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      dns.resolve4(hostname, (err, addresses) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(addresses);
      });
    });
  }

  private resolveWithPublicDns(hostname: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const resolver = new dns.Resolver();
      resolver.setServers(PUBLIC_DNS_SERVERS);
      resolver.resolve4(hostname, (err, addresses) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(addresses);
      });
    });
  }

  private resolveWithDnsOverHttps(hostname: string, timeoutMs: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: "1.1.1.1",
        servername: "cloudflare-dns.com",
        path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        method: "GET",
        headers: {
          "accept": "application/dns-json",
          "host": "cloudflare-dns.com"
        },
        timeout: timeoutMs
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              Status?: number;
              Answer?: Array<{ type?: number; data?: string }>;
            };
            const addresses = (body.Answer || [])
              .filter((answer) => answer.type === 1 && answer.data && net.isIP(answer.data) === 4)
              .map((answer) => answer.data as string);

            if (res.statusCode && res.statusCode >= 400) {
              const err = new Error(`DNS-over-HTTPS returned HTTP ${res.statusCode}`) as NodeJS.ErrnoException;
              err.code = "EDOHHTTP";
              reject(err);
              return;
            }

            if (body.Status !== 0 || addresses.length === 0) {
              const err = new Error(`DNS-over-HTTPS returned no A records for ${hostname}`) as NodeJS.ErrnoException;
              err.code = "ENOTFOUND";
              reject(err);
              return;
            }

            resolve(addresses);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on("timeout", () => {
        const err = new Error(`DNS-over-HTTPS timed out after ${timeoutMs}ms`) as NodeJS.ErrnoException;
        err.code = "EDOHTIMEOUT";
        req.destroy(err);
      });
      req.on("error", reject);
      req.end();
    });
  }

  private getProxyErrorHtml(url: URL, err: NodeJS.ErrnoException, requestState: ProxyRequestState): string {
    const code = err.code ? `<p><strong>Code:</strong> ${this.escapeHtml(err.code)}</p>` : "";
    const hint = this.getProxyFailureHint(url, err, requestState);
    const diagnostics = this.getProxyDiagnosticsHtml(requestState);

    return `
      <!DOCTYPE html>
      <html>
        <body style="font-family: sans-serif; padding: 20px; background: #1e1e1e; color: #f1f1f1;">
          <h2 style="color: #f44336;">Navigation Error</h2>
          <p>Failed to load <strong>${this.escapeHtml(url.href)}</strong></p>
          ${code}
          <div style="background: #333; padding: 10px; border-radius: 4px; font-family: monospace; white-space: pre-wrap;">
            ${this.escapeHtml(err.message)}
          </div>
          ${diagnostics}
          <p style="color: #cfcfcf;">${this.escapeHtml(hint)}</p>
        </body>
      </html>
    `;
  }

  private getProxyDiagnosticsHtml(requestState: ProxyRequestState): string {
    const rows = [
      ["Phase", requestState.phase],
      ["Elapsed", `${(requestState.errorAt ?? Date.now()) - requestState.startedAt}ms`]
    ];

    if (requestState.socketAssignedAt !== undefined) {
      rows.push(["Socket", `${requestState.socketAssignedAt - requestState.startedAt}ms`]);
    }
    if (requestState.dnsStartedAt !== undefined) {
      rows.push(["DNS start", `${requestState.dnsStartedAt - requestState.startedAt}ms`]);
    }
    if (requestState.dnsFinishedAt !== undefined && requestState.dnsStartedAt !== undefined) {
      rows.push(["DNS duration", `${requestState.dnsFinishedAt - requestState.dnsStartedAt}ms`]);
    }
    if (requestState.remoteAddress) {
      rows.push(["Resolved IP", `${requestState.remoteAddress}${requestState.remoteFamily ? ` (IPv${requestState.remoteFamily})` : ""}`]);
    }
    if (requestState.dnsProvider) {
      rows.push(["DNS provider", requestState.dnsProvider]);
    }
    if (requestState.dnsAttempts?.length) {
      rows.push(["DNS attempts", requestState.dnsAttempts.join("\n")]);
    }
    if (requestState.tcpConnectedAt !== undefined) {
      rows.push(["TCP connect", `${requestState.tcpConnectedAt - requestState.startedAt}ms`]);
    }
    if (requestState.tlsConnectedAt !== undefined) {
      rows.push(["TLS ready", `${requestState.tlsConnectedAt - requestState.startedAt}ms`]);
    }
    if (requestState.responseStartedAt !== undefined) {
      rows.push(["Response", `${requestState.responseStartedAt - requestState.startedAt}ms`]);
    }

    return `
      <dl style="display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; background: #2b2b2b; padding: 10px; border-radius: 4px; color: #ddd;">
        ${rows.map(([label, value]) => `<dt style="font-weight: 700;">${this.escapeHtml(label)}</dt><dd style="margin: 0; white-space: pre-wrap;">${this.escapeHtml(value)}</dd>`).join("")}
      </dl>
    `;
  }

  private getProxyFailureHint(url: URL, err: NodeJS.ErrnoException, requestState: ProxyRequestState): string {
    if (this.isLoopbackHost(url.hostname) && err.code === "ECONNREFUSED") {
      return `Nothing is listening on ${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}. Start that local app, or navigate to a different URL.`;
    }

    if (err.code === "EDNSTIMEOUT") {
      return "DNS did not answer before VS Code's webview response budget. If this is Snap VS Code, compare with the deb/tar build or check Snap network permissions.";
    }

    if (err.code === "ETIMEDOUT") {
      if (requestState.phase === "opening TCP connection") {
        return "DNS resolved, but direct TCP connection did not complete. That usually means outbound traffic from the VS Code extension host is blocked or must go through an HTTP/HTTPS proxy.";
      }

      if (requestState.phase === "performing TLS handshake") {
        return "TCP connected, but TLS did not complete. Check SSL inspection, proxy, VPN, or firewall settings for the VS Code extension host.";
      }

      if (requestState.phase === "waiting for response") {
        return "The remote server connection completed, but no HTTP response arrived before VS Code's response budget.";
      }

      return "The extension host could not complete the connection quickly enough. This usually points to DNS, proxy, VPN, firewall, or sandboxed network access.";
    }

    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      return "The host could not be resolved from the VS Code extension host. Check DNS from the same VS Code install.";
    }

    if (err.code === "ECONNREFUSED") {
      return "The target host refused the connection. If this is a local service, make sure it is running.";
    }

    return "Check whether the VS Code extension host has network access. Snap builds can isolate extension networking in ways a normal terminal does not.";
  }

  private isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private rewriteUrls(content: string, contentType: string, targetUrl: URL): string {
    const proxyBase = `http://127.0.0.1:${this.proxyPort}`;
    
    if (contentType.includes("text/html")) {
      const injection = '<script src="/__gemini_inspector.js"></script>';
      let body = content;
      if (body.includes("<head>")) {
        body = body.replace("<head>", `<head>${injection}`);
      } else if (body.includes("<html>")) {
        body = body.replace("<html>", `<html>${injection}`);
      } else {
        body = injection + body;
      }

      // Rewrite href, src, action
      body = body.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, url) => {
        if (url.startsWith("data:") || url.startsWith("#") || url.startsWith("javascript:") || (url.startsWith("/") && url.includes("/__gemini_inspector.js"))) {
          return match;
        }
        try {
          const absoluteUrl = new URL(url, targetUrl).href;
          return `${attr}="${proxyBase}/${absoluteUrl}"`;
        } catch {
          return match;
        }
      });

      // Rewrite srcset
      body = body.replace(/srcset=["']([^"']+)["']/gi, (match, urls) => {
        const rewritten = urls.split(',').map((part: string) => {
          const [url, ...desc] = part.trim().split(/\s+/);
          try {
            return `${proxyBase}/${new URL(url, targetUrl).href} ${desc.join(' ')}`.trim();
          } catch {
            return part;
          }
        }).join(', ');
        return `srcset="${rewritten}"`;
      });

      return body;
    } else if (contentType.includes("text/css")) {
      return content.replace(/url\(["']?([^"'\)]+)["']?\)/gi, (match, url) => {
        if (url.startsWith("data:")) return match;
        try {
          const absoluteUrl = new URL(url, targetUrl).href;
          return `url("${proxyBase}/${absoluteUrl}")`;
        } catch {
          return match;
        }
      });
    }
    return content;
  }

  private getInspectorScript() {
    return `
      (function() {
        window.__GEMINI_INSPECT_MODE__ = false;
        let hoveredElement = null;
        let overlay = null;

        // Patch fetch and XHR to route through proxy
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
          let url;
          if (typeof input === 'string') url = input;
          else if (input instanceof URL) url = input.href;
          else if (input && input.url) url = input.url;

          if (typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith(window.location.origin)) {
            let newUrl = url;
            if (!url.startsWith('http') && !url.startsWith('//')) {
              const targetUrlStr = window.location.pathname.substring(1) + window.location.search;
              try {
                const targetBase = new URL(targetUrlStr);
                newUrl = new URL(url, targetBase).href;
              } catch(e) {}
            }
            newUrl = window.location.origin + '/' + newUrl;
            
            if (typeof input === 'string') input = newUrl;
            else if (input instanceof URL) input = new URL(newUrl);
            else {
              try { input = new Request(newUrl, input); } catch(e) { input = newUrl; }
            }
          }
          return originalFetch(input, init);
        };

        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          if (typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith(window.location.origin)) {
            let newUrl = url;
            if (!url.startsWith('http') && !url.startsWith('//')) {
              const targetUrlStr = window.location.pathname.substring(1) + window.location.search;
              try {
                const targetBase = new URL(targetUrlStr);
                newUrl = new URL(url, targetBase).href;
              } catch(e) {}
            }
            url = window.location.origin + '/' + newUrl;
          }
          return originalXhrOpen.apply(this, arguments);
        };

        function init() {
          if (document.getElementById('gemini-inspector-overlay')) return;
          overlay = document.createElement('div');
          overlay.id = 'gemini-inspector-overlay';
          overlay.style.cssText = 'position:fixed; pointer-events:none; z-index:2147483647; border:2px solid #007acc; background:rgba(0,122,204,0.1); display:none; transition: all 0.05s ease;';
          document.body.appendChild(overlay);
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', init);
        } else {
          init();
        }

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

    GeminiTerminalSession.sendToActiveSessions("\n" + label + "\n");
    
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
          .toolbar { display: flex; align-items: center; padding: 4px 8px; background: #252526; border-bottom: 1px solid #333; gap: 8px; }
          .toolbar input { flex: 1; background: #3c3c3c; color: #cccccc; border: 1px solid #3c3c3c; padding: 4px 8px; border-radius: 2px; outline: none; }
          .toolbar button { background: transparent; color: #cccccc; border: none; cursor: pointer; padding: 4px; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
          .toolbar button:hover { background: #37373d; }
          .toolbar button.active { background: #007acc; color: white; }
          .browser-content { flex: 1; border: none; background: white; width: 100%; height: 100%; }
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

  public dispose() {
    GeminiBrowserPanel.currentPanel = undefined;
    this.proxyServer?.close();
    this.panel.dispose();
  }
}
