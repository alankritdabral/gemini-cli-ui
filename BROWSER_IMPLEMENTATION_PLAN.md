# Browser Feature Implementation Plan

This document outlines the strategy for implementing a native, AI-integrated browser within the **Gemini CLI UI** VS Code extension, similar to the functionality found in Cursor 2.0.

## 1. Core Architecture

The browser will be implemented as a VS Code `WebviewPanel`. 

### Components:
- **BrowserPanel (Extension Host):** A TypeScript class managing the lifecycle of the webview.
- **Browser Webview (Frontend):** An HTML/JS wrapper that contains an `iframe` or a custom rendering layer to load local/remote URLs.
- **Automation Bridge:** A content script injected into the loaded page (or a proxy layer) that allows the extension to interact with the DOM.

## 2. AI Tool Integration

To allow the Gemini CLI (or any agent) to use the browser, we will expose a set of **Browser Tools**. These will be registered such that the agent can call them as functions.

### Proposed Tools:
- `browser_navigate(url: string)`: Opens a specific URL.
- `browser_click(selector: string)`: Simulates a click on a DOM element.
- `browser_type(selector: string, text: string)`: Inputs text into a field.
- `browser_get_dom(selector?: string)`: Returns the HTML/accessibility tree of the current page.
- `browser_screenshot()`: Captures the current view as a base64 image for visual analysis.

## 3. Implementation Steps

### Phase 1: The Browser Shell
1. **Create `src/views/browserPanel.ts`**: Implement the `WebviewPanel` logic.
2. **UI Design**: Add a navigation bar (back, forward, reload, URL input) at the top of the webview.
3. **Command Registration**: Add a VS Code command `gemini.openBrowser` to trigger the view.

### Phase 2: Communication Bridge
1. **Message Passing**: Use `webview.postMessage` and `onDidReceiveMessage` to send commands from the Extension Host to the Browser UI.
2. **Proxy/Iframe Handling**: Since `iframes` have CORS restrictions, implement a simple local proxy or use the `vscode-resource` scheme to handle content if necessary.

### Phase 3: AI Agency (The "Cursor" Magic)
1. **DOM Inspector**: Implement a script that can find elements based on text or CSS selectors and highlight them.
2. **Element Selector Tool**: A mode where the user clicks an element in the browser, and the extension sends the HTML/CSS context back to the Gemini CLI chat.
3. **Console Mirroring**: Capture `console.log` and errors from the browser and display them in the extension's output or send them to the AI.

## 4. Technical Challenges & Solutions

| Challenge | Solution |
|-----------|----------|
| **CORS / X-Frame-Options** | Use a custom VS Code URI scheme or a lightweight local proxy server to bypass header restrictions for local development. |
| **Security** | Implement strict `Content-Security-Policy` (CSP) and ensure the webview only has access to necessary VS Code APIs. |
| **Element Accuracy** | Use the **Accessibility Tree** instead of raw HTML for the AI, as it provides a cleaner, more semantic representation of the UI. |

## 5. Next Steps

1. **Scaffold the Browser View**: Start by creating a basic "Hello World" webview that can load `http://localhost:3000`.
2. **Define the Protocol**: Finalize the JSON message format for `Extension <-> Webview` communication.
3. **Gemini CLI Integration**: Update the CLI runner to recognize and invoke the new browser tools.
