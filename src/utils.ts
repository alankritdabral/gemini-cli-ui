import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export function getNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return nonce;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    if ((error as any).cause) {
      const cause = (error as any).cause;
      return `${error.message} (Cause: ${cause instanceof Error ? cause.message : String(cause)})`;
    }
    return error.message;
  }

  return String(error);
}

export function executableName(command: string): string {
  return process.platform === "win32" ? `${command}.exe` : command;
}

export async function syncExtensionAgents(context: vscode.ExtensionContext) {
  try {
    const extensionAgentsPath = path.join(context.extensionPath, ".gemini", "agents");
    
    // Check if the extension has a .gemini/agents directory
    if (!fs.existsSync(extensionAgentsPath)) {
      return;
    }

    const stat = await fs.promises.stat(extensionAgentsPath);
    if (!stat.isDirectory()) {
      return;
    }

    const homeDir = os.homedir();
    const globalAgentsPath = path.join(homeDir, ".gemini", "agents");

    // Ensure global agents directory exists
    if (!fs.existsSync(globalAgentsPath)) {
      await fs.promises.mkdir(globalAgentsPath, { recursive: true });
    }

    // Read all files from extension agents path
    const files = await fs.promises.readdir(extensionAgentsPath);
    let copiedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.md')) {
        continue; // Only copy markdown files
      }

      const sourceFile = path.join(extensionAgentsPath, file);
      const targetFile = path.join(globalAgentsPath, file);

      // Copy file, optionally overriding existing ones, but typically we want to update it
      // if the extension version is newer, or just overwrite it
      await fs.promises.copyFile(sourceFile, targetFile);
      copiedCount++;
    }

    if (copiedCount > 0) {
      console.log(`Synced ${copiedCount} pre-installed agents to global .gemini/agents`);
    }
  } catch (error) {
    console.error("Failed to sync pre-installed agents:", error);
  }
}
