(function () {
  const vscode = acquireVsCodeApi();
  const terminalElement = document.getElementById("terminal") || document.querySelector(".terminal");
  const statusText = document.getElementById("statusText");
  const statusContainer = document.getElementById("statusContainer");
  const newChatButton = document.getElementById("newChatButton");
  const addFileButton = document.getElementById("addFileButton");
  const historyButton = document.getElementById("historyButton");
  const historyDropdown = document.getElementById("historyDropdown");
  const browserButton = document.getElementById("browserButton");
  const moreActionsButton = document.getElementById("moreActionsButton");
  const moreActionsDropdown = document.getElementById("moreActionsDropdown");
  const moreHistoryButton = document.getElementById("moreHistoryButton");
  const moreAddFileButton = document.getElementById("moreAddFileButton");
  const moreBrowserButton = document.getElementById("moreBrowserButton");
  const moreNewChatButton = document.getElementById("moreNewChatButton");

  const platform = document.body.getAttribute("data-platform");

  let isBusy = false;
  let cooldownActive = false;
  const ACTION_COOLDOWN_MS = 1500;

  // Track user messages for specialized copy
  let userMessages = [];
  let currentInputLine = "";

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

  // Handle global shortcuts and paste
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;

    // Paste handling: Ctrl+V (Windows/Linux) or Cmd+V (Mac)
    const isPaste = (event.ctrlKey || event.metaKey) && event.key === "v";
    if (isPaste) {
      return false; // Let browser handle it (triggers paste event)
    }

    // Copy handling: Ctrl+C (Windows/Linux) or Cmd+C (Mac)
    const isCopy = (event.ctrlKey || event.metaKey) && event.key === "c";
    if (isCopy && terminal.hasSelection()) {
      const selectedText = terminal.getSelection();
      if (selectedText) {
        navigator.clipboard.writeText(selectedText).catch(() => {
          // Fallback if clipboard API fails
          document.execCommand("copy");
        });
      }
      return false; // Don't send ^C to terminal
    }

    // Custom shortcuts: Ctrl+Alt+[Key]
    if (event.ctrlKey && event.altKey) {
      switch (event.key.toLowerCase()) {
        case "n":
          newChatButton.click();
          return false;
        case "h":
          historyButton.click();
          return false;
        case "b":
          browserButton.click();
          return false;
      }
    }

    // Text Editing Shortcuts
    if (event.ctrlKey && !event.altKey && !event.shiftKey) {
      switch (event.key) {
        case "Backspace":
          // Send Ctrl+W (\x17) to delete word
          vscode.postMessage({ type: "input", data: "\x17" });
          return false;
        case "ArrowLeft":
          // Send Alt+B (\x1bb) or Ctrl+Left sequence (\x1b[1;5D)
          vscode.postMessage({ type: "input", data: "\x1b[1;5D" });
          return false;
        case "ArrowRight":
          // Send Alt+F (\x1bf) or Ctrl+Right sequence (\x1b[1;5C)
          vscode.postMessage({ type: "input", data: "\x1b[1;5C" });
          return false;
        case "a":
          // Greedy select: Capture all connected non-empty lines around the cursor
          const buffer = terminal.buffer.active;
          const currentY = buffer.baseY + buffer.cursorY;
          let startY = currentY;
          let endY = currentY;

          // 1. Scan UPWARDS
          while (startY > 0) {
            const line = buffer.getLine(startY);
            const text = line.translateToString(true);
            
            // If the line has a prompt, this is likely the start
            if (text.includes("> ") || text.includes("$ ") || text.includes("] ")) {
               break; 
            }

            // If the PREVIOUS line is empty, stop here
            const prevLine = buffer.getLine(startY - 1);
            if (!prevLine || prevLine.translateToString(true).trim().length === 0) {
              break;
            }
            
            startY--;
          }

          // 2. Scan DOWNWARDS
          while (endY < buffer.length - 1) {
            const currentLine = buffer.getLine(endY);
            const nextLine = buffer.getLine(endY + 1);
            
            // If the CURRENT line is empty, stop
            if (!currentLine || currentLine.translateToString(true).trim().length === 0) {
              break;
            }

            // If the NEXT line is empty, stop
            if (!nextLine || nextLine.translateToString(true).trim().length === 0) {
              break;
            }

            endY++;
          }

          terminal.selectLines(startY, endY);
          return false;
      }
    }

    return true;
  });

  // Redirect global key events to terminal if not focusing an input
  window.addEventListener("keydown", (event) => {
    if (document.activeElement.tagName !== "INPUT" && 
        document.activeElement.tagName !== "TEXTAREA" &&
        !document.activeElement.isContentEditable) {
      terminal.focus();
    }
  }, true);

  // Ensure terminal stays focused when clicked anywhere except buttons
  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest("button") && !event.target.closest(".dropdown-content")) {
      setTimeout(() => terminal.focus(), 0);
    }
  });

  terminal.onData((data) => {
    // Track messages for Ctrl+A specialized copy
    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      if (char === "\r" || char === "\n") {
        if (currentInputLine.trim()) {
          userMessages.push(currentInputLine.trim());
        }
        currentInputLine = "";
      } else if (char === "\x7f" || char === "\b") {
        currentInputLine = currentInputLine.slice(0, -1);
      } else if (char.length === 1 && char >= " ") {
        currentInputLine += char;
      }
    }
    vscode.postMessage({ type: "input", data });
  });

  // Force focus to terminal when window gains focus
  window.addEventListener("focus", () => {
    setTimeout(() => terminal.focus(), 0);
  });

  // Handle paste events explicitly in the webview.
  const handlePaste = (event) => {
    const data = (event.clipboardData || window.clipboardData)?.getData("text");
    if (data) {
      vscode.postMessage({ type: "input", data });
    }
    event.preventDefault();
    event.stopPropagation();
    setTimeout(() => terminal.focus(), 0);
  };

  terminalElement.addEventListener("paste", handlePaste, true);
  document.addEventListener("paste", handlePaste, true);

  terminal.onResize(({ cols, rows }) => {
    vscode.postMessage({ type: "resize", cols, rows });
  });

  function startAction(type, label) {
    // restart and newChat can bypass isBusy to allow recovery from hangs
    const isRecoveryAction = type === "restart" || type === "newChat";
    if ((isBusy && !isRecoveryAction) || cooldownActive) return;
    
    setLoading(true);
    cooldownActive = true;
    setStatus(label);
    vscode.postMessage({ type });
    
    // De-focus the button to ensure keyboard focus can go to terminal
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    setTimeout(() => {
      terminal.focus();
    }, 100);

    setTimeout(() => {
      cooldownActive = false;
    }, ACTION_COOLDOWN_MS);
  }

  newChatButton.addEventListener("click", () => {
    startAction("newChat", "Starting New Chat");
  });

  addFileButton.addEventListener("click", () => {
    vscode.postMessage({ type: "addFile" });
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

  moreActionsButton.addEventListener("click", (event) => {
    moreActionsDropdown.classList.toggle("show");
    event.stopPropagation();
  });

  moreHistoryButton.addEventListener("click", () => {
    historyButton.click();
    moreActionsDropdown.classList.remove("show");
  });

  moreAddFileButton.addEventListener("click", () => {
    addFileButton.click();
    moreActionsDropdown.classList.remove("show");
  });

  moreBrowserButton.addEventListener("click", () => {
    browserButton.click();
    moreActionsDropdown.classList.remove("show");
  });

  moreNewChatButton.addEventListener("click", () => {
    newChatButton.click();
    moreActionsDropdown.classList.remove("show");
  });

  // Close dropdown when clicking outside
  window.addEventListener("click", () => {
    historyDropdown.classList.remove("show");
    moreActionsDropdown.classList.remove("show");
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case "output":
        // If we get output, the process is alive. 
        // Reset status if it was busy or showing an old exit message.
        if (isBusy || statusText.textContent.includes("exited")) {
          setLoading(false);
          setStatus("Gemini CLI");
          terminal.focus();
        }
        terminal.write(message.data);
        break;
      case "clear":
        terminal.reset();
        terminal.write("\x1bc"); // Hard reset ANSI sequence
        terminal.focus();
        break;
      case "sessionsList":
        setLoading(false);
        populateHistoryDropdown(message.sessions);
        break;
      case "exit":
        setLoading(false);
        setStatus(`Gemini CLI exited (${formatExit(message)})`);
        break;
      case "focus":
        terminal.focus();
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
      // Ensure terminal is focused when an operation completes
      setTimeout(() => terminal.focus(), 0);
    }
  }

  function formatExit(message) {
    if (message.signal) {
      return `signal ${message.signal}`;
    }

    return `code ${message.exitCode}`;
  }
})();
