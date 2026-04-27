import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ParsedVersion } from "../types";
import { executableName } from "../utils";

export function parseNodeVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);

  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function compareParsedVersions(
  left: ParsedVersion,
  right: ParsedVersion
): number {
  return left.major - right.major
    || left.minor - right.minor
    || left.patch - right.patch;
}

export function getPreferredNodePathEntries(env: NodeJS.ProcessEnv): string[] {
  const entries: string[] = [];

  if (env.NVM_BIN && fs.existsSync(env.NVM_BIN)) {
    entries.push(env.NVM_BIN);
  }

  const nvmDir = env.NVM_DIR ?? path.join(os.homedir(), ".nvm");
  const nvmNodeVersionsDir = path.join(nvmDir, "versions", "node");

  try {
    const newestNodeBin = fs.readdirSync(nvmNodeVersionsDir)
      .map((version: string) => ({
        version,
        parsed: parseNodeVersion(version),
        binPath: path.join(nvmNodeVersionsDir, version, "bin")
      }))
      .filter((item): item is { version: string; parsed: ParsedVersion; binPath: string } =>
        !!item.parsed && item.parsed.major >= 20 && fs.existsSync(path.join(item.binPath, executableName("node")))
      )
      .sort((left, right) => compareParsedVersions(right.parsed, left.parsed))[0]?.binPath;

    if (newestNodeBin) {
      entries.push(newestNodeBin);
    }
  } catch {
    // Other node managers or system Node may still be available on PATH.
  }

  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".volta", "bin"),
    path.join(home, ".local", "share", "fnm"),
    path.join(home, ".asdf", "shims")
  ]) {
    if (fs.existsSync(candidate)) {
      entries.push(candidate);
    }
  }

  return entries;
}
