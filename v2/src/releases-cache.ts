export type ReleaseChannel = "stable" | "alpha";
export type ReleaseEntry = { tag: string; publishedAt: string; channel: ReleaseChannel };
export type ReleasesResult = { entries: ReleaseEntry[]; stale: boolean; error: string | null };

const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
let cache: { value: ReleaseEntry[]; expiresAt: number } | null = null;

const REGISTRY_URL = "https://registry.npmjs.org/@shugaev%2fspur";
// Mirrored in scripts/install-and-restart.sh and packages/web/src/lib/semver.ts.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;

export function isReleaseVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

export function releaseChannel(v: string): ReleaseChannel {
  return v.includes("-alpha.") ? "alpha" : "stable";
}

function isDeprecated(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  // npm keeps the key with an empty string after undeprecation.
  const deprecated = (meta as { deprecated?: unknown }).deprecated;
  return typeof deprecated === "string" && deprecated !== "";
}

// Prerelease precedence: 1.2.3-alpha.N < 1.2.3; alpha.2 < alpha.10.
// Stable gets MAX_SAFE_INTEGER as its alpha rank so it sorts above any alpha.
function parseVersion(s: string): [number, number, number, number] {
  const match = SEMVER_RE.exec(s);
  if (!match) return [0, 0, 0, 0];
  const [, maj, min, patch, alpha] = match;
  return [
    Number.parseInt(maj ?? "0", 10),
    Number.parseInt(min ?? "0", 10),
    Number.parseInt(patch ?? "0", 10),
    alpha === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(alpha, 10),
  ];
}

function compareSemverDesc(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 4; i += 1) {
    const delta = (bv[i] ?? 0) - (av[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
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
      .map((v) => ({ tag: v, publishedAt: times[v] as string, channel: releaseChannel(v) }));
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
