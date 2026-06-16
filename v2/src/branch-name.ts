import type { ProjectBranchNamingConfig } from "./types.js";

export function isPlausibleGitRef(token: string): boolean {
  if (!token) return false;
  if (/\s/.test(token)) return false;
  for (const ch of token) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (/[~^:?*[\\]/.test(token)) return false;
  if (token.startsWith("/") || token.endsWith("/")) return false;
  if (token.includes("..")) return false;
  if (token.includes("@{")) return false;
  if (token.endsWith(".lock")) return false;
  return true;
}

export function compileBranchNamingRegex(regex: string, label: string): RegExp {
  try {
    return new RegExp(regex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}.regex must be a valid JavaScript regular expression: ${message}`, {
      cause: error,
    });
  }
}

export function assertBranchNameMatches(
  branch: string,
  branchNaming: ProjectBranchNamingConfig | undefined,
  label: string,
): void {
  if (!branchNaming) return;
  if (!compileBranchNamingRegex(branchNaming.regex, "branchNaming").test(branch)) {
    throw new Error(`${label} "${branch}" must match ${branchNaming.regex}`);
  }
}
