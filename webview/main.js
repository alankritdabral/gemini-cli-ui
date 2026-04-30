(function () {
  const vscode = acquireVsCodeApi();
  const terminalElement = document.getElementById("terminal");
  const statusText = document.getElementById("statusText");
  const restartButton = document.getElementById("restartButton");
  const newChatButton = document.getElementById("newChatButton");

  const platform = document.body.getAttribute("data-platform");

  // Dynamically read VS Code editor font settings from CSS variables
  const computedStyle = getComputedStyle(document.body);
  const editorFontSize = parseInt(computedStyle.getPropertyValue('--vscode-editor-font-size')) || 12;
  const editorFontFamily = computedStyle.getPropertyValue('--vscode-editor-font-family') || 
    'Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: editorFontFamily,
    fontSize: editorFontSize,
    lineHeight: 1.1,
    scrollback: 10000,
    theme: {
      background: "#0d1117",
      foreground: "#d6deeb",
      cursor: "#ffffff",
      selectionBackground: "#264f78"
    },
    // On Windows, ConPTY handles its own reflow/wrapping. 
    // Telling xterm.js we're on Windows helps avoid duplication/ghosting.
    ...(platform === "win32" ? { windowsPty: { backend: "conpty" } } : {})
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(terminalElement);
  terminal.focus();

  // Handle Ctrl+V / Cmd+V explicitly to ensure they trigger the 'paste' event
  terminal.attachCustomKeyEventHandler((event) => {
    // Check for Ctrl+V (Windows/Linux) or Cmd+V (Mac)
    const isPaste = (event.ctrlKey || event.metaKey) && event.key === "v";
    if (isPaste && event.type === "keydown") {
      return false; // Let the browser handle it (triggers paste event)
    }
    return true;
  });

  // Ensure terminal stays focused when clicked
  terminalElement.addEventListener("mousedown", () => {
    setTimeout(() => terminal.focus(), 0);
  });

  terminal.onData((data) => {
    vscode.postMessage({ type: "input", data });
  });

  // Handle paste events explicitly in the webview.
  // We use both the terminal element and document to ensure we catch the event.
  // We preventDefault to let the PTY handle the input and echo it back,
  // avoiding duplicate characters if xterm.js also tries to handle it.
  const handlePaste = (event) => {
    const data = (event.clipboardData || window.clipboardData)?.getData("text");
    if (data) {
      vscode.postMessage({ type: "input", data });
    }
    event.preventDefault();
    event.stopPropagation();
  };

  terminalElement.addEventListener("paste", handlePaste, true);
  document.addEventListener("paste", handlePaste, true);

  terminal.onResize(({ cols, rows }) => {
    vscode.postMessage({ type: "resize", cols, rows });
  });

  restartButton.addEventListener("click", () => {
    setStatus("Restarting Gemini CLI");
    vscode.postMessage({ type: "restart" });
    terminal.focus();
  });

  newChatButton.addEventListener("click", () => {
    setStatus("Starting New Chat");
    vscode.postMessage({ type: "newChat" });
    terminal.focus();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case "output":
        setStatus("Gemini CLI");
        terminal.write(message.data);
        break;
      case "clear":
        terminal.clear();
        break;
      case "exit":
        setStatus(`Gemini CLI exited (${formatExit(message)})`);
        terminal.writeln("");
        terminal.writeln(`\x1b[33m[Gemini CLI exited: ${formatExit(message)}]\x1b[0m`);
        terminal.writeln("\x1b[2mUse Restart to launch it again.\x1b[0m");
        break;
    }
  });

  let resizeTimeout;
  const debouncedFit = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      fitToContainer();
      resizeTimeout = undefined;
    }, 100);
  };

  const resizeObserver = new ResizeObserver(debouncedFit);
  resizeObserver.observe(terminalElement);
  window.addEventListener("resize", debouncedFit);

  requestAnimationFrame(() => {
    fitToContainer();
    vscode.postMessage({ type: "ready" });
  });

  function fitToContainer() {
    if (!terminalElement.offsetWidth || !terminalElement.offsetHeight) {
      return;
    }

    try {
      fitAddon.fit();
    } catch {
      // xterm can throw before fonts/layout settle; the next resize will retry.
    }
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function formatExit(message) {
    if (message.signal) {
      return `signal ${message.signal}`;
    }

    return `code ${message.exitCode}`;
  }
})();
