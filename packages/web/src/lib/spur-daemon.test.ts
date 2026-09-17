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
  "SPUR_WEB_TEST_ISOLATION",
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

describe("daemonBaseUrl isolation guard", () => {
  it("throws before any request when resolution lands on a production default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    stubHarnessEnv({ SPUR_WEB_TEST_ISOLATION: "1" });
    await expect(spurRequest("/info")).rejects.toThrow(/Test isolation/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves the harness target without throwing", async () => {
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

  it("leaves production resolution unchanged when isolation is off", async () => {
    stubHarnessEnv({ SPUR_CONFIG: join(SCRATCH_TMPDIR, "absent.yaml") });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await spurRequest("/info");
    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4310/info", expect.anything());
  });
});
