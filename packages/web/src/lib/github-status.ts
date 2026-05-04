export interface GitHubStatusOk {
  ok: true;
  requestedAt: string;
}

export interface GitHubStatusError {
  ok: false;
  error: string;
  requestedAt: string | null;
}

export type GitHubStatusResponse = GitHubStatusOk | GitHubStatusError;

export interface GitHubStatusCacheEntry {
  response: GitHubStatusResponse;
  expiresAt: number;
}

let cachedStatus: GitHubStatusCacheEntry | null = null;

export function readGitHubStatusCache(): GitHubStatusCacheEntry | null {
  return cachedStatus;
}

export function writeGitHubStatusCache(entry: GitHubStatusCacheEntry): void {
  cachedStatus = entry;
}

export function resetGitHubStatusForTests(): void {
  cachedStatus = null;
}
