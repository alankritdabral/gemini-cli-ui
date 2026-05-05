import type * as vscode from "vscode";

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "restart" }
  | { type: "newChat" }
  | { type: "listSessions" }
  | { type: "resumeSession"; id: string }
  | { type: "addFile" }
  | { type: "filesDropped"; files: { path: string; name: string }[] }
  | { type: "browser_switch" }
  | { type: "browser_inspect_mode"; enabled: boolean }
  | { type: "browser_navigate"; url: string }
  | { type: "browser_refresh" }
  | { type: "browser_back" }
  | { type: "browser_forward" }
  | { type: "browser_toggle_playwright"; enabled: boolean }
  | { type: "browser_element_selected"; context: string; url?: string };

export type ExtensionToBrowserMessage =
  | { type: "browser_load"; url: string }
  | { type: "browser_click"; selector: string }
  | { type: "browser_type"; selector: string; text: string }
  | { type: "browser_inspect_mode"; enabled: boolean };

export type PtySessionOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
};

export type ParsedVersion = { major: number; minor: number; patch: number };

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
