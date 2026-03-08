import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function formatDashboardUrl(host: string, port: number): string {
  const normalizedHost =
    host.includes(":") && !host.startsWith("[") && !host.endsWith("]")
      ? `[${host}]`
      : host;
  return `http://${normalizedHost}:${port}`;
}

function parseTailscaleWebHost(hostWithPort: string): string {
  const idx = hostWithPort.lastIndexOf(":");
  if (idx <= 0) return hostWithPort;
  return hostWithPort.slice(0, idx);
}

function proxyMatchesLocalPort(proxy: string, port: number): boolean {
  try {
    const parsed = new URL(proxy);
    const host = parsed.hostname.toLowerCase();
    const targetPort = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    return (host === "127.0.0.1" || host === "localhost") && targetPort === port;
  } catch {
    return false;
  }
}

/**
 * Get the Tailscale IPv4 address of this machine.
 * Returns null if Tailscale is not installed or not running.
 */
export async function getTailscaleIp(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["ip", "-4"], {
      timeout: 5_000,
    });
    const ip = stdout.trim().split("\n")[0]?.trim();
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/**
 * Get the Tailscale MagicDNS hostname (e.g. "my-mac.tail123.ts.net").
 * Returns null if unavailable.
 */
export async function getTailscaleDnsName(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 5_000,
    });
    const parsed = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const dnsName = parsed.Self?.DNSName?.trim();
    if (!dnsName) return null;
    return dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
  } catch {
    return null;
  }
}

/**
 * Get HTTPS URL from `tailscale serve` config when root path proxies to the given local port.
 */
export async function getTailscaleServeUrl(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], {
      timeout: 5_000,
    });
    const parsed = JSON.parse(stdout) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };
    const entries = Object.entries(parsed.Web ?? {});
    for (const [hostPort, webConfig] of entries) {
      const proxy = webConfig.Handlers?.["/"]?.Proxy;
      if (!proxy || !proxyMatchesLocalPort(proxy, port)) continue;
      const host = parseTailscaleWebHost(hostPort);
      if (!host) continue;
      return `https://${host}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Get the macOS Bonjour local hostname (e.g. "My-MacBook-Pro.local").
 * Stable across IP changes on the same LAN. Falls back to os.hostname().
 */
export async function getLocalHostname(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("scutil", ["--get", "LocalHostName"], {
      timeout: 5_000,
    });
    const name = stdout.trim();
    if (name) return `${name}.local`;
  } catch {
    // scutil not available (non-macOS) — fall through
  }
  return hostname();
}

/**
 * Build the remote dashboard URL.
 * Priority: explicit config host > Tailscale MagicDNS > Tailscale IP > macOS .local hostname.
 */
export async function getDashboardUrl(
  port: number,
  tailscaleHost?: string,
): Promise<string | null> {
  const configuredHost = tailscaleHost?.trim();
  if (configuredHost && configuredHost !== "auto") {
    if (/^https?:\/\//i.test(configuredHost)) return configuredHost;
    return formatDashboardUrl(configuredHost, port);
  }
  const serveUrl = await getTailscaleServeUrl(port);
  if (serveUrl) return serveUrl;
  const dnsName = await getTailscaleDnsName();
  if (dnsName) return formatDashboardUrl(dnsName, port);
  const tsIp = await getTailscaleIp();
  if (tsIp) return formatDashboardUrl(tsIp, port);
  const localHost = await getLocalHostname();
  return formatDashboardUrl(localHost, port);
}
