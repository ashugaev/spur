import type { ProjectBranchNamingConfig } from "./types.js";

export function normalizeBranchName(input: string): string {
  // Slugify per path component so the result is a valid git ref: collapse
  // illegal-char runs, then clean each "/"-separated component independently
  // (empty components, leading dots, and trailing .lock are all git-illegal).
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9./-]+/g, "-")
    .split("/")
    .map((segment) =>
      segment
        .replace(/-{2,}/g, "-")
        .replace(/\.{2,}/g, ".")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/(\.lock)+$/, "")
        .replace(/[-.]+$/g, ""),
    )
    .filter((segment) => segment.length > 0)
    .join("/");
}

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

export function matchesBranchNaming(
  branch: string,
  branchNaming: ProjectBranchNamingConfig | undefined,
): boolean {
  if (!branchNaming) return true;
  return compileBranchNamingRegex(branchNaming.regex, "branchNaming").test(branch);
}
