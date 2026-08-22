export type ReleaseEntry = { tag: string; publishedAt: string };
export type ReleasesResult = { entries: ReleaseEntry[]; stale: boolean; error: string | null };

const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
let cache: { value: ReleaseEntry[]; expiresAt: number } | null = null;

const REGISTRY_URL = "https://registry.npmjs.org/@shugaev%2fspur";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isReleaseVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

function isDeprecated(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  // npm keeps the key with an empty string after undeprecation.
  const deprecated = (meta as { deprecated?: unknown }).deprecated;
  return typeof deprecated === "string" && deprecated !== "";
}

// Exported for auto-update.ts: reused as the "strictly newer" test rather
// than writing a second semver comparator. Non-release strings (e.g. a
// git-describe version from a source checkout) parse every component to
// NaN via Number.parseInt, and every NaN comparison is false — the "strictly
// newer" test then fails closed, which is intended, not accidental.
export function compareSemverDesc(a: string, b: string): number {
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
    const versionDocs = doc.versions ?? {};
    const times = doc.time ?? {};
    const entries: ReleaseEntry[] = Object.keys(versionDocs)
      .filter((v) => isReleaseVersion(v))
      .filter((v) => !isDeprecated(versionDocs[v]))
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
