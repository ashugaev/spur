/**
 * Parse the WEB_HOST env var into the set of interfaces the web server binds.
 *
 * Comma-separated list, e.g. `127.0.0.1,100.64.0.1` binds loopback plus a
 * Tailscale IP. `0.0.0.0` is a wildcard bind: it supersedes every other
 * entry (binding both `0.0.0.0` and a specific host on the same port throws
 * EADDRINUSE), so any list containing it collapses to just `["0.0.0.0"]`.
 */
export function parseWebHosts(value: string | undefined, fallback: string): string[] {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  if (hosts.length === 0) {
    return [fallback];
  }

  if (hosts.includes("0.0.0.0")) {
    return ["0.0.0.0"];
  }

  const deduped: string[] = [];
  for (const host of hosts) {
    if (!deduped.includes(host)) {
      deduped.push(host);
    }
  }
  return deduped;
}
