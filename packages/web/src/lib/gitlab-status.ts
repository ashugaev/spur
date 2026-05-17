import {
  readPlatformStatusCache,
  type PlatformStatusCacheEntry,
  type PlatformStatusResponse,
  resetPlatformStatusCacheForTests,
  writePlatformStatusCache,
} from "@/lib/platform-status";

const CACHE_KEY = "gitlab";

export type GitLabStatusResponse = PlatformStatusResponse;
export type GitLabStatusCacheEntry = PlatformStatusCacheEntry;

export function readGitLabStatusCache(): GitLabStatusCacheEntry | null {
  return readPlatformStatusCache(CACHE_KEY);
}

export function writeGitLabStatusCache(entry: GitLabStatusCacheEntry): void {
  writePlatformStatusCache(CACHE_KEY, entry);
}

export function resetGitLabStatusForTests(): void {
  resetPlatformStatusCacheForTests();
}
