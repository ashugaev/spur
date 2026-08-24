// Default ports, kept in a dependency-free leaf module so both the config
// loader and the systemd/unit health code read the same number without an
// import cycle (`update-health.ts` already imports `config.ts` for
// `loadConfig`) and without every `vi.mock("../../src/config.js")` factory
// having to re-export them.
//
// `ui.port` is the web UI's listen port: `spur-web.service` carries it as
// `Environment=PORT`, and `web-server.ts` falls back to the config value when
// that env is absent. Same number in both places or `spur doctor` reports
// `web-ui-port-drift`.
export const DEFAULT_UI_PORT = 5555;

/**
 * Resolves the web UI base URL a source module posts to (voice transcription
 * today). `SPUR_WEB_URL` set and non-empty wins outright (non-loopback
 * `WEB_HOST` binds, or an isolated daemon whose web sidecar port is resolved
 * later by a different process). `SPUR_WEB_URL` set and empty disables the
 * feature for this instance (`null`) — this is how
 * `scripts/spur-isolated-daemon.sh` keeps an isolated daemon from ever
 * reaching the host's production web UI on the default port. Unset falls
 * back to `http://127.0.0.1:<uiPort>`.
 */
export function resolveWebBaseUrl(
  uiPort: number,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env["SPUR_WEB_URL"];
  if (override !== undefined) {
    if (override === "") return null;
    return override.replace(/\/+$/, "");
  }
  return `http://127.0.0.1:${uiPort}`;
}
