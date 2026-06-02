const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function parseStrictSemver(value: string): [number, number, number] | null {
  if (!SEMVER_RE.test(value)) return null;
  const parts = value.split(".").map((n) => Number.parseInt(n, 10));
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return null;
  }
  return [major, minor, patch];
}

export function semverGt(a: string, b: string): boolean {
  const left = parseStrictSemver(a);
  const right = parseStrictSemver(b);
  if (!left || !right) return false;
  if (left[0] !== right[0]) return left[0] > right[0];
  if (left[1] !== right[1]) return left[1] > right[1];
  return left[2] > right[2];
}
