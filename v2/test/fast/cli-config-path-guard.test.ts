import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

// Regression coverage for issue #846: `spur --config <missing path> <command>`
// used to seed the path from defaults (server.port 4310, dataDir ~/.spur),
// answer from the production daemon, and exit 0 — with the "Initialized"
// notice printed only on the run that created the file. Every command action
// resolves its instance config through `prepareInstanceConfig`, so the refusal
// has to hold for an arbitrary command, not just `daemon start|stop|restart`.
//
// `list` is the command under test because it is read-only: if the guard ever
// regresses, this test reaches a real daemon rather than mutating one.

async function runCli(configPath: string, args: string[]): Promise<unknown> {
  return createProgram("/tmp/dist/cli.js").parseAsync([
    "node",
    "spur",
    "--config",
    configPath,
    ...args,
  ]);
}

describe("cli --config existence guard", () => {
  it("refuses a non-existent --config path and never creates it", async () => {
    const root = mkdtempSync(join(tmpdir(), "spur-cli-config-guard-"));
    const missingPath = join(root, "nested", "config.yaml");

    await expect(runCli(missingPath, ["list"])).rejects.toThrow("does not exist");
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(join(root, "nested"))).toBe(false);
  });

  it("names the config path the caller passed, not the daemon's", async () => {
    const root = mkdtempSync(join(tmpdir(), "spur-cli-config-guard-"));
    const missingPath = join(root, "config.yaml");

    await expect(runCli(missingPath, ["list"])).rejects.toThrow(missingPath);
  });
});
