// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const homedirMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
}));

describe("resolvePlaywrightBaseUrl", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    homedirMock.mockReset();
    readFileSyncMock.mockReset();
    homedirMock.mockReturnValue("/home/tester");
    readFileSyncMock.mockImplementation(() => {
      throw new Error("missing metadata");
    });
  });

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

  it("requires an available isolated-ui sidecar inside a Spur session", async () => {
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

    expect(() =>
      resolvePlaywrightBaseUrl({
        SPUR_SESSION: "spur-9e73",
        SPUR_SESSION_TOOL_DIR: "/tmp/spur-9e73",
      }),
    ).toThrow(/isolated-ui sidecar unavailable/);
  });

  it("uses session metadata port when the sidecar command wrapper cannot report parent state", async () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue(JSON.stringify([]));
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === "/home/tester/.spur/sessions/.index.json") {
        return JSON.stringify({ "spur-9e73": "sessions/sp/spur-9e73.json" });
      }
      if (path === "/home/tester/.spur/sessions/sp/spur-9e73.json") {
        return JSON.stringify({
          id: "spur-9e73",
          sidecarPorts: {
            "isolated-ui": {
              SPUR_RESERVED_PORT_UI: 5612,
            },
          },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const { resolvePlaywrightBaseUrl } = await import("@/lib/playwright-base-url");

    expect(
      resolvePlaywrightBaseUrl({
        SPUR_SESSION: "spur-9e73",
        SPUR_SESSION_TOOL_DIR: "/tmp/spur-9e73",
      }),
    ).toBe("http://127.0.0.1:5612");
  });

  it("falls back to localhost outside Spur sessions", async () => {
    const { resolvePlaywrightBaseUrl } = await import("@/lib/playwright-base-url");

    expect(resolvePlaywrightBaseUrl({})).toBe("http://localhost:5555");
  });
});
