import { realpath } from "node:fs/promises";

export async function resolveWorktreePathCandidates(worktreePath: string): Promise<string[]> {
  const candidates = [worktreePath];
  try {
    const canonicalPath = await realpath(worktreePath);
    if (!candidates.includes(canonicalPath)) {
      candidates.push(canonicalPath);
    }
  } catch {
    // Fall back to the original path when canonicalization fails.
  }
  return candidates;
}
