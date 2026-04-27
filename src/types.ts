import type * as vscode from "vscode";

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "restart" };

export type PtySessionOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
};

export type ParsedVersion = { major: number; minor: number; patch: number };

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
