import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
 * Build the remote dashboard URL using Tailscale IP.
 * Uses explicit host from config if provided, otherwise auto-detects.
 */
export async function getDashboardUrl(
  port: number,
  tailscaleHost?: string,
): Promise<string | null> {
  const host =
    tailscaleHost && tailscaleHost !== "auto"
      ? tailscaleHost
      : await getTailscaleIp();
  if (!host) return null;
  return `http://${host}:${port}`;
}
