import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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
// spur-web) whenever a config's `ui:` block is absent, so this launcher must
// resolve and write its own instance's real `ui.port` into the config it
// generates — via the same resolve_sidecar_port helper (same env name and
// port range) spur-isolated-ui.sh uses for its own real bind port — before
// ever exec'ing `spur daemon start`. There is no `SPUR_WEB_URL` (or any
// other env var) guard any more: the config value itself is what
// v2/src/event-sources/index.ts reads to build the webBaseUrl a Telegram
// source posts voice audio to.
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

  it("resolves UI_PORT with the same helper and env/range convention as spur-isolated-ui.sh's UI_PORT", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).toContain(
      'UI_PORT=$(resolve_sidecar_port "SPUR_RESERVED_PORT_UI" "$UI_PORT_START" "$UI_PORT_END")',
    );
  });

  it("writes the resolved UI_PORT as ui.port into the generated config.yaml", () => {
    const body = configHeredocBody();
    expect(body).toContain("ui:");
    expect(body).toContain("  port: $UI_PORT");
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
