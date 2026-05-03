# Project History: Building the Gemini Browser

This document chronicles the development of the "Cursor-style" Browser and Element Inspector features for the **Gemini CLI UI** extension.

## 1. The Vision
The goal was to eliminate context switching between VS Code and external browsers. We wanted a native browser that not only previews code but acts as a **sensor** for the AI, allowing it to "see" and "touch" the running application.

## 2. Challenges Faced & Solutions

### Problem A: The CORS Wall
**The Issue:** VS Code Webviews are highly secure. Standard `iframes` cannot access the DOM of a different origin (e.g., your app on `localhost:3000`). This made "inspecting" elements impossible through normal means.
**The Solution:** We engineered a **Local Injection Proxy**. The extension now starts a lightweight HTTP proxy that fetches your app, modifies the HTML to inject our "Inspector Script," and serves it to the webview. Since the script is now "same-origin" with the app, it has full DOM access.

### Problem B: Security Policies (CSP & Trusted Types)
**The Issue:** Even with the proxy, VS Code's strict Content Security Policy and "Trusted Types" blocked our injected inline scripts.
**The Solution:** We moved the inspector logic to a virtual file path (`/__gemini_inspector.js`) served by the proxy. By loading the script via a `src` attribute rather than inline, we satisfied the security requirements.

### Problem C: Single Page App (SPA) Navigation
**The Issue:** In React or Next.js apps, clicking a link doesn't trigger a full page reload. This caused our inspector to "die" on subpages, and the URL bar wouldn't update.
**The Solution:** We implemented **Navigation Sync**. We patched `history.pushState` and added `popstate` listeners inside the injected script. Now, the iframe "calls home" to the extension whenever the URL changes, keeping the toolbar and inspector perfectly in sync.

### Problem D: Terminal Noise vs. AI Context
**The Issue:** Sending raw HTML context to the AI initially dumped hundreds of lines of code into the user's terminal, making the chat hard to read.
**The Symbol:** We wanted the visual simplicity of Gemini CLI's `[Pasted text]` feature.
**The Solution:** We implemented **Bracketed Paste Summarization**. By wrapping the HTML in specific ANSI escape sequences (`\x1b[200~`), we tell the terminal to handle it as a paste. We then provide a clean, descriptive label (like `[button: Save Changes]`) for the user while the AI receives the full underlying context.

### Problem E: Terminal Focus & Race Conditions
**The Issue:** Users reported that clicking "New Chat" would sometimes lead to a state where they couldn't type. This was caused by a race condition where the exit of the old terminal process would accidentally "zero out" the reference to the newly started process. Additionally, focus was often lost during the transition.
**The Solution:** We implemented **Process Instance Validation** to ensure that exit signals from old sessions don't affect the current one. We also added an **Input Buffer** that captures keystrokes during the PTY's brief startup phase and flushes them once the shell is ready, coupled with a **Global Focus Capture** strategy that redirects keyboard events to the terminal even if focus was temporarily lost.

### Problem F: Snap VS Code DNS Timeouts
**The Issue:** On Linux installs where VS Code runs through Snap, the browser proxy could hang while resolving external domains such as `google.com`. Local shell DNS worked, but the VS Code extension host stalled in DNS long enough for the webview request to time out. This produced blank pages or navigation errors even though the network itself was online.
**The Solution:** We added **Fail-Fast Network Diagnostics** and a **Layered DNS Resolver** to the browser proxy. The proxy now reports whether a request is stuck in DNS, TCP connect, TLS, or response wait. For external hosts, it avoids relying on only `dns.lookup` and falls back through Node c-ares `dns.resolve4`, public DNS servers, and DNS-over-HTTPS to `1.1.1.1`. This bypasses the slow/broken resolver path in the Snap extension host and keeps the request inside VS Code's response budget.

### Problem G: CORS & Browser Security Limits
**The Issue:** The proxy currently strips common blocking headers and injects the inspector script, which works for many local apps and simple pages. It does not fully emulate a browser, though. Some sites still fail because their JavaScript performs API calls against the original origin, uses strict CSP, checks `Origin`/`Referer`, depends on cookies, uses service workers, locks assets behind CORS, or builds absolute URLs that escape the proxy.
**The Planned Solution:** Move from a simple header-stripping proxy to a **Full Rewrite Proxy**. HTML, CSS, JavaScript entry points, fetch/XHR calls, redirects, cookies, and asset URLs should be rewritten so every subrequest flows back through the extension proxy under one controlled origin. For sites that cannot safely be rewritten, the browser should fall back to a real browser automation mode, such as Playwright or the VS Code simple browser style, instead of pretending that CORS can always be bypassed.

## 3. Key Technical Milestones
- **Bridge Architecture**: Created a type-safe messaging protocol between the Extension Host, the Webview Shell, and the injected Iframe script.
- **Dynamic Proxy Mapping**: Built logic to map internal proxy ports back to the user's intended URLs for a seamless address bar experience.
- **Smart Labeling**: Developed a tag-parsing engine that automatically generates friendly names (e.g., `para1`, `button2`) for captured elements.
- **Session Instance Management**: Developed a robust PTY session lifecycle that handles rapid restarts and input buffering to prevent data loss during transitions.
- **Layered DNS Resolution**: Added DNS diagnostics and fallback resolvers so Snap-hosted VS Code extension processes can still resolve external domains.
- **Proxy Hardening Plan**: Documented the path from header stripping toward a full rewrite proxy for better CORS and asset handling.

## 4. Final Result
A fully functional, AI-integrated browser that allows users to "point and click" on their UI to give the Gemini agent the exact context it needs to fix bugs or build features.
