import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

interface SidecarPortRow {
  sidecar?: unknown;
  port?: unknown;
}

function isSidecarPortRow(value: unknown): value is { port: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SidecarPortRow).port === "number"
  );
}

/**
 * Resolves this instance's own web UI base URL, lazily — called at the
 * moment a source actually needs it (voice transcription today), never
 * cached at daemon boot.
 *
 * A daemon started normally (systemd `spur.service`, or a bare `spur daemon
 * start`) has no `SPUR_SESSION_TOOL_DIR` in its own process env — that var
 * is set only when the current process is itself running as a session's
 * agent or sidecar (see `buildSessionEnv` in session-service.ts). For such a
 * daemon `config.ui.port` is this instance's own real, already-bound
 * listen port, so it's trusted directly.
 *
 * `scripts/spur-isolated-daemon.sh` is different: it's launched (and its
 * own process inherits `SPUR_SESSION_TOOL_DIR`) as a sidecar of an outer
 * coding session, and it never knows its own web UI port at boot —
 * `spur-isolated-ui.sh` reserves and binds that port independently, and
 * (per spur.yaml's `isolated-ui: dependsOn: [isolated-daemon]` and
 * `ensureSidecarReservation`/`startSidecarWithDependencies` in
 * session-service.ts) that reservation is only made strictly *after*
 * `isolated-daemon`'s own startup call has already returned — this daemon
 * cannot observe it at startup by any means, poll or otherwise. So it
 * defers entirely to the moment of use: ask the outer session for its own
 * authoritative `isolated-ui` reservation via
 * "$SPUR_SESSION_TOOL_DIR/spur-sidecar ports --name isolated-ui --json"
 * (the exact same reservation session-service hands to the `isolated-ui`
 * process itself). No reservation yet (`isolated-ui` never requested, or
 * requested but not yet reserved) resolves to `null` — never a guess, never
 * `config.ui.port`'s `DEFAULT_UI_PORT` (5555, the host's production
 * spur-web).
 */
export async function resolveWebBaseUrl(
  uiPort: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const toolDir = env["SPUR_SESSION_TOOL_DIR"];
  if (!toolDir) {
    return `http://127.0.0.1:${uiPort}`;
  }

  // Isolated context past this point: uiPort (config.ui.port) is never
  // returned again, on any path — the outer session's registry is the only
  // source of truth, and every failure to read it is null, same as below.
  const sidecarCli = join(toolDir, "spur-sidecar");
  try {
    accessSync(sidecarCli, constants.X_OK);
  } catch {
    return null;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(sidecarCli, ["ports", "--name", "isolated-ui", "--json"], {
      timeout: 5000,
    }));
  } catch {
    return null;
  }

  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const row = rows.find(isSidecarPortRow);
  if (!row) return null;

  return `http://127.0.0.1:${row.port}`;
}
