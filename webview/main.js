(function () {
  const vscode = acquireVsCodeApi();
  const terminalElement = document.getElementById("terminal");
  const statusText = document.getElementById("statusText");
  const restartButton = document.getElementById("restartButton");

  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily:
      'Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.1,
    scrollback: 10000,
    theme: {
      background: "#0d1117",
      foreground: "#d6deeb",
      cursor: "#ffffff",
      selectionBackground: "#264f78"
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(terminalElement);
  terminal.focus();

  terminal.onData((data) => {
    vscode.postMessage({ type: "input", data });
  });

  terminal.onResize(({ cols, rows }) => {
    vscode.postMessage({ type: "resize", cols, rows });
  });

  restartButton.addEventListener("click", () => {
    setStatus("Restarting Gemini CLI");
    vscode.postMessage({ type: "restart" });
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

  const resizeObserver = new ResizeObserver(() => {
    fitToContainer();
  });

  resizeObserver.observe(terminalElement);
  window.addEventListener("resize", fitToContainer);

  requestAnimationFrame(() => {
    fitToContainer();
    vscode.postMessage({ type: "ready" });
  });

  function fitToContainer() {
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
