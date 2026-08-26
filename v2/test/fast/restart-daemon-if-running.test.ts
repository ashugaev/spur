import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
  // Stand-in for the built CLI: records that `daemon restart` ran, prints a
  // marker so a stdio:"inherit" propagation is observable, and exits with
  // SPUR_TEST_EXIT_CODE (default 0) so status propagation is observable too.
  writeFileSync(
    join(dist, "cli.js"),
    [
      `import { writeFileSync } from "node:fs";`,
      `process.stdout.write("daemon-restart-cli-stdout\\n");`,
      `writeFileSync(${JSON.stringify(marker)}, "1");`,
      `process.exitCode = Number(process.env.SPUR_TEST_EXIT_CODE ?? "0");`,
    ].join("\n"),
  );
  // An instance config so instanceConfigExists() returns true (the non-skip
  // path), proving the env — not a missing config — is the cause of the skip.
  const configPath = join(cwd, "config.yaml");
  writeFileSync(configPath, "dataDir: " + join(cwd, "data") + "\nprojects: {}\n");
  return { cwd, marker, configPath };
}

function runBin(cwd: string, configPath: string, extraEnv: Record<string, string>) {
  // Strip SPUR_BUILD_RESTART from the inherited env so a caller's own opt-in
  // (if any) cannot leak into a case that means to test its absence.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "SPUR_BUILD_RESTART") continue;
    if (v !== undefined) env[k] = v;
  }
  env["SPUR_CONFIG"] = configPath;
  return spawnSync(process.execPath, [binPath], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf-8",
  });
}

// Same fixture cwd, but the config lives at the DEFAULT instance path under a
// temp HOME (os.homedir() reads $HOME on POSIX) and SPUR_CONFIG is unset — the
// exact shape of an opted-in build in a source tree resolving the host-global
// prod slot.
function runBinAgainstDefaultConfig(cwd: string, home: string) {
  mkdirSync(join(home, ".spur"), { recursive: true });
  writeFileSync(
    join(home, ".spur", "config.yaml"),
    "dataDir: " + join(home, ".spur") + "\nprojects: {}\n",
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "SPUR_BUILD_RESTART" || k === "SPUR_CONFIG") continue;
    if (v !== undefined) env[k] = v;
  }
  env["HOME"] = home;
  env["SPUR_BUILD_RESTART"] = "1";
  return spawnSync(process.execPath, [binPath], { cwd, env, encoding: "utf-8" });
}

describe("restart-daemon-if-running.mjs opt-in gate", () => {
  it("does not restart when SPUR_BUILD_RESTART is unset (#753 regression pin)", () => {
    const { cwd, marker, configPath } = makeFixture();
    const result = runBin(cwd, configPath, {});
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("invokes the daemon restart when SPUR_BUILD_RESTART=1 against a non-default config", () => {
    const { cwd, marker, configPath } = makeFixture();
    const result = runBin(cwd, configPath, { SPUR_BUILD_RESTART: "1" });
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    // Pins stdio: "inherit" — the restarted CLI's own stdout must reach the
    // parent, not be swallowed.
    expect(result.stdout).toContain("daemon-restart-cli-stdout");
  });

  it("propagates the restarted CLI's non-zero exit status", () => {
    const { cwd, marker, configPath } = makeFixture();
    const result = runBin(cwd, configPath, {
      SPUR_BUILD_RESTART: "1",
      SPUR_TEST_EXIT_CODE: "7",
    });
    expect(result.status).toBe(7);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("restart-daemon-if-running.mjs default-config skip", () => {
  it("refuses the restart when SPUR_BUILD_RESTART=1 but the resolved config is the host default path", () => {
    const { cwd, marker } = makeFixture();
    const home = mkdtempSync(join(tmpdir(), "spur-restart-daemon-home-"));
    const result = runBinAgainstDefaultConfig(cwd, home);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).toContain("host default instance config");
  });

  it("refuses via SPUR_CONFIG pointing at the host default path too, even with SPUR_BUILD_RESTART=1", () => {
    const { cwd, marker } = makeFixture();
    const home = mkdtempSync(join(tmpdir(), "spur-restart-daemon-home-"));
    mkdirSync(join(home, ".spur"), { recursive: true });
    const defaultPath = join(home, ".spur", "config.yaml");
    writeFileSync(defaultPath, "dataDir: " + join(home, ".spur") + "\nprojects: {}\n");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "SPUR_BUILD_RESTART") continue;
      if (v !== undefined) env[k] = v;
    }
    env["HOME"] = home;
    env["SPUR_CONFIG"] = defaultPath;
    env["SPUR_BUILD_RESTART"] = "1";
    const result = spawnSync(process.execPath, [binPath], { cwd, env, encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
