// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

describe("resolvePlaywrightBaseUrl", () => {
  it("prefers PLAYWRIGHT_BASE_URL when provided", async () => {
    const { resolvePlaywrightBaseUrl } = await import("@/lib/playwright-base-url");

    expect(
      resolvePlaywrightBaseUrl({
        PLAYWRIGHT_BASE_URL: "http://127.0.0.1:7777",
      }),
    ).toBe("http://127.0.0.1:7777");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("uses the alive isolated-ui sidecar port from spur list", async () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue(
      JSON.stringify([
        {
          id: "spur-9e73",
          sidecars: [{ name: "isolated-ui", alive: true }],
          sidecarPorts: {
            "isolated-ui": {
              SPUR_RESERVED_PORT_UI: 5612,
            },
          },
        },
      ]),
    );

    const { resolvePlaywrightBaseUrl } = await import("@/lib/playwright-base-url");

    expect(
      resolvePlaywrightBaseUrl({
        SPUR_SESSION: "spur-9e73",
        SPUR_SESSION_TOOL_DIR: "/tmp/spur-9e73",
      }),
    ).toBe("http://127.0.0.1:5612");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/tmp/spur-9e73/spur",
      ["list", "--json"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
  });

  it("falls back to localhost when the isolated-ui sidecar is unavailable", async () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue(
      JSON.stringify([
        {
          id: "spur-9e73",
          sidecars: [{ name: "isolated-ui", alive: false }],
          sidecarPorts: {
            "isolated-ui": {
              SPUR_RESERVED_PORT_UI: 5612,
            },
          },
        },
      ]),
    );

    const { resolvePlaywrightBaseUrl } = await import("@/lib/playwright-base-url");

    expect(
      resolvePlaywrightBaseUrl({
        SPUR_SESSION: "spur-9e73",
        SPUR_SESSION_TOOL_DIR: "/tmp/spur-9e73",
      }),
    ).toBe("http://localhost:5555");
  });
});
