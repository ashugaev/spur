import { readFileSync } from "node:fs";

const MANAGED_PLACEHOLDER = "0.0.0-managed";

function readPackageVersion(url: URL): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// npm installs carry the release version in the package's own package.json
// (written by semantic-release before pack). Source checkouts keep the managed
// placeholder there; fall back to the repo root package.json so a git-deployed
// daemon still reports a meaningful version.
const packageVersion = readPackageVersion(new URL("../package.json", import.meta.url));
export const version =
  packageVersion && packageVersion !== MANAGED_PLACEHOLDER
    ? packageVersion
    : (readPackageVersion(new URL("../../package.json", import.meta.url)) ?? "0.0.0-dev");
