import { version as currentVersion } from "./version.js";

export type ReleaseEntry = { tag: string; publishedAt: string };

type CacheBox = { value: ReleaseEntry[]; expiresAt: number } | null;
const TTL_MS = 10 * 60 * 1000;
let cache: CacheBox = null;

const REGISTRY_URL = "https://registry.npmjs.org/spur";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function isReleaseVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

function compareSemverDesc(a: string, b: string): number {
  const parse = (s: string): [number, number, number] => {
    const parts = s.split(".").map((n) => Number.parseInt(n, 10));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return bMaj - aMaj;
  if (aMin !== bMin) return bMin - aMin;
  return bPatch - aPatch;
}

function isRegistryDoc(
  value: unknown,
): value is { versions?: Record<string, unknown>; time?: Record<string, unknown> } {
  return typeof value === "object" && value !== null;
}

export async function getReleases(now: number = Date.now()): Promise<ReleaseEntry[]> {
  if (cache && cache.expiresAt > now) return cache.value;
  try {
    const res = await fetch(REGISTRY_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const doc: unknown = await res.json();
    if (!isRegistryDoc(doc)) throw new Error("registry response is not an object");
    const versions = Object.keys(doc.versions ?? {});
    const times = doc.time ?? {};
    const entries: ReleaseEntry[] = versions
      .filter((v) => isReleaseVersion(v))
      .filter((v) => typeof times[v] === "string")
      .sort(compareSemverDesc)
      .map((v) => ({ tag: v, publishedAt: times[v] as string }));
    cache = { value: entries, expiresAt: now + TTL_MS };
    return entries;
  } catch {
    if (cache) return cache.value;
    return [];
  }
}

export function __resetReleasesCacheForTest(): void {
  cache = null;
}

export function getCurrentVersion(): string {
  return currentVersion;
}
