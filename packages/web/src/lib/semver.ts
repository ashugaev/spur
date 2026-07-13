const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function parseStrictSemver(value: string): [number, number, number] | null {
  if (!SEMVER_RE.test(value)) return null;
  const [major, minor, patch] = value.split(".").map((n) => Number.parseInt(n, 10));
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

export type UpdateSeverity = "none" | "update" | "major";

export function updateSeverity(latest: string, current: string): UpdateSeverity {
  const newer = parseStrictSemver(latest);
  const installed = parseStrictSemver(current);
  if (!newer || !installed) return "none";
  if (newer[0] !== installed[0]) return newer[0] > installed[0] ? "major" : "none";
  if (newer[1] !== installed[1]) return newer[1] > installed[1] ? "update" : "none";
  return newer[2] > installed[2] ? "update" : "none";
}
