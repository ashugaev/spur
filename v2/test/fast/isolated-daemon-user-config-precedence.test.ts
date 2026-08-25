import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTempDir } from "../helpers/common.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, "../../../scripts/spur-isolated-daemon.sh");

function extractUserConfigPathLine(): string {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const line = source.split("\n").find((entry) => entry.startsWith("USER_CONFIG_PATH="));
  if (!line) {
    throw new Error("USER_CONFIG_PATH= assignment not found in spur-isolated-daemon.sh");
  }
  return line;
}

async function resolveUserConfigPath(env: Record<string, string>): Promise<string> {
  const line = extractUserConfigPathLine();
  const script = `set -euo pipefail\n${line}\nprintf '%s' "$USER_CONFIG_PATH"\n`;
  const { stdout } = await execFileAsync("bash", ["-c", script], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  return stdout;
}

describe("spur-isolated-daemon USER_CONFIG_PATH precedence", () => {
  it("falls back to $HOME/.spur/config.yaml when no env vars set", async () => {
    const resolved = await resolveUserConfigPath({ HOME: "/home/fixture" });
    expect(resolved).toBe("/home/fixture/.spur/config.yaml");
  });

  it("uses SPUR_CONFIG when set (the active instance config)", async () => {
    const resolved = await resolveUserConfigPath({
      HOME: "/home/fixture",
      SPUR_CONFIG: "/tmp/custom-instance/config.yaml",
    });
    expect(resolved).toBe("/tmp/custom-instance/config.yaml");
  });

  it("prefers SPUR_USER_CONFIG_PATH over SPUR_CONFIG", async () => {
    const resolved = await resolveUserConfigPath({
      HOME: "/home/fixture",
      SPUR_CONFIG: "/tmp/from-spur-config/config.yaml",
      SPUR_USER_CONFIG_PATH: "/tmp/explicit-override/config.yaml",
    });
    expect(resolved).toBe("/tmp/explicit-override/config.yaml");
  });
});

// An isolated daemon must never reach the host's production web UI on the
// default port 5555 (spur.yaml can carry a live `telegram` source with a
// real token). config.ts falls back to DEFAULT_UI_PORT (5555, production
// spur-web) whenever a config's `ui:` block is absent, so this launcher
// resolves and writes its own instance's real `ui.port` into the config it
// generates before ever exec'ing `spur daemon start`. Critically it must not
// *guess* that port with its own independent scan: spur-isolated-ui.sh
// resolves and binds its own real port separately (a second, independent
// scan of the same range can land on a different number than the one
// isolated-ui actually binds). Instead the launcher reads the outer
// session's own authoritative sidecar port reservation via
// "$TOOL_DIR/spur-sidecar ports --name isolated-ui" (session-slots.ts wraps
// `spur sidecar ports`, which reads the live daemon's GET /sessions/:id —
// exactly the SPUR_RESERVED_PORT_UI value session-service hands to the
// isolated-ui process, see ensureSidecarReservation in
// v2/src/session-service.ts). No reservation shows up (isolated-ui was never
// requested for this run) resolves to the explicit sentinel "0", never a
// silently-omitted `ui:` block that config.ts would default to production's
// port 5555. There is no `SPUR_WEB_URL` (or any other env var) guard any
// more: the config value itself is what v2/src/event-sources/index.ts reads
// to build the webBaseUrl a Telegram source posts voice audio to (treating
// ui.port 0 as "no web UI known" -> null, see that file).
describe("spur-isolated-daemon ui.port guard", () => {
  function scriptLines(): string[] {
    return readFileSync(SCRIPT_PATH, "utf8").split("\n");
  }

  function configHeredocBody(): string[] {
    const lines = scriptLines();
    const heredocStart = lines.findIndex((line) =>
      line.includes('cat > "$CONFIG_DIR/config.yaml" <<YAML'),
    );
    const heredocEnd = lines.findIndex((line, index) => index > heredocStart && line === "YAML");
    if (heredocStart === -1 || heredocEnd === -1) {
      throw new Error("$CONFIG_DIR/config.yaml heredoc not found in spur-isolated-daemon.sh");
    }
    return lines.slice(heredocStart + 1, heredocEnd);
  }

  function extractFunction(name: string): string {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
    if (start === -1) {
      throw new Error(`${name}() not found in spur-isolated-daemon.sh`);
    }
    const end = lines.findIndex((line, index) => index > start && line === "}");
    if (end === -1) {
      throw new Error(`${name}() has no closing brace in spur-isolated-daemon.sh`);
    }
    return lines.slice(start, end + 1).join("\n");
  }

  // portLine is written between literal single quotes in the generated
  // fixture script, so it must contain none — real tabs are fine.
  async function makeFakeSpurSidecar(portLine: string | null): Promise<string> {
    const dir = await createTempDir("spur-sidecar-fixture-");
    const body =
      portLine === null
        ? "#!/usr/bin/env bash\nexit 0\n"
        : `#!/usr/bin/env bash\nprintf '%s\\n' '${portLine}'\n`;
    await writeFile(join(dir, "spur-sidecar"), body, { mode: 0o755 });
    return dir;
  }

  async function resolveUiPortViaFixture(toolDir: string): Promise<string> {
    const fn = extractFunction("resolve_ui_port_from_sidecar_registry");
    const script = `set -euo pipefail\n${fn}\nresolve_ui_port_from_sidecar_registry ${JSON.stringify(toolDir)}\n`;
    const { stdout } = await execFileAsync("bash", ["-c", script], {
      env: { PATH: process.env["PATH"] ?? "" },
    });
    return stdout.trim();
  }

  it("does not independently scan a port range for the UI port", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).not.toContain('resolve_sidecar_port "SPUR_RESERVED_PORT_UI"');
  });

  it("reads the exact port the outer session's sidecar registry reports for isolated-ui — the SAME port isolated-ui actually binds", async () => {
    const toolDir = await makeFakeSpurSidecar("isolated-ui\tui\tSPUR_RESERVED_PORT_UI\t5642\tdead");
    const port = await resolveUiPortViaFixture(toolDir);
    expect(port).toBe("5642");
  });

  it("resolves to the explicit sentinel 0 when isolated-ui has no reservation yet", async () => {
    const toolDir = await makeFakeSpurSidecar(null);
    const port = await resolveUiPortViaFixture(toolDir);
    expect(port).toBe("0");
  });

  it("writes the resolved UI_PORT as ui.port into the generated config.yaml", () => {
    const body = configHeredocBody();
    expect(body).toContain("ui:");
    expect(body).toContain("  port: $UI_PORT");
  });

  it("resolves UI_PORT from the registry before writing config.yaml", () => {
    const lines = scriptLines();
    const resolveIndex = lines.findIndex((line) =>
      line.startsWith("UI_PORT=$(resolve_ui_port_from_sidecar_registry"),
    );
    const heredocStart = lines.findIndex((line) =>
      line.includes('cat > "$CONFIG_DIR/config.yaml" <<YAML'),
    );
    expect(resolveIndex).toBeGreaterThanOrEqual(0);
    expect(heredocStart).toBeGreaterThan(resolveIndex);
  });

  it("writes config.yaml before exec'ing the daemon", () => {
    const lines = scriptLines();
    const heredocStart = lines.findIndex((line) =>
      line.includes('cat > "$CONFIG_DIR/config.yaml" <<YAML'),
    );
    const execIndex = lines.findIndex((line) => line === 'exec "$TOOL_DIR/spur" daemon start');
    expect(heredocStart).toBeGreaterThanOrEqual(0);
    expect(execIndex).toBeGreaterThan(heredocStart);
  });

  it("never references SPUR_WEB_URL", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).not.toContain("SPUR_WEB_URL");
  });
});
