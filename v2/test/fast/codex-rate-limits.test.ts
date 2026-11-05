import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../src/agents/codex.js", () => ({ codexCommand: () => "/mock/codex" }));

import {
  CodexRateLimitPoller,
  readCodexOrdinaryUsageAllowed,
} from "../../src/agents/codex-rate-limits.js";

function fakeAppServer(permission: boolean | null, accountId: string | null = null) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      const initialize = line.includes('"method":"initialize"');
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              id: initialize ? 1 : 2,
              result: initialize
                ? {}
                : { ordinaryUsageAllowed: permission, accountId, rateLimits: {} },
            })}\n`,
          ),
        );
      });
      return true;
    }),
  });
  child.kill = vi.fn(() => {
    child.emit("close", null);
    return true;
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex app-server rate-limit probe", () => {
  it.each([true, false, null])(
    "reads ordinaryUsageAllowed=%s after initialize",
    async (permission) => {
      const child = fakeAppServer(permission);
      spawnMock.mockReturnValue(child);
      expect(await readCodexOrdinaryUsageAllowed("/tmp/codex-home")).toBe(permission);
      expect(spawnMock).toHaveBeenCalledWith(
        "/mock/codex",
        ["app-server"],
        expect.objectContaining({
          env: expect.objectContaining({ CODEX_HOME: "/tmp/codex-home" }),
        }),
      );
      expect(child.stdin.write.mock.calls[0]?.[0]).toContain('"method":"initialize"');
      expect(child.stdin.write.mock.calls[1]?.[0]).toContain('"method":"account/rateLimits/read"');
      expect(child.kill).toHaveBeenCalledOnce();
    },
  );

  it("kills a silent app-server within three seconds", async () => {
    const child = fakeAppServer(null);
    child.stdin.write.mockImplementation(() => true);
    spawnMock.mockReturnValue(child);
    const pending = readCodexOrdinaryUsageAllowed("/tmp/codex-home");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("stops reading oversized output without retaining the response", async () => {
    const child = fakeAppServer(null);
    child.stdin.write.mockImplementation(() => {
      queueMicrotask(() => child.stdout.emit("data", Buffer.alloc(64 * 1024 + 1, 65)));
      return true;
    });
    spawnMock.mockReturnValue(child);
    expect(await readCodexOrdinaryUsageAllowed("/tmp/codex-home")).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("terminates a pending probe when disposed", async () => {
    const child = fakeAppServer(null);
    child.stdin.write.mockImplementation(() => true);
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    const pending = readCodexOrdinaryUsageAllowed("/tmp/codex-home", controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("spaces independent homes with nullable account IDs by sixty seconds", async () => {
    spawnMock.mockImplementation(() => fakeAppServer(false, null));
    const poller = new CodexRateLimitPoller();
    expect(poller.permission("first", "/tmp/codex-home-a", 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.permission("second", "/tmp/codex-home-b", 0)).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("does not reuse a permission result older than a new usage-limit error", async () => {
    spawnMock.mockImplementation(() => fakeAppServer(true));
    const poller = new CodexRateLimitPoller();
    expect(poller.permission("first", "/tmp/codex-home", 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.permission("first", "/tmp/codex-home", 0)).toBe(true);

    vi.setSystemTime(2_000);
    expect(poller.permission("first", "/tmp/codex-home", 2_000)).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    poller.dispose();
  });
});
