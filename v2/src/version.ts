import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANAGED_PLACEHOLDER = "0.0.0-managed";

function readPackageVersion(url: URL): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// The repo root package.json is a private workspace manifest semantic-release
// never touches -- its version has stayed "0.1.0" (the very first tag) since
// the file was created, so using it as a fallback always reported that same
// stale number for any git-deployed/source-run daemon. Describe HEAD against
// the real release tags instead: exact match on a release commit, or
// "<tag>-<commits>-g<sha>" past one, which self-evidently isn't a published
// version. --always covers a checkout with no release tags fetched at all.
export function readGitDescribedVersion(repoRoot: URL): string | undefined {
  try {
    const described = execFileSync(
      "git",
      ["describe", "--tags", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--always"],
      { cwd: fileURLToPath(repoRoot), stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    return described.length > 0 ? described.replace(/^v(?=\d)/, "") : undefined;
  } catch {
    return undefined;
  }
}

// Lazy and memoized so importing this module never spawns `git` as a side
// effect -- only the first caller that actually reads the version pays for
// it, and callers that never need it (most module graphs just import other
// exports from a file that happens to also import this one) don't.
let cachedVersion: string | undefined;
export function getVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const packageVersion = readPackageVersion(new URL("../package.json", import.meta.url));
  cachedVersion =
    packageVersion && packageVersion !== MANAGED_PLACEHOLDER
      ? packageVersion
      : (readGitDescribedVersion(new URL("../../", import.meta.url)) ?? "0.0.0-dev");
  return cachedVersion;
}
