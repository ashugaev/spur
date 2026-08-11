import { afterEach, describe, expect, it, vi } from "vitest";

// The production code always calls execFile with a 4-argument shape
// (file, args, options, callback) after this fix, so the mock only needs to
// honor that shape. It deliberately never invokes the callback on its own —
// mirroring a notify-send/osascript binary that hangs (no notification
// daemon, stale D-Bus, no display) — so the only way the callback ever fires
// is if the caller's `options.timeout` is honored, which is what node's real
// execFile does internally by killing the child and calling back with an
// error. This isolates the contract under test (a timeout is passed and
// respected) without depending on a real hung subprocess.
type ExecFileCallback = (error: Error | null) => void;
const execFileMock = vi.fn(
  (
    _file: string,
    _args: string[],
    options: { timeout?: number } | ExecFileCallback,
    callback?: ExecFileCallback,
  ) => {
    const resolvedOptions = typeof options === "function" ? undefined : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (resolvedOptions?.timeout !== undefined && resolvedCallback) {
      setTimeout(() => resolvedCallback(new Error("ETIMEDOUT")), resolvedOptions.timeout);
    }
    // No timeout supplied: never call back. This is what used to wedge
    // attentionMonitorRunning forever.
  },
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

let platformMock = vi.fn(() => "linux");
vi.mock("node:os", () => ({
  platform: () => platformMock(),
}));

afterEach(() => {
  execFileMock.mockClear();
  vi.useRealTimers();
});

describe("sendDesktopNotification", () => {
  it("resolves on linux when notify-send never exits, once the timeout elapses", async () => {
    platformMock = vi.fn(() => "linux");
    vi.useFakeTimers();
    const { sendDesktopNotification } = await import("../../src/desktop-notify.js");

    let settled = false;
    const pending = sendDesktopNotification({ title: "Spur", message: "hello" }).then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(settled).toBe(true);

    const call = execFileMock.mock.calls[0];
    expect(call?.[0]).toBe("notify-send");
    const options = call?.[2] as { timeout?: number } | undefined;
    expect(options?.timeout).toBeGreaterThan(0);
  });

  it("resolves on darwin when osascript never exits, once the timeout elapses", async () => {
    platformMock = vi.fn(() => "darwin");
    vi.useFakeTimers();
    const { sendDesktopNotification } = await import("../../src/desktop-notify.js");

    let settled = false;
    const pending = sendDesktopNotification({ title: "Spur", message: "hello" }).then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(settled).toBe(true);

    const call = execFileMock.mock.calls[0];
    expect(call?.[0]).toBe("osascript");
    const options = call?.[2] as { timeout?: number } | undefined;
    expect(options?.timeout).toBeGreaterThan(0);
  });
});
