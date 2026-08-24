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
// real token). resolveWebBaseUrl() in v2/src/ports.ts treats
// SPUR_WEB_URL="" as "voice transcription disabled for this instance", so
// both places this script can launch a daemon from must export it empty:
// the wrapper heredoc written to $TOOL_DIR/spur (client.ts's spawnDaemon
// execs that wrapper with no explicit `env`, inheriting whatever the
// invoking CLI process saw) and the launcher's own top-level
// `exec "$TOOL_DIR/spur" daemon start`.
describe("spur-isolated-daemon SPUR_WEB_URL guard", () => {
  function scriptLines(): string[] {
    return readFileSync(SCRIPT_PATH, "utf8").split("\n");
  }

  it('exports SPUR_WEB_URL="" inside the $TOOL_DIR/spur wrapper heredoc', () => {
    const lines = scriptLines();
    const heredocStart = lines.findIndex((line) =>
      line.includes('cat > "$TOOL_DIR/spur" <<WRAPPER'),
    );
    const heredocEnd = lines.findIndex((line, index) => index > heredocStart && line === "WRAPPER");
    if (heredocStart === -1 || heredocEnd === -1) {
      throw new Error("$TOOL_DIR/spur wrapper heredoc not found in spur-isolated-daemon.sh");
    }
    const heredocBody = lines.slice(heredocStart + 1, heredocEnd);
    expect(heredocBody).toContain('export SPUR_WEB_URL=""');
  });

  it('exports SPUR_WEB_URL="" before the launcher\'s own daemon exec', () => {
    const lines = scriptLines();
    const execIndex = lines.findIndex((line) => line === 'exec "$TOOL_DIR/spur" daemon start');
    if (execIndex === -1) {
      throw new Error('exec "$TOOL_DIR/spur" daemon start not found in spur-isolated-daemon.sh');
    }
    expect(lines[execIndex - 1]).toBe('export SPUR_WEB_URL=""');
  });
});
