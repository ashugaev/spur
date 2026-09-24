import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spurRequest } from "./spur-daemon.js";
import { createIsolatedWebTestTarget } from "../../tests/harness/daemon-target.js";

const MEMO_KEYS = [
  "SPUR_DAEMON_URL",
  "SPUR_CONFIG",
  "SPUR_TMUX_SOCKET_NAME",
  "SPUR_WEB_TEST_UI_PORT",
] as const;

const SCRATCH_TMPDIR = mkdtempSync(join(tmpdir(), "spur-web-test-scratch-"));

function stubHarnessEnv(overrides: Record<string, string> = {}): void {
  vi.stubEnv("TMPDIR", SCRATCH_TMPDIR);
  for (const key of MEMO_KEYS) {
    vi.stubEnv(key, "");
  }
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(SCRATCH_TMPDIR, { recursive: true, force: true });
});

describe("daemonBaseUrl", () => {
  // The isolation guarantee: an unresolved SPUR_DAEMON_URL must fail loudly.
  // A default here would send every unmocked request to the host's production
  // daemon on 4310 whenever the harness env failed to reach the process.
  it("throws instead of resolving a production default when SPUR_DAEMON_URL is unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    stubHarnessEnv();
    await expect(spurRequest("/info")).rejects.toThrow("SPUR_DAEMON_URL is not set");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves the harness target", async () => {
    stubHarnessEnv();
    const target = createIsolatedWebTestTarget();
    try {
      stubHarnessEnv(target.env);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      await spurRequest("/info");
      expect(fetchSpy).toHaveBeenCalledWith(
        `${target.env["SPUR_DAEMON_URL"]}/info`,
        expect.anything(),
      );
    } finally {
      target.cleanup();
    }
  });

  it("strips trailing slashes from the configured URL", async () => {
    stubHarnessEnv({ SPUR_DAEMON_URL: "http://127.0.0.1:41999//" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await spurRequest("/info");
    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:41999/info", expect.anything());
  });
});
