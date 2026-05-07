(function () {
  const vscode = acquireVsCodeApi();
  const terminalElement = document.getElementById("terminal") || document.querySelector(".terminal");
  const statusText = document.getElementById("statusText");
  const statusContainer = document.getElementById("statusContainer");
  const newChatButton = document.getElementById("newChatButton");
  const historyButton = document.getElementById("historyButton");
  const historyDropdown = document.getElementById("historyDropdown");
  const browserButton = document.getElementById("browserButton");
  const moreActionsButton = document.getElementById("moreActionsButton");
  const moreActionsDropdown = document.getElementById("moreActionsDropdown");
  const moreHistoryButton = document.getElementById("moreHistoryButton");
  const moreBrowserButton = document.getElementById("moreBrowserButton");
  const moreQuotaButton = document.getElementById("moreQuotaButton");
  const moreNewChatButton = document.getElementById("moreNewChatButton");

  const historyView = document.getElementById("historyView");
  const historyListDropdown = document.getElementById("historyListDropdown");
  const historyListFull = document.getElementById("historyListFull");
  const historyNewChatButton = document.getElementById("historyNewChatButton");
  const quotaRows = document.getElementById("quotaRows");

  const suggestionControls = document.getElementById("suggestionControls");
  const suggestionUp = document.getElementById("suggestionUp");
  const suggestionDown = document.getElementById("suggestionDown");
  const suggestionYes = document.getElementById("suggestionYes");
  const addFileFooter = document.getElementById("addFileFooter");
  const permissionBtn = document.getElementById("permissionBtn");
  const permissionIcon = document.getElementById("permissionIcon");
  const permissionLabel = document.getElementById("permissionLabel");
  const permissionMenu = document.getElementById("permissionMenu");
  const permissionDropdown = document.getElementById("permissionDropdown");
  const modelsBtn = document.getElementById("modelsBtn");
  const modelsMenu = document.getElementById("modelsMenu");
  const modelsDropdown = document.getElementById("modelsDropdown");
  const footerMoreBtn = document.getElementById("footerMoreBtn");
  const footerMoreMenu = document.getElementById("footerMoreMenu");
  const moreAddFile = document.getElementById("moreAddFile");
  const moreModels = document.getElementById("moreModels");
  const morePermissions = document.getElementById("morePermissions");

  let isFirstLoad = true;
  document.body.classList.add("first-startup");

  const modelList = [
    { id: "auto-gemini-3", name: "Auto (Gemini 3)", oneliner: "Best of Gemini 3", summary: "Smart routing between Pro and Flash models for Gemini 3." },
    { id: "auto-gemini-2.5", name: "Auto (Gemini 2.5)", oneliner: "Best of Gemini 2.5", summary: "Smart routing between Pro and Flash models for Gemini 2.5." },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview", oneliner: "Maximum Quality", summary: "Highest quality, complex reasoning, and precise coding." },
    { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview", oneliner: "Speed & Capability", summary: "Fast and capable, great for iterative coding." },
    { id: "gemini-3.1-flash-lite-preview", name: "gemini-3.1-flash-lite-preview", oneliner: "Balanced Performance", summary: "Balanced speed and quality at a lower cost." },
    { id: "gemini-2.5-pro", name: "gemini-2.5-pro", oneliner: "Proven Reliability", summary: "Reliable quality for complex tasks and coding." },
    { id: "gemini-2.5-flash", name: "gemini-2.5-flash", oneliner: "Fast Execution", summary: "Optimized for speed and high throughput." },
    { id: "gemini-2.5-flash-lite", name: "gemini-2.5-flash-lite", oneliner: "Highest Efficiency", summary: "Fastest and most cost-effective for simple tasks." }
  ];

  function populateModelsMenu() {
    modelsMenu.innerHTML = "";
    modelList.forEach(model => {
      const btn = document.createElement("button");
      btn.type = "button";
      
      let quotaColor = "#3fb950"; // Green
      if (model.percentage >= 90) {
        quotaColor = "#f85149"; // Red
      } else if (model.percentage >= 70) {
        quotaColor = "#d29922"; // Yellow
      }

      let percentageDisplay = "";
      if (model.percentage !== undefined) {
        percentageDisplay = `<span class="model-quota" style="color: ${quotaColor}; background: ${quotaColor}1A">${model.percentage}% used</span>`;
      } else if (model.isFetching) {
        percentageDisplay = `<span class="model-quota" style="color: #8b949e; background: rgba(139, 148, 158, 0.1)">Fetching...</span>`;
      }

      btn.innerHTML = `
        <div class="model-header">
          <span class="model-name">${model.name}</span>
          ${percentageDisplay}
        </div>
        <span class="model-oneliner">${model.oneliner}</span>
        <span class="model-summary">${model.summary}</span>
      `;
      btn.addEventListener("click", (e) => {
        const clearLine = "\x15";
        const command = `${clearLine}/model set ${model.id}`;
        
        // First clear existing text and send the command
        vscode.postMessage({ type: "input", data: command });
        
        // Then simulate clicking the "YES" button to press Enter
        setTimeout(() => {
          suggestionYes.click();
        }, 100);

        modelsMenu.classList.remove("show");
        e.stopPropagation();
        terminal.focus();
      });
      modelsMenu.appendChild(btn);
    });
  }

  populateModelsMenu();

  let activePermissionVal = "y\r";

  function setPermissionMode(label) {
    permissionLabel.textContent = label;
    
    // Update button color classes
    permissionBtn.classList.remove("mode-auto", "mode-full", "mode-plan");

    // Map of icons for each mode
    const iconMap = {
      "DEFAULT PERMISSION": `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 4px;"><path d="M8 0L1 3v5c0 4.4 3.1 8.5 7 10 3.9-1.5 7-5.6 7-10V3L8 0zm0 14.5c-2.8-1.2-5-4.5-5-7.5V4.2l5-2.2 5 2.2V7c0 3-2.2 6.3-5 7.5z"/></svg>`,
      "AUTO-REVIEW": `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 4px;"><path d="M1.5 8s3-5.5 6.5-5.5S14.5 8 14.5 8s-3 5.5-6.5 5.5S1.5 8 1.5 8zM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>`,
      "PLAN MODE": `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 4px;"><path d="M3 4.5h10M3 8h10M3 11.5h10M1.5 4.5h.5M1.5 8h.5M1.5 11.5h.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      "FULL ACCESS": `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 4px;"><path d="M9.5 0L3.5 8h4l-1 8L12.5 8h-4l1-8z"/></svg>`
    };

    if (permissionIcon && iconMap[label]) {
      permissionIcon.innerHTML = iconMap[label];
    }
    
    if (label === "AUTO-REVIEW") {
      permissionBtn.classList.add("mode-auto");
    } else if (label === "FULL ACCESS") {
      permissionBtn.classList.add("mode-full");
    } else if (label === "PLAN MODE") {
      permissionBtn.classList.add("mode-plan");
    }
  }

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
        case "q":
          vscode.postMessage({ type: "input", data: "/model\n" });
          return false;
      }
    }

    // Detect Ctrl+Y toggle
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "y") {
      const current = permissionLabel.textContent;
      if (current === "FULL ACCESS") {
        setPermissionMode("DEFAULT PERMISSION");
      } else {
        setPermissionMode("FULL ACCESS");
      }
      return true;
    }

    // Detect Shift+Tab cycle
    if (event.shiftKey && event.key === "Tab") {
      const current = permissionLabel.textContent;
      
      if (current === "FULL ACCESS") {
        // Match Rule: Shift+Tab while in Full Access moves to Auto Review
        setPermissionMode("AUTO-REVIEW");
      } else if (current === "DEFAULT PERMISSION") {
        setPermissionMode("AUTO-REVIEW");
      } else if (current === "AUTO-REVIEW") {
        setPermissionMode("PLAN MODE");
      } else if (current === "PLAN MODE") {
        setPermissionMode("DEFAULT PERMISSION");
      }
      return true;
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

  // Smart Click for Suggestions
  terminalElement.addEventListener("click", (event) => {
    // Only handle if mouse mode is likely on (we enable it by default now)
    const rect = terminalElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Use xterm.js internal dimensions to find row/col
    const core = terminal._core;
    if (!core || !core._renderService || !core._renderService.dimensions) return;
    
    const dims = core._renderService.dimensions;
    const col = Math.floor(x / dims.actualCellWidth);
    const row = Math.floor(y / dims.actualCellHeight);

    const buffer = terminal.buffer.active;
    const absoluteRow = buffer.viewportY + row;
    const clickedLine = buffer.getLine(absoluteRow);
    if (!clickedLine) return;

    const clickedText = clickedLine.translateToString(true);
    
    // Suggestion patterns: Starts with "  " or "> "
    // We only trigger if it looks like a suggestion list item
    const isSuggestionItem = clickedText.startsWith("  ") || clickedText.startsWith("> ");
    if (!isSuggestionItem) return;

    // Scan the viewport to see if we are currently in a suggestions list
    // Usually a suggestions list has multiple lines starting with "  " or one with "> "
    let suggestionsFound = 0;
    for (let i = 0; i < terminal.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      const text = line ? line.translateToString(true) : "";
      if (text.startsWith("  ") || text.startsWith("> ")) {
        suggestionsFound++;
      }
    }

    // Only proceed if it looks like a real list (at least 2 items or 1 active)
    if (suggestionsFound < 1) return;

    // Find the currently active suggestion (marked with ">")
    let activeRow = -1;
    for (let i = 0; i < terminal.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      if (line && line.translateToString(true).startsWith("> ")) {
        activeRow = i;
        break;
      }
    }

    if (activeRow !== -1) {
      // If we clicked the active one, just select it
      if (activeRow === row) {
        vscode.postMessage({ type: "input", data: "\r" });
        return;
      }

      const diff = row - activeRow;
      const key = diff > 0 ? "\x1b[B" : "\x1b[A"; // Down or Up
      const count = Math.abs(diff);
      
      let sequence = "";
      for (let j = 0; j < count; j++) {
        sequence += key;
      }
      sequence += "\r"; 
      vscode.postMessage({ type: "input", data: sequence });
    }
  });

  suggestionUp.addEventListener("click", (e) => {
    vscode.postMessage({ type: "input", data: "\x1b[A" });
    e.stopPropagation();
    terminal.focus();
  });

  suggestionDown.addEventListener("click", (e) => {
    vscode.postMessage({ type: "input", data: "\x1b[B" });
    e.stopPropagation();
    terminal.focus();
  });

  suggestionYes.addEventListener("click", (e) => {
    vscode.postMessage({ type: "input", data: "\r" });
    e.stopPropagation();
    terminal.focus();
  });

  addFileFooter.addEventListener("click", () => {
    vscode.postMessage({ type: "addFile" });
  });

  // Models button handler
  modelsBtn.addEventListener("click", (e) => {
    modelsMenu.classList.toggle("show");
    if (modelsMenu.classList.contains("show")) {
      // Show "Fetching..." for all models that don't have a percentage yet
      modelList.forEach(m => {
        if (m.percentage === undefined) {
          m.isFetching = true;
        }
      });
      populateModelsMenu();
      vscode.postMessage({ type: "fetchQuota" });
    }
    e.stopPropagation();
  });

  // Footer More button handler
  footerMoreBtn.addEventListener("click", (e) => {
    // If a sub-menu was already open from this menu, close it
    if (modelsMenu.classList.contains("show") || permissionMenu.classList.contains("show")) {
      modelsMenu.classList.remove("show");
      permissionMenu.classList.remove("show");
      footerMoreMenu.classList.remove("show");
    } else {
      footerMoreMenu.classList.toggle("show");
    }
    e.stopPropagation();
  });

  moreAddFile.addEventListener("click", (e) => {
    vscode.postMessage({ type: "addFile" });
    footerMoreMenu.classList.remove("show");
    e.stopPropagation();
  });

  moreModels.addEventListener("click", (e) => {
    // Open the models menu instead of the footer more menu
    footerMoreMenu.classList.remove("show");
    setTimeout(() => {
      modelsMenu.classList.add("show");
      vscode.postMessage({ type: "fetchQuota" });
    }, 50);
    e.stopPropagation();
  });

  morePermissions.addEventListener("click", (e) => {
    // Open the permission menu instead of the footer more menu
    footerMoreMenu.classList.remove("show");
    setTimeout(() => {
      permissionMenu.classList.add("show");
    }, 50);
    e.stopPropagation();
  });

  // Permission button handler - toggles the menu
  permissionBtn.addEventListener("click", (e) => {
    permissionMenu.classList.toggle("show");
    e.stopPropagation();
  });

  // Permission menu item handlers
  permissionMenu.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const targetLabel = btn.getAttribute("data-label");
      const currentLabel = permissionLabel.textContent;
      
      if (currentLabel === targetLabel) {
        permissionMenu.classList.remove("show");
        return;
      }

      const ST = "\x1b[Z"; // Shift + Tab
      const CY = "\x19";   // Ctrl + Y
      const send = (data) => vscode.postMessage({ type: "input", data: data });

      // NAVIGATION RULES:
      
      // 1. If Full Access is active
      if (currentLabel === "FULL ACCESS") {
        if (targetLabel === "AUTO-REVIEW") {
          send(ST); // Rule: Trigger Shift + Tab
        } else if (targetLabel === "PLAN MODE") {
          send(ST + ST); // Rule: Trigger Shift + Tab × 2
        } else if (targetLabel === "DEFAULT PERMISSION") {
          send(CY); // Rule: Trigger Ctrl + Y
        }
      } 
      // 2. To Full Access from any normal mode
      else if (targetLabel === "FULL ACCESS") {
        send(CY); // Trigger Ctrl + Y
      }
      // 3. Cyclic Navigation Between 3 Modes (Default -> Auto -> Plan -> Default)
      else {
        if (currentLabel === "DEFAULT PERMISSION") {
          if (targetLabel === "AUTO-REVIEW") { send(ST); } 
          else if (targetLabel === "PLAN MODE") { send(ST + ST); } 
        } else if (currentLabel === "AUTO-REVIEW") {
          if (targetLabel === "PLAN MODE") { send(ST); }
          else if (targetLabel === "DEFAULT PERMISSION") { send(ST + ST); }
        } else if (currentLabel === "PLAN MODE") {
          if (targetLabel === "DEFAULT PERMISSION") { send(ST); }
          else if (targetLabel === "AUTO-REVIEW") { send(ST + ST); }
        }
      }

      setPermissionMode(targetLabel);
      permissionMenu.classList.remove("show");
      e.stopPropagation();
      terminal.focus();
    });
  });

  function updateSuggestionControls() {
    const buffer = terminal.buffer.active;
    let suggestionsVisible = false;
    let permissionRequired = false;
    const footerLeft = document.querySelector(".footer-left");

    // Scan only the visible part of the terminal
    const startLine = Math.max(0, buffer.viewportY);
    const endLine = Math.min(buffer.length - 1, buffer.viewportY + terminal.rows);

    for (let i = startLine; i <= endLine; i++) {
      const line = buffer.getLine(i);
      const text = line ? line.translateToString(true) : "";
      
      // Check for suggestions
      if (text.trimStart().startsWith("> ")) {
        suggestionsVisible = true;
      }
      
      if (text.startsWith("  ") && text.trim().length > 0) {
        if (text.includes("[") && text.includes("]")) {
          suggestionsVisible = true;
        }
      }

      // Check for permission prompts (e.g., "Allow tool execution?", "Grant access?")
      const lowerText = text.toLowerCase();
      if (lowerText.includes("allow?") || 
          lowerText.includes("grant") || 
          lowerText.includes("authorize") ||
          lowerText.includes("permission") ||
          lowerText.includes("execute?") ||
          lowerText.includes("[y/n]")) {
        permissionRequired = true;
      }

      // SMART DETECTION: Switch button mode if CLI confirms the state change
      if (text.includes("Full access granted") || text.includes("Mode: Full Access")) {
        setPermissionMode("FULL ACCESS");
      } else if (text.includes("Plan mode enabled") || text.includes("Mode: Plan")) {
        setPermissionMode("PLAN MODE");
      } else if (text.includes("Auto-review enabled") || text.includes("Mode: Auto-review")) {
        setPermissionMode("AUTO-REVIEW");
      } else if (text.includes("Permission reset") || text.includes("Mode: Default")) {
        setPermissionMode("DEFAULT PERMISSION");
      }
    }

    if (suggestionsVisible || permissionRequired || !isBusy) {
      footerLeft.classList.add("visible");
      suggestionControls.classList.add("visible");
      
      // The permission menu button specifically only shows when permission is actually needed
      if (permissionRequired) {
        permissionDropdown.classList.add("visible");
      } else {
        permissionDropdown.classList.remove("visible");
      }
    } else {
      // If no suggestion OR prompt is found AND terminal is busy, hide the footer tools
      suggestionControls.classList.remove("visible");
      footerLeft.classList.remove("visible");
      permissionDropdown.classList.remove("visible");
    }
  }

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

  // Also check on scroll and resize
  terminal.onScroll(updateSuggestionControls);
  terminal.onResize(updateSuggestionControls);

  // Force focus to terminal when window gains focus
  window.addEventListener("focus", () => {
    if (!document.body.classList.contains("history-mode")) {
      setTimeout(() => terminal.focus(), 0);
    }
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

  function showTerminal() {
    document.body.classList.remove("history-mode");
    document.body.classList.remove("first-startup");
    setTimeout(() => {
      fitToContainer();
      terminal.focus();
    }, 100);
  }

  function showHistory() {
    document.body.classList.add("history-mode");
    showHistorySkeleton();
    vscode.postMessage({ type: "listSessions" });
  }

  newChatButton.addEventListener("click", () => {
    showTerminal();
    // Send /clear command to terminal
    vscode.postMessage({ type: "input", data: "/clear" });
    
    // Use the ENTER (formerly YES) button to execute it
    setTimeout(() => {
      suggestionYes.click();
    }, 100);
  });

  historyNewChatButton.addEventListener("click", () => {
    showTerminal();
  });

  browserButton.addEventListener("click", () => {
    vscode.postMessage({ type: "browser_switch" });
  });

  historyButton.addEventListener("click", (event) => {
    // We allow history even if busy to browse during startup
    const isShowing = historyDropdown.classList.contains("show");
    if (!isShowing) {
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

  moreBrowserButton.addEventListener("click", () => {
    browserButton.click();
    moreActionsDropdown.classList.remove("show");
  });

  moreQuotaButton.addEventListener("click", () => {
    if (isBusy) return;
    vscode.postMessage({ type: "input", data: "/model\n" });
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
    permissionMenu.classList.remove("show");
    modelsMenu.classList.remove("show");
    footerMoreMenu.classList.remove("show");
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
          if (!document.body.classList.contains("history-mode")) {
            terminal.focus();
          }
        }
        terminal.write(message.data);
        
        // Check for suggestions whenever the terminal content changes
        updateSuggestionControls();
        break;
      case "clear":
        terminal.reset();
        terminal.write("\x1bc"); // Hard reset ANSI sequence
        if (!document.body.classList.contains("history-mode")) {
          terminal.focus();
        }
        break;
      case "sessionsList":
        setLoading(false);
        populateHistory(message.sessions);
        if (isFirstLoad) {
          isFirstLoad = false;
          document.body.classList.add("history-mode");
        }
        break;
      case "quotaUpdate":
        modelList.forEach(m => m.isFetching = false);
        if (message.buckets) {
          message.buckets.forEach(bucket => {
            const usedPercentage = Math.round((1 - bucket.remainingFraction) * 100);
            
            modelList.forEach(model => {
              const mId = model.id.toLowerCase();
              const bId = bucket.modelId.toLowerCase();

              // Exact match or tier match
              if (mId === bId || 
                  (bId.includes("pro") && mId.includes("pro")) ||
                  (bId.includes("flash") && !bId.includes("lite") && mId.includes("flash") && !mId.includes("lite")) ||
                  (bId.includes("lite") && mId.includes("lite"))) {
                model.percentage = usedPercentage;
                model.remainingFraction = bucket.remainingFraction;
                model.resetTime = bucket.resetTime; // Store reset time if available
              }
            });
          });
        }
        populateModelsMenu();
        populateHistoryQuotas();
        break;
      case "exit":
        setLoading(false);
        setStatus(`Gemini CLI exited (${formatExit(message)})`);
        break;
      case "focus":
        if (!document.body.classList.contains("history-mode")) {
          terminal.focus();
        }
        break;
    }
  });

  function populateHistory(sessions) {
    populateHistoryDropdown(sessions);
    populateHistoryFull(sessions);
  }

  function populateHistoryQuotas() {
    quotaRows.innerHTML = "";
    
    // We only want to show exactly 3 tiers: Pro, Flash, Flash Lite
    const uniqueTiers = new Map();
    
    modelList.forEach(m => {
      if (m.remainingFraction === undefined) return;
      const name = m.name.toLowerCase();
      let tier = null;
      if (name.includes("pro")) tier = "Pro";
      else if (name.includes("lite")) tier = "Flash Lite";
      else if (name.includes("flash")) tier = "Flash";
      
      if (tier && !uniqueTiers.has(tier)) {
        uniqueTiers.set(tier, {
          name: tier,
          remainingFraction: m.remainingFraction,
          resetTime: m.resetTime
        });
      }
    });

    const activeQuotas = Array.from(uniqueTiers.values());
    
    if (activeQuotas.length === 0) {
      document.getElementById("historyQuotas").style.display = "none";
      return;
    }
    document.getElementById("historyQuotas").style.display = "block";

    // Custom sorting: Flash, Flash Lite, Pro
    activeQuotas.sort((a, b) => {
      const order = { "Flash": 1, "Flash Lite": 2, "Pro": 3 };
      return (order[a.name] || 99) - (order[b.name] || 99);
    });

    activeQuotas.forEach(model => {
      const remaining = Math.round(model.remainingFraction * 100);
      const row = document.createElement("div");
      row.className = "quota-row";
      
      let statusClass = "";
      if (remaining <= 10) statusClass = "low";
      else if (remaining <= 30) statusClass = "medium";

      let shortName = model.name;

      const resetText = formatResetTime(model.resetTime); 
      const barChars = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";
      
      row.innerHTML = `
        <span class="model-name">${shortName}</span>
        <div class="bar-container">
          <div class="bar-background">${barChars}</div>
          <div class="bar-fill-container ${statusClass}" style="width: ${remaining}%">
            <div class="bar-fill">${barChars}</div>
          </div>
        </div>
        <span class="percentage">${remaining}%</span>
        <span class="reset-info">${resetText}</span>
      `;
      quotaRows.appendChild(row);
    });
  }

  function formatResetTime(resetTimeStr) {
    if (!resetTimeStr) return "Resets: ~24h";
    try {
      const resetDate = new Date(resetTimeStr);
      const now = new Date();
      const diffMs = resetDate.getTime() - now.getTime();
      if (diffMs <= 0) return "Resets: soon";
      
      const timeStr = resetDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      
      return `Resets: ${timeStr} (${hours}h ${minutes}m)`;
    } catch (e) {
      return "Resets: ~24h";
    }
  }

  function populateHistoryDropdown(sessions) {
    historyListDropdown.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      historyListDropdown.innerHTML = '<div class="info-message">No history found.</div>';
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
        if (cooldownActive) return;
        
        setLoading(true);
        cooldownActive = true;
        setStatus("Resuming Session...");
        showTerminal();
        vscode.postMessage({ type: "resumeSession", id: session.id });
        historyDropdown.classList.remove("show");

        setTimeout(() => {
          cooldownActive = false;
        }, ACTION_COOLDOWN_MS);
      });
      historyListDropdown.appendChild(btn);
    });
  }

  function populateHistoryFull(sessions) {
    historyListFull.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      historyListFull.innerHTML = '<div class="info-message">No sessions available. Start a new chat!</div>';
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
        if (cooldownActive) return;
        
        setLoading(true);
        cooldownActive = true;
        setStatus("Resuming Session...");
        showTerminal();
        vscode.postMessage({ type: "resumeSession", id: session.id });

        setTimeout(() => {
          cooldownActive = false;
        }, ACTION_COOLDOWN_MS);
      });
      historyListFull.appendChild(btn);
    });
  }

  function showHistorySkeleton() {
    historyListDropdown.innerHTML = "";
    historyListFull.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const item = document.createElement("div");
      item.className = "skeleton-item";
      item.innerHTML = `
        <div class="skeleton-line label"></div>
        <div class="skeleton-line desc"></div>
      `;
      const itemClone = item.cloneNode(true);
      historyListDropdown.appendChild(item);
      historyListFull.appendChild(itemClone);
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
      setTimeout(() => {
        if (!document.body.classList.contains("history-mode")) {
          terminal.focus();
          updateSuggestionControls();
        }
      }, 0);
    }
  }

  function formatExit(message) {
    if (message.signal) {
      return `signal ${message.signal}`;
    }

    return `code ${message.exitCode}`;
  }
})();
