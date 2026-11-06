import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTestContext, type RuntimeTestContext } from "../helpers/runtime.js";
import type * as Common from "../helpers/common.js";

const spawn = vi.hoisted(() => vi.fn<typeof ChildProcess.spawn>());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn,
}));
vi.mock("../helpers/common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Common>()),
  execFileAsync: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

class FakeChild extends EventEmitter {
  pid: number | undefined = 424242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true);

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function failureOf(startup: Promise<unknown>): Promise<Error> {
  return startup.then(
    () => {
      throw new Error("Expected startup to fail");
    },
    (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return error;
    },
  );
}

describe("runtime daemon startup boundary", () => {
  let context: RuntimeTestContext;
  let child: FakeChild;
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    // No daemon, tmux server or provider is launched by these fixtures.
    context = await createRuntimeTestContext(42424, { useFakeTools: false });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeChild();
    spawn.mockReset();
    spawn.mockReturnValue(child as unknown as ReturnType<typeof ChildProcess.spawn>);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete context.env.CI_STARTUP_TEST_TOKEN;
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("returns the existing success fields, drains both streams and never kills the child", async () => {
    fetchMock.mockImplementation(async () => {
      child.stdout.write("starting\n");
      child.stderr.write("startup warning\n");
      return new Response(JSON.stringify({ pid: child.pid }));
    });
    const result = await context.startDaemon(`${context.rootDir}/test.yaml`);
    expect(result).toEqual({ child, stdout: "starting\n", info: { pid: child.pid } });
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    child.exit(0);
  });

  it.each([
    [2, null],
    [null, "SIGTERM"],
  ] as const)("retains early exit %s/%s and private capped output tails", async (code, signal) => {
    context.env.CI_STARTUP_TEST_TOKEN = "fixture-startup-secret";
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    child.stdout.write(`discard-stdout${"x".repeat(9000)}stdout-tail`);
    child.stderr.write(
      `discard-stderr${"y".repeat(9000)}startup failed ${context.rootDir}/test.yaml ` +
        `${context.repoDir} ${context.originDir} /home/private-user/config fixture-startup-secret ` +
        "password=fixture-config-secret https://user:fixture-url-secret@example.invalid/private",
    );
    child.exit(code, signal);
    const error = await failure;
    expect(error.message).toContain(`"exitCode":${code}`);
    expect(error.message).toContain(`"signal":${JSON.stringify(signal)}`);
    expect(error.message).toContain("stdout-tail");
    expect(error.message).toContain("startup failed");
    expect(error.message).toContain("owned child exited");
    for (const hidden of [
      "discard-stdout",
      "discard-stderr",
      context.rootDir,
      context.repoDir,
      context.originDir,
      "/home/private-user",
      "fixture-startup-secret",
      "fixture-config-secret",
      "fixture-url-secret",
    ]) {
      expect(error.message).not.toContain(hidden);
    }
    expect(error.message.length).toBeLessThan(9000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the last transport failure and its connection error code", async () => {
    fetchMock.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      }),
    );
    child.kill.mockImplementation((signal) => {
      child.exit(null, signal);
      return true;
    });
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await failure;
    expect(error.message).toContain("TypeError: fetch failed (ECONNREFUSED)");
    expect(error.message).toContain('"lastHttp":"no response"');
  });

  it("retains spawn failure without signaling a child that never acquired a PID", async () => {
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    child.pid = undefined;
    child.emit("error", new Error(`spawn ENOENT ${context.rootDir}/test.yaml`));
    const error = await failure;
    expect(error.message).toContain("spawn ENOENT");
    expect(error.message).toContain('"spawnError":');
    expect(error.message).not.toContain(context.rootDir);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the 20s readiness deadline and last HTTP 503, then awaits graceful child exit", async () => {
    fetchMock.mockImplementation(
      async () => new Response("private response body", { status: 503 }),
    );
    child.kill.mockImplementation((signal) => {
      setTimeout(() => child.exit(null, signal), 500);
      return true;
    });
    let settled = false;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`)).then((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await failure;
    expect(error.message).toContain("HTTP 503");
    expect(error.message).not.toContain("private response body");
    expect(error.message).toContain("owned child exited");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])(
    "bounds a hung HTTP %s read by the remaining deadline",
    async (phase) => {
      if (phase === "body") {
        const response = new Response("unused");
        response.text = () => new Promise(() => {});
        fetchMock.mockResolvedValue(response);
      }
      fetchMock.mockResolvedValueOnce(new Response("starting", { status: 503 }));
      child.kill.mockImplementation((signal) => {
        child.exit(null, signal);
        return true;
      });
      const started = Date.now();
      const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await failure;
      expect(Date.now() - started).toBe(20_000);
      expect(error.message).toContain("20000ms");
      expect(error.message).toContain(phase === "body" ? "HTTP 200" : "HTTP 503");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("escalates only the owned stubborn child and waits for its actual SIGKILL exit", async () => {
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") setTimeout(() => child.exit(null, signal), 500);
      return true;
    });
    let settled = false;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`)).then((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(20_999);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await failure).message).toContain("owned child exited");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["denied", "unconfirmed"])(
    "reports startup AND unresolved ownership when cleanup is %s",
    async (mode) => {
      child.kill.mockImplementation(() => {
        if (mode === "denied") throw new Error("EPERM");
        return false;
      });
      const started = Date.now();
      const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
      await vi.advanceTimersByTimeAsync(22_000);
      const error = await failure;
      expect(error.message).toContain("20000ms");
      expect(error.message).toContain("UNRESOLVED owned child has not exited");
      expect(error.message).toContain(mode === "denied" ? "EPERM" : "was not delivered");
      expect(Date.now() - started).toBe(22_000);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
