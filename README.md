# Gemini CLI UI

Gemini CLI UI is a VS Code extension that brings the power of the [Gemini CLI](https://github.com/google/gemini-cli) directly into your editor. It provides a real PTY-backed terminal experience within a dedicated sidebar chat or a full editor panel.

![Gemini CLI UI](media/gemini-cli-ui.jpg)

## Features

- **Sidebar Chat View**: Access the Gemini CLI from a convenient sidebar, allowing you to chat without leaving your code.
- **Gemini Browser**: A native, in-app browser for previewing your web applications directly inside VS Code.
- **Element Inspector (Cursor Style)**: Click UI components in the Gemini Browser to automatically send their HTML and URL context to the AI chat.
- **PTY-Backed Terminal**: Uses `node-pty` and `xterm.js` for an authentic terminal experience, supporting interactive commands and full-color output.
- **Smart Node.js Detection**: Automatically finds the best Node.js version on your system (supporting NVM, Volta, fnm, etc.) to run the CLI.
- **Cross-Platform**: Works on Windows (PowerShell), macOS, and Linux (Bash).
- **Responsive Design**: UI scales perfectly for both the sidebar and full editor views.

## Requirements

- **Node.js**: Version 20 or higher.
- **Gemini CLI**: The extension will automatically try to use your global `gemini` installation or run it via `npx @google/gemini-cli`.

## Installation

1. Open VS Code.
2. Go to the Extensions view (`Ctrl+Shift+X`).
3. Search for `Gemini CLI UI` (or install from VSIX).
4. Click Install.

## Usage

### Sidebar Chat
1. Click on the **Gemini** icon in the Activity Bar.
2. The Gemini CLI will automatically start.
3. Type your prompts and interact with the CLI as you would in a normal terminal.

### Editor Terminal
1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run the command **Gemini: Open Gemini CLI UI**.
3. A new editor tab will open with the Gemini terminal.

### Gemini Browser
1. Click the **Browser** button in the Gemini Sidebar (next to History).
2. Enter your application URL (e.g., `localhost:3000`) and click **Go**.
3. Click the **🔍 (Inspect)** icon to enter Selection Mode.
4. Click any element on the page to send its code and URL context directly to the Gemini AI.

## Development

If you want to contribute or build the extension from source:

### Setup
```bash
# Install dependencies
npm install
```

### Build
```bash
# Compile the extension
npm run compile

# Watch for changes
npm run watch
```

### Run
1. Press `F5` in VS Code to open a new window with the extension loaded.
2. Run your commands in the [Extension Development Host] window.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
