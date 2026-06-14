import type { ProjectBranchNamingConfig } from "./types.js";

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
