import {
  readPlatformStatusCache,
  type PlatformStatusCacheEntry,
  type PlatformStatusResponse,
  resetPlatformStatusCacheForTests,
  writePlatformStatusCache,
} from "@/lib/platform-status";

const CACHE_KEY = "github";

export type GitHubStatusResponse = PlatformStatusResponse;
export type GitHubStatusCacheEntry = PlatformStatusCacheEntry;

export function readGitHubStatusCache(): GitHubStatusCacheEntry | null {
  return readPlatformStatusCache(CACHE_KEY);
}

export function writeGitHubStatusCache(entry: GitHubStatusCacheEntry): void {
  writePlatformStatusCache(CACHE_KEY, entry);
}

export function resetGitHubStatusForTests(): void {
  resetPlatformStatusCacheForTests();
}
