// Mirrored in v2/src/releases-cache.ts and v2/scripts/install-and-restart.sh.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;

export type ReleaseChannel = "stable" | "alpha";

export function releaseChannel(version: string): ReleaseChannel {
  return version.includes("-alpha.") ? "alpha" : "stable";
}

// Prerelease precedence: 1.2.3-alpha.N < 1.2.3; alpha.2 < alpha.10.
// Stable gets MAX_SAFE_INTEGER as its alpha rank so it sorts above any alpha.
function parseStrictSemver(value: string): [number, number, number, number] | null {
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  const [, major, minor, patch, alpha] = match;
  return [
    Number.parseInt(major ?? "0", 10),
    Number.parseInt(minor ?? "0", 10),
    Number.parseInt(patch ?? "0", 10),
    alpha === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(alpha, 10),
  ];
}

export function semverGt(a: string, b: string): boolean {
  const left = parseStrictSemver(a);
  const right = parseStrictSemver(b);
  if (!left || !right) return false;
  for (let i = 0; i < 4; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}
