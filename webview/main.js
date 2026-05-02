(function () {
  const vscode = acquireVsCodeApi();
  const terminalElement = document.getElementById("terminal");
  const statusText = document.getElementById("statusText");
  const statusContainer = document.getElementById("statusContainer");
  const restartButton = document.getElementById("restartButton");
  const newChatButton = document.getElementById("newChatButton");
  const historyButton = document.getElementById("historyButton");
  const historyDropdown = document.getElementById("historyDropdown");
  const browserButton = document.getElementById("browserButton");

  const platform = document.body.getAttribute("data-platform");

  let isBusy = false;
  let cooldownActive = false;
  const ACTION_COOLDOWN_MS = 1500;

  // Initial loading state
  setLoading(true);

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

  function startAction(type, label) {
    if (isBusy || cooldownActive) return;
    
    setLoading(true);
    cooldownActive = true;
    setStatus(label);
    vscode.postMessage({ type });
    terminal.focus();

    setTimeout(() => {
      cooldownActive = false;
    }, ACTION_COOLDOWN_MS);
  }

  restartButton.addEventListener("click", () => {
    startAction("restart", "Restarting Gemini CLI");
  });

  newChatButton.addEventListener("click", () => {
    startAction("newChat", "Starting New Chat");
  });

  browserButton.addEventListener("click", () => {
    vscode.postMessage({ type: "browser_switch" });
  });

  historyButton.addEventListener("click", (event) => {
    if (isBusy || cooldownActive) return;
    const isShowing = historyDropdown.classList.contains("show");
    if (!isShowing) {
      setLoading(true);
      showHistorySkeleton();
      vscode.postMessage({ type: "listSessions" });
    }
    historyDropdown.classList.toggle("show");
    event.stopPropagation();
  });

  // Close dropdown when clicking outside
  window.addEventListener("click", () => {
    historyDropdown.classList.remove("show");
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case "output":
        setLoading(false);
        setStatus("Gemini CLI");
        terminal.write(message.data);
        break;
      case "clear":
        terminal.reset();
        terminal.write("\x1bc"); // Hard reset ANSI sequence
        break;
      case "sessionsList":
        setLoading(false);
        populateHistoryDropdown(message.sessions);
        break;
      case "exit":
        setLoading(false);
        setStatus(`Gemini CLI exited (${formatExit(message)})`);
        break;
    }
  });

  function populateHistoryDropdown(sessions) {
    historyDropdown.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      historyDropdown.innerHTML = '<div class="info-message">No history found.</div>';
      return;
    }

    sessions.forEach((session) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `
        <span class="session-label">${session.label}</span>
        <span class="session-desc">${session.description}</span>
      `;
      btn.addEventListener("click", () => {
        if (isBusy || cooldownActive) return;
        
        setLoading(true);
        cooldownActive = true;
        setStatus("Resuming Session...");
        vscode.postMessage({ type: "resumeSession", id: session.id });
        historyDropdown.classList.remove("show");

        setTimeout(() => {
          cooldownActive = false;
        }, ACTION_COOLDOWN_MS);
      });
      historyDropdown.appendChild(btn);
    });
  }

  function showHistorySkeleton() {
    historyDropdown.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const item = document.createElement("div");
      item.className = "skeleton-item";
      item.innerHTML = `
        <div class="skeleton-line label"></div>
        <div class="skeleton-line desc"></div>
      `;
      historyDropdown.appendChild(item);
    }
  }

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

  function setLoading(isLoading) {
    isBusy = isLoading;
    if (isLoading) {
      statusContainer.classList.add("loading");
    } else {
      statusContainer.classList.remove("loading");
    }
  }

  function formatExit(message) {
    if (message.signal) {
      return `signal ${message.signal}`;
    }

    return `code ${message.exitCode}`;
  }
})();
