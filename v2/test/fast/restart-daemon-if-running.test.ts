import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// bin/restart-daemon-if-running.mjs runs `node dist/cli.js daemon restart` from
// the current cwd when an instance config exists. We point cwd at a fixture
// whose dist/cli.js writes a marker file, so an invocation is observable. The
// mjs imports the REAL ../dist/config.js (relative to its own path), so a
// config referenced via SPUR_CONFIG makes instanceConfigExists() true.
const binPath = fileURLToPath(new URL("../../bin/restart-daemon-if-running.mjs", import.meta.url));

function makeFixture(): { cwd: string; marker: string; configPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "spur-restart-daemon-"));
  const marker = join(cwd, "daemon-restart-invoked");
  const dist = join(cwd, "dist");
  mkdirSync(dist);
  // Stand-in for the built CLI: records that `daemon restart` ran, exits 0.
  writeFileSync(
    join(dist, "cli.js"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "1");\n`,
  );
  // An instance config so instanceConfigExists() returns true (the non-skip
  // path), proving the env — not a missing config — is the cause of the skip.
  const configPath = join(cwd, "config.yaml");
  writeFileSync(configPath, "dataDir: " + join(cwd, "data") + "\nprojects: {}\n");
  return { cwd, marker, configPath };
}

function runBin(cwd: string, configPath: string, extraEnv: Record<string, string>) {
  // Strip SPUR_SESSION from the inherited env so it does not short-circuit the
  // skip guard we are not testing here.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "SPUR_SESSION" || k === "SPUR_DISABLE_AUTOSTART") continue;
    if (v !== undefined) env[k] = v;
  }
  env["SPUR_CONFIG"] = configPath;
  return spawnSync(process.execPath, [binPath], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf-8",
  });
}

describe("restart-daemon-if-running.mjs SPUR_DISABLE_AUTOSTART skip", () => {
  it("skips the daemon restart when SPUR_DISABLE_AUTOSTART is set", () => {
    const { cwd, marker, configPath } = makeFixture();
    chmodSync(cwd, 0o755);
    const result = runBin(cwd, configPath, { SPUR_DISABLE_AUTOSTART: "1" });
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("invokes the daemon restart when SPUR_DISABLE_AUTOSTART is unset (control)", () => {
    const { cwd, marker, configPath } = makeFixture();
    chmodSync(cwd, 0o755);
    const result = runBin(cwd, configPath, {});
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});
