# 🚀 Gemini CLI UI

### The Ultimate AI-Powered Workspace for VS Code

**Gemini CLI UI** is a next-generation developer tool that bridges the gap between your terminal, your editor, and your browser. It brings the full intelligence of the [Gemini CLI](https://github.com/google/gemini-cli) into a native VS Code experience, supercharged with an AI-integrated browser.

![Gemini CLI UI](media/gemini-cli-ui.jpg)

---

## ✨ Key Features

### 🖥️ PTY-Backed AI Terminal
*   **Authentic Experience**: A real terminal powered by `node-pty` and `xterm.js`.
*   **Interactive & Colorful**: Full support for ANSI colors, interactive CLI prompts, and raw shell output.
*   **Smart Environment**: Automatically detects your Node.js environment (NVM, Volta, fnm) to ensure Gemini always runs smoothly.

### 🌐 AI-Integrated "Sensor" Browser
*   **CORS-Evading Proxy**: A sophisticated rewrite proxy that evades CORS and CSP restrictions, allowing you to browse any site (even complex React/Next.js apps) without leaving VS Code.
*   **🔍 Cursor-Style Inspector**: Click any UI element in the browser to instantly capture its HTML context and URL, sending it directly to the AI to fix bugs or implement features.
*   **⚡ Runtime API Patching**: Automatically intercepts and proxies `fetch` and `XMLHttpRequest` calls, ensuring that dynamic APIs and absolute URLs work perfectly within the editor.
*   **🍪 Stateful Browsing**: Integrated persistent cookie management that saves your login sessions to VS Code's global storage—sessions survive editor restarts!
*   **🎭 Playwright Fallback**: Experimental support for full browser automation for the most resilient sites.

### 🧩 Seamless Integration
*   **Sidebar Chat**: A convenient chat view for quick questions and code generation.
*   **Bracketed Paste**: Sends rich code context to the AI using clean, summarized labels in your terminal.
*   **Cross-Platform**: Optimized for macOS, Windows (PowerShell/CMD), and Linux (including Snap builds with a custom DNS resolver).

---

## 🛠️ Installation

1. Open VS Code.
2. Go to the **Extensions** view (`Ctrl+Shift+X`).
3. Search for **Gemini CLI UI**.
4. Click **Install**.

## 🚀 Quick Start

### 💬 Start Chatting
Click the **Gemini** icon in the Activity Bar. The CLI starts automatically.

### 🔍 Inspect Your App
1. Launch the **Gemini Browser** from the Sidebar.
2. Enter your URL (e.g., `http://localhost:3000`).
3. Toggle the **🔍 (Inspect)** mode.
4. Click any element to send its code context to the AI.

## ⚙️ Requirements
- **Node.js**: v20 or higher.
- **Gemini CLI**: Automatically uses your global install or `npx @google/gemini-cli`.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---
*Built with ❤️ for the AI-first developer.*
