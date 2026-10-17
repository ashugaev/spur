import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

it.each([false, true])(
  "binds final daemon children to own config through shell function=%s",
  async (shellFunction) => {
    const directory = await createTempDir("spur-isolated-child-config-");
    const config = join(directory, "config.yaml");
    const wrapper = join(directory, "wrapper");
    const cli = join(directory, "cli.mjs");
    const source = readFileSync(SCRIPT_PATH, "utf8");
    const boundary = source.slice(source.lastIndexOf("\nexport SPUR_CONFIG="));
    expect(boundary.trim()).toBe(
      'export SPUR_CONFIG="$SPUR_ISOLATED_CONFIG"\nexec "$ISOLATED_WRAPPER" daemon start',
    );
    const configModule = pathToFileURL(resolve(HERE, "../../dist/config.js")).href;
    await writeFile(
      cli,
      `import { resolveInstanceConfigPath } from ${JSON.stringify(configModule)};\n` +
        'const index = process.argv.indexOf("--config");\n' +
        "console.log(JSON.stringify({ inherited: process.env.SPUR_CONFIG, resolved: resolveInstanceConfigPath(index < 0 ? undefined : process.argv[index + 1]) }));\n",
    );
    if (shellFunction) {
      await writeFile(wrapper, '#!/bin/bash\nspur() { "$VOICE_NODE" "$VOICE_CLI"; }\nspur\n');
    } else {
      const start = source.indexOf('cat > "$ISOLATED_WRAPPER" <<WRAPPER');
      const end = source.indexOf("\nWRAPPER", start) + "\nWRAPPER".length;
      expect(start).toBeGreaterThan(-1);
      const { stdout } = await execFileAsync("bash", ["-c", source.slice(start, end)], {
        env: {
          PATH: process.env["PATH"] ?? "",
          ISOLATED_WRAPPER: wrapper,
          CONFIG_DIR: directory,
          PROJECT_CONFIG_RUNTIME_PATH: join(directory, "project.yaml"),
          NODE_BIN: process.execPath,
          CLI_PATH: cli,
        },
      });
      expect(stdout).toBe("");
    }
    await chmod(wrapper, 0o700);
    const { stdout } = await execFileAsync("bash", ["-c", `set -euo pipefail\n${boundary}`], {
      env: {
        PATH: process.env["PATH"] ?? "",
        SPUR_CONFIG: join(directory, "parent.yaml"),
        SPUR_ISOLATED_CONFIG: config,
        ISOLATED_WRAPPER: wrapper,
        VOICE_NODE: process.execPath,
        VOICE_CLI: cli,
      },
    });
    expect(stdout.trim()).toBe(JSON.stringify({ inherited: config, resolved: config }));
  },
);

// An isolated daemon's own web UI port genuinely cannot be known at daemon
// boot, by construction: spur.yaml gives `isolated-ui` `dependsOn:
// [isolated-daemon]`, and session-service (startSidecarWithDependencies,
// ensureSidecarReservation — v2/src/session-service.ts) only reserves and
// hands `isolated-ui` its real port strictly *after* `isolated-daemon`'s own
// startup call has already returned. No poll, scan, or registry read at
// this script's own start time can ever observe it — earlier revisions of
// this fix tried exactly that (a sentinel `ui.port: 0` written here) and
// broke two ways: config.ts's asOptionalNumber() throws on a
// non-positive `ui.port` (`ui.port must be a positive number`), and the
// poll for isolated-ui's reservation can never succeed this early anyway.
// So this script goes back to not touching `ui:` at all — the config it
// generates is exactly what it was before any of this, and the daemon
// resolves its own web UI base URL lazily, at the moment a source actually
// needs it (see resolveWebBaseUrl in v2/src/ports.ts and its own test
// suite, web-base-url.test.ts, for the isolated-vs-not branch, the port
// match, and the fail-closed path).
describe("spur-isolated-daemon does not resolve ui.port at boot", () => {
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

  it("never writes a ui: block into the generated config.yaml", () => {
    const body = configHeredocBody();
    expect(body).not.toContain("ui:");
  });

  it("never references SPUR_WEB_URL", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).not.toContain("SPUR_WEB_URL");
  });

  it("never queries the outer session's sidecar port registry at boot", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).not.toContain("spur-sidecar ports");
    expect(source).not.toContain("SPUR_RESERVED_PORT_UI");
  });

  // The gap a prior version of this fix shipped with: nothing ran the exact
  // text this script writes through the real config parser, so a config.ts
  // validation rule (ui.port must be positive) went unnoticed until review.
  it("the generated config.yaml, exactly as this script writes it, loads through loadConfig without throwing", async () => {
    const configDir = await createTempDir("spur-isolated-config-fixture-");
    const agentPort = 43217;
    const body = configHeredocBody()
      .map((line) =>
        line.replaceAll("$CONFIG_DIR", configDir).replaceAll("$AGENT_PORT", String(agentPort)),
      )
      .join("\n");
    const configPath = join(configDir, "config.yaml");
    await writeFile(configPath, `${body}\n`, "utf8");

    const { loadConfig } = await import("../../src/config.js");
    const { DEFAULT_UI_PORT } = await import("../../src/ports.js");
    const config = loadConfig(configPath);

    expect(config.server.port).toBe(agentPort);
    // No ui: block written -> config.ts's own default, untouched by this
    // launcher. Safe precisely because nothing reads it for this instance's
    // webBaseUrl any more (resolveWebBaseUrl resolves lazily instead).
    expect(config.ui.port).toBe(DEFAULT_UI_PORT);
  });
});
