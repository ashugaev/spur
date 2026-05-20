export interface PlatformStatusOk {
  ok: true;
  requestedAt: string;
}

export interface PlatformStatusError {
  ok: false;
  error: string;
  requestedAt: string | null;
}

export type PlatformStatusResponse = PlatformStatusOk | PlatformStatusError;

export interface PlatformStatusCacheEntry {
  response: PlatformStatusResponse;
  expiresAt: number;
}

const cachedStatuses = new Map<string, PlatformStatusCacheEntry>();

export function readPlatformStatusCache(key: string): PlatformStatusCacheEntry | null {
  return cachedStatuses.get(key) ?? null;
}

export function writePlatformStatusCache(key: string, entry: PlatformStatusCacheEntry): void {
  cachedStatuses.set(key, entry);
}

export function resetPlatformStatusCacheForTests(): void {
  cachedStatuses.clear();
}
