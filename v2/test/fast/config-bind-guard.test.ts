import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertConfigMayUseProdSlot, defaultInstanceConfigPath } from "../../src/config.js";

// This file must never create, write, or delete anything under the real
// ~/.spur. Every write below goes to a fresh temp dir; reading homedir() to
// build the prod-default dataDir string is fine, it is never touched.

describe("assertConfigMayUseProdSlot", () => {
  it("passes for the default instance config path regardless of existence (prod-restart safety invariant)", () => {
    expect(() => assertConfigMayUseProdSlot(defaultInstanceConfigPath())).not.toThrow();
  });

  it("passes for the default instance config path with no --config given (prod first boot still bootstraps)", () => {
    expect(() => assertConfigMayUseProdSlot(undefined)).not.toThrow();
  });

  it("throws for a non-default config path that does not exist and never creates it", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const missingPath = join(root, "missing.yaml");

    expect(() => assertConfigMayUseProdSlot(missingPath)).toThrow("does not exist");
    expect(existsSync(missingPath)).toBe(false);
  });

  it("throws for a non-default config path that exists and claims port 4310 explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const dataDir = join(root, "data");
    await writeFile(
      configPath,
      ["server:", "  port: 4310", `dataDir: ${dataDir}`].join("\n"),
      "utf8",
    );

    let error: unknown;
    try {
      assertConfigMayUseProdSlot(configPath);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(configPath);
    expect(message).toContain("4310");
    expect(message).toContain("spur-isolated-daemon.sh");
  });

  it("throws for a non-default config path that exists and omits server.port (inherits 4310)", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const dataDir = join(root, "data");
    await writeFile(configPath, [`dataDir: ${dataDir}`].join("\n"), "utf8");

    expect(() => assertConfigMayUseProdSlot(configPath)).toThrow("4310");
  });

  it("throws for a non-default config path that exists and omits dataDir (inherits ~/.spur)", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const port = 65000;
    await writeFile(configPath, ["server:", `  port: ${port}`].join("\n"), "utf8");

    expect(() => assertConfigMayUseProdSlot(configPath)).toThrow(join(homedir(), ".spur"));
  });

  it("passes for a non-default config path that exists with a free port and a temp dataDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const dataDir = join(root, "data");
    await writeFile(
      configPath,
      ["server:", "  port: 65000", `dataDir: ${dataDir}`].join("\n"),
      "utf8",
    );

    expect(() => assertConfigMayUseProdSlot(configPath)).not.toThrow();
  });

  it("does not throw from the guard for a non-default config path with unparseable yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    await writeFile(configPath, "server:\n  port: [unterminated\n", "utf8");

    expect(() => assertConfigMayUseProdSlot(configPath)).not.toThrow();
  });
});
