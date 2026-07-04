export type ReleaseEntry = { tag: string; publishedAt: string };
export type ReleasesResult = { entries: ReleaseEntry[]; stale: boolean; error: string | null };

const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
let cache: { value: ReleaseEntry[]; expiresAt: number } | null = null;

const REGISTRY_URL = "https://registry.npmjs.org/@ashugaev%2fspur";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
// Versions below this floor are pre-release name reservations without a runtime.
const MIN_VERSION = "0.1.0";

function isReleaseVersion(v: string): boolean {
  return SEMVER_RE.test(v) && compareSemverDesc(v, MIN_VERSION) <= 0;
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

export async function getReleases(now: number = Date.now()): Promise<ReleasesResult> {
  if (cache && cache.expiresAt > now) return { entries: cache.value, stale: false, error: null };
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
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
    return { entries, stale: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cache) return { entries: cache.value, stale: true, error: message };
    return { entries: [], stale: false, error: message };
  }
}

export function __resetReleasesCacheForTest(): void {
  cache = null;
}
