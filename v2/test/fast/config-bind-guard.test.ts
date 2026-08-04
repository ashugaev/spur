import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertConfigMayBindProdSlot,
  assertInstanceConfigExists,
  defaultInstanceConfigPath,
} from "../../src/config.js";

// This file must never create, write, or delete anything under the real
// ~/.spur. Every write below goes to a fresh temp dir; reading homedir() to
// build the prod-default dataDir string is fine, it is never touched.

describe("assertConfigMayBindProdSlot", () => {
  it("passes for the default instance config path on port 4310 with dataDir ~/.spur (prod-restart safety invariant)", () => {
    expect(() =>
      assertConfigMayBindProdSlot({
        configPath: defaultInstanceConfigPath(),
        server: { port: 4310 },
        dataDir: join(homedir(), ".spur"),
      }),
    ).not.toThrow();
  });

  it("passes for the default instance config path spelled explicitly", () => {
    expect(() =>
      assertConfigMayBindProdSlot({
        configPath: join(homedir(), ".spur", "config.yaml"),
        server: { port: 4310 },
        dataDir: join(homedir(), ".spur"),
      }),
    ).not.toThrow();
  });

  it("throws for a non-default config path claiming port 4310 with a temp dataDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const dataDir = join(root, "data");

    let error: unknown;
    try {
      assertConfigMayBindProdSlot({
        configPath,
        server: { port: 4310 },
        dataDir,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(configPath);
    expect(message).toContain("4310");
    expect(message).toContain(dataDir);
    expect(message).toContain("spur-isolated-daemon.sh");
  });

  it("throws for a non-default config path with a free port but dataDir ~/.spur", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");

    expect(() =>
      assertConfigMayBindProdSlot({
        configPath,
        server: { port: 4399 },
        dataDir: join(homedir(), ".spur"),
      }),
    ).toThrow();
  });

  it("passes for a non-default config path with a free port and a temp dataDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const dataDir = join(root, "data");

    expect(() =>
      assertConfigMayBindProdSlot({
        configPath,
        server: { port: 4399 },
        dataDir,
      }),
    ).not.toThrow();
  });

  it("never creates the dataDir it refuses to bind", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    const dataDir = join(root, "data");

    expect(() =>
      assertConfigMayBindProdSlot({
        configPath,
        server: { port: 4310 },
        dataDir,
      }),
    ).toThrow();

    expect(existsSync(dataDir)).toBe(false);
  });
});

describe("assertInstanceConfigExists", () => {
  it("throws for a non-default config path that does not exist and never creates it", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const missingPath = join(root, "missing.yaml");

    expect(() => assertInstanceConfigExists(missingPath)).toThrow();
    expect(existsSync(missingPath)).toBe(false);
  });

  it("passes for a non-default config path that exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-bind-guard-test-"));
    const configPath = join(root, "spur.yaml");
    await writeFile(configPath, "server:\n  port: 4400\n", "utf8");

    expect(() => assertInstanceConfigExists(configPath)).not.toThrow();
  });

  it("passes for the default instance config path regardless of existence", () => {
    expect(() => assertInstanceConfigExists(defaultInstanceConfigPath())).not.toThrow();
  });
});
