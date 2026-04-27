import * as fs from "node:fs";
import * as path from "node:path";
import type * as NodePty from "node-pty";
import { formatError } from "../utils";
import { getPreferredNodePathEntries } from "./node";

export function loadNodePty(): typeof NodePty {
  const errors: string[] = [];

  try {
    return require("node-pty") as typeof NodePty;
  } catch (error) {
    errors.push(`extension dependency: ${formatError(error)}`);
  }

  for (const candidate of getBundledNodePtyCandidates()) {
    try {
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        return require(candidate) as typeof NodePty;
      }
    } catch (error) {
      errors.push(`${candidate}: ${formatError(error)}`);
    }
  }

  throw new Error(errors.join("\n"));
}

function getBundledNodePtyCandidates(): string[] {
  const candidates = new Set<string>();
  const resourcesPath = getElectronResourcesPath();

  if (resourcesPath) {
    candidates.add(path.join(resourcesPath, "app", "node_modules", "node-pty"));
  }

  candidates.add(path.join(path.dirname(process.execPath), "resources", "app", "node_modules", "node-pty"));

  if (process.env.SNAP) {
    candidates.add(path.join(process.env.SNAP, "usr", "share", "code", "resources", "app", "node_modules", "node-pty"));
  }

  return [...candidates];
}

function getElectronResourcesPath(): string | undefined {
  const maybeProcess = process as NodeJS.Process & { resourcesPath?: string };
  return maybeProcess.resourcesPath;
}

export function getTerminalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || shouldStripEnvironmentVariable(key)) {
      continue;
    }

    env[key] = value;
  }

  env.PATH = buildTerminalPath(env);
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "1";
  env.TERM = "xterm-256color";

  return env;
}

function shouldStripEnvironmentVariable(key: string): boolean {
  return key === "ELECTRON_RUN_AS_NODE"
    || key === "ELECTRON_NO_ATTACH_CONSOLE"
    || key === "VSCODE_CLI"
    || key === "VSCODE_ESM_ENTRYPOINT"
    || key === "VSCODE_HANDLES_UNCAUGHT_ERRORS"
    || key === "VSCODE_CRASH_REPORTER_PROCESS_TYPE"
    || key === "VSCODE_CODE_CACHE_PATH";
}

function buildTerminalPath(env: NodeJS.ProcessEnv): string {
  const delimiter = path.delimiter;
  const pathEntries = new Set<string>();

  for (const entry of getPreferredNodePathEntries(env)) {
    pathEntries.add(entry);
  }

  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry) {
      pathEntries.add(entry);
    }
  }

  return [...pathEntries].join(delimiter);
}

export function getShellLaunchCommand(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "if (Get-Command gemini -ErrorAction SilentlyContinue) { gemini } else { npx -y @google/gemini-cli }"
      ]
    };
  }

  const shell = "/bin/bash";

  return {
    file: shell,
    args: [
      "-lc",
      [
        "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"",
        "if [ -s \"$NVM_DIR/nvm.sh\" ]; then",
        "  . \"$NVM_DIR/nvm.sh\"",
        "  nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true",
        "fi",
        "if command -v gemini >/dev/null 2>&1; then",
        "  exec gemini",
        "fi",
        "exec npx -y @google/gemini-cli"
      ].join("\n")
    ]
  };
}
