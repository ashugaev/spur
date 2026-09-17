import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readSpurInstanceRuntimeConfig } from "./spur-instance.js";
import {
  cleanupIsolatedWebTestTarget,
  createIsolatedWebTestTarget,
} from "../tests/harness/daemon-target.js";

const MEMO_KEYS = [
  "SPUR_DAEMON_URL",
  "SPUR_CONFIG",
  "SPUR_TMUX_SOCKET_NAME",
  "SPUR_WEB_TEST_ISOLATION",
  "SPUR_WEB_TEST_UI_PORT",
] as const;

// Private temp root: os.tmpdir() reads TMPDIR per call, so the harness's
// mkdtemp lands here and a concurrent run on the shared /tmp cannot move the
// dir listing this file asserts on.
const SCRATCH_TMPDIR = mkdtempSync(join(tmpdir(), "spur-web-test-scratch-"));

// Clears the ambient value of every memo key so the harness always takes its
// allocating path, then applies `overrides`. vi.stubEnv only, never a write to
// the real process env.
function stubHarnessEnv(overrides: Record<string, string> = {}): void {
  vi.stubEnv("TMPDIR", SCRATCH_TMPDIR);
  for (const key of MEMO_KEYS) {
    vi.stubEnv(key, "");
  }
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
}

function harnessTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith("spur-web-test-"));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(SCRATCH_TMPDIR, { recursive: true, force: true });
});

describe("createIsolatedWebTestTarget", () => {
  it("never names a production default", () => {
    stubHarnessEnv();
    const target = createIsolatedWebTestTarget();
    try {
      expect(target.env["SPUR_DAEMON_URL"]).not.toContain(":4310");
      expect(target.env["SPUR_CONFIG"]).not.toBe(join(homedir(), ".spur", "config.yaml"));
      expect(existsSync(target.env["SPUR_CONFIG"] ?? "")).toBe(true);
      expect(target.env["SPUR_TMUX_SOCKET_NAME"]).not.toBe("spur-4310");
      expect(target.env["SPUR_WEB_TEST_ISOLATION"]).toBe("1");
      expect(target.uiPort).not.toBe(5555);
      expect(target.uiPort).not.toBe(4310);
    } finally {
      target.cleanup();
    }
  });

  it("removes its temp config dir on cleanup", () => {
    stubHarnessEnv();
    const target = createIsolatedWebTestTarget();
    const configPath = target.env["SPUR_CONFIG"] ?? "";
    expect(existsSync(configPath)).toBe(true);
    target.cleanup();
    expect(existsSync(configPath)).toBe(false);
  });

  // Pins the process-idempotence invariant: a Playwright worker re-requires
  // playwright.config.ts and re-runs its module-level allocation. Without the
  // memo the worker would resolve a uiPort no server ever bound.
  it("reuses the first allocation and allocates nothing on a memoized env", () => {
    stubHarnessEnv();
    const first = createIsolatedWebTestTarget();
    try {
      expect(process.env["SPUR_WEB_TEST_UI_PORT"]).toBe(String(first.uiPort));

      // Simulated worker: the memo values arrive through the inherited env.
      const workerEnv: Record<string, string> = {};
      for (const key of MEMO_KEYS) {
        workerEnv[key] = first.env[key] ?? "";
      }
      stubHarnessEnv(workerEnv);

      const before = harnessTempDirs();
      const second = createIsolatedWebTestTarget();
      expect(second.uiPort).toBe(first.uiPort);
      expect(second.env).toEqual(first.env);
      expect(harnessTempDirs()).toEqual(before);

      // The worker path owns no cleanup: the allocating process's dir survives.
      second.cleanup();
      expect(existsSync(first.env["SPUR_CONFIG"] ?? "")).toBe(true);
    } finally {
      stubHarnessEnv({ SPUR_WEB_TEST_ISOLATION: "1", SPUR_CONFIG: first.env["SPUR_CONFIG"] ?? "" });
      cleanupIsolatedWebTestTarget();
    }
  });

  it("reallocates when any single memo key is missing", () => {
    stubHarnessEnv();
    const first = createIsolatedWebTestTarget();
    try {
      const partial: Record<string, string> = {};
      for (const key of MEMO_KEYS) {
        if (key !== "SPUR_WEB_TEST_UI_PORT") {
          partial[key] = first.env[key] ?? "";
        }
      }
      stubHarnessEnv(partial);
      const second = createIsolatedWebTestTarget();
      try {
        expect(second.uiPort).not.toBe(first.uiPort);
        expect(second.env["SPUR_CONFIG"]).not.toBe(first.env["SPUR_CONFIG"]);
      } finally {
        second.cleanup();
      }
    } finally {
      stubHarnessEnv({ SPUR_WEB_TEST_ISOLATION: "1", SPUR_CONFIG: first.env["SPUR_CONFIG"] ?? "" });
      cleanupIsolatedWebTestTarget();
    }
  });
});

describe("readSpurInstanceRuntimeConfig isolation guard", () => {
  it("throws when isolation is on and resolution falls back to the production default", () => {
    stubHarnessEnv({ SPUR_WEB_TEST_ISOLATION: "1" });
    expect(() => readSpurInstanceRuntimeConfig()).toThrow(/Test isolation/);
  });

  it("stays silent with the harness env applied", () => {
    stubHarnessEnv();
    const target = createIsolatedWebTestTarget();
    try {
      stubHarnessEnv(target.env);
      const config = readSpurInstanceRuntimeConfig();
      expect(config.uiPort).toBe(target.uiPort);
      expect(config.daemonUrl).toBe(target.env["SPUR_DAEMON_URL"]);
      expect(config.tmuxSocketName).not.toBe("spur-4310");
    } finally {
      stubHarnessEnv({
        SPUR_WEB_TEST_ISOLATION: "1",
        SPUR_CONFIG: target.env["SPUR_CONFIG"] ?? "",
      });
      cleanupIsolatedWebTestTarget();
    }
  });

  it("leaves production behavior unchanged when isolation is off", () => {
    // Points at a path that does not exist rather than the host default, so the
    // defaults are exercised without reading the real ~/.spur/config.yaml.
    stubHarnessEnv({ SPUR_CONFIG: join(SCRATCH_TMPDIR, "absent.yaml") });
    const config = readSpurInstanceRuntimeConfig();
    expect(config.daemonUrl).toBe("http://127.0.0.1:4310");
    expect(config.uiPort).toBe(5555);
  });
});
