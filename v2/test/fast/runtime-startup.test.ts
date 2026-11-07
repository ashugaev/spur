import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTestContext, type RuntimeTestContext } from "../helpers/runtime.js";
import * as Common from "../helpers/common.js";

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
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true);

  exit(code: number | null, signal: NodeJS.Signals | null = null, close = true): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    if (close) this.close();
  }

  close(): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", this.exitCode, this.signalCode);
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

// Run the destructive safety-net probe in a fresh process/registry. Its filter
// excludes the shared-context suite below, including that suite's setup hooks.
if (process.env.SPUR_RUNTIME_CLEANUP_PROBE === "1") {
  it("isolated global cleanup preserves unresolved startup fixtures", async () => {
    const fixture = await createRuntimeTestContext(42424, { useFakeTools: false });
    const successfulFixture = await createRuntimeTestContext(42425, { useFakeTools: false });
    const control = await Common.createTempDir("spur-cleanup-control-");
    const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()] as const;
    const [first, second, laterSuccess, unrelatedSuccess] = children;
    for (const owned of [first, second]) {
      owned.kill.mockImplementation(() => {
        owned.killed = true;
        return true;
      });
    }
    const fetchMock = vi.fn<typeof fetch>(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      spawn.mockReturnValue(first as unknown as ReturnType<typeof ChildProcess.spawn>);
      const firstFailure = failureOf(fixture.startDaemon(`${fixture.rootDir}/first.yaml`));
      await vi.advanceTimersByTimeAsync(22_250);
      const firstError = await firstFailure;
      spawn.mockReturnValue(second as unknown as ReturnType<typeof ChildProcess.spawn>);
      const secondFailure = failureOf(fixture.startDaemon(`${fixture.rootDir}/second.yaml`));
      await vi.advanceTimersByTimeAsync(22_250);
      const secondError = await secondFailure;
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pid: 424242 })));
      spawn.mockReturnValue(laterSuccess as unknown as ReturnType<typeof ChildProcess.spawn>);
      expect((await fixture.startDaemon(`${fixture.rootDir}/later.yaml`)).child).toBe(laterSuccess);
      laterSuccess.exit(0);
      spawn.mockReturnValue(unrelatedSuccess as unknown as ReturnType<typeof ChildProcess.spawn>);
      await successfulFixture.startDaemon(`${successfulFixture.rootDir}/success.yaml`);
      unrelatedSuccess.exit(0);

      await Common.cleanupTrackedTempDirs();
      for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
        expect(
          existsSync(directory),
          "global safety net must preserve unresolved owned fixtures",
        ).toBe(true);
      }
      for (const directory of [
        control,
        successfulFixture.rootDir,
        successfulFixture.repoDir,
        successfulFixture.originDir,
      ]) {
        expect(
          existsSync(directory),
          "unrelated and successful fixtures retain global cleanup",
        ).toBe(false);
      }
      const cleanupError: unknown = await fixture.cleanup().catch((error: unknown) => error);
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toContain(firstError.message);
      expect((cleanupError as Error).message).toContain(secondError.message);
      first.exit(0);
      await expect(fixture.cleanup()).rejects.toThrow("UNRESOLVED");
      for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
        expect(existsSync(directory)).toBe(true);
      }
      second.exit(0);
      await fixture.cleanup();
      for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
        expect(existsSync(directory)).toBe(false);
      }
    } finally {
      for (const owned of children) {
        if (owned.exitCode === null && owned.signalCode === null) owned.exit(0);
        owned.stdout.destroy();
        owned.stderr.destroy();
      }
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await fixture.cleanup();
      await successfulFixture.cleanup();
      await rm(control, { recursive: true, force: true });
    }
  });
} else {
  it("runs global cleanup in an isolated registry", async () => {
    const witness = await Common.createTempDir("spur-cleanup-parent-");
    const parentFile = `${witness}/parent-owned`;
    const resultsFile = `${witness}/results.json`;
    try {
      await writeFile(parentFile, "parent fixture");
      const result = ChildProcess.spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
          "run",
          "--config",
          "vitest.fast.config.ts",
          "--reporter=json",
          "--outputFile",
          resultsFile,
          "test/fast/runtime-startup.test.ts",
          "-t",
          "^isolated global cleanup preserves unresolved startup fixtures$",
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: { ...process.env, SPUR_RUNTIME_CLEANUP_PROBE: "1" },
          timeout: 15_000,
          stdio: "pipe",
          encoding: "utf8",
        },
      );
      let output = `${result.stdout}\n${result.stderr}`
        .replaceAll(fileURLToPath(new URL("../../", import.meta.url)), "[test-root]")
        .replaceAll(witness, "[parent-fixture]");
      const homeDirectory = process.env.HOME;
      if (homeDirectory) output = output.replaceAll(homeDirectory, "[home]");
      expect(result.status, output).toBe(0);
      let summary: unknown;
      try {
        summary = JSON.parse(await readFile(resultsFile, "utf8"));
      } catch {
        throw new Error("Isolated cleanup probe did not emit JSON test results");
      }
      expect(summary).toMatchObject({ numPassedTests: 1, numFailedTests: 0 });
      expect(existsSync(parentFile), "child registry cannot delete parent fixtures").toBe(true);
    } finally {
      await rm(witness, { recursive: true, force: true });
    }
  });
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
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.exit(0);
    }
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

  it("native browser probe: masks stderr ending two bytes into the credential emoji", async () => {
    context.env.CI_STARTUP_TEST_TOKEN = "private-🔐-credential";
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    const bytes = Buffer.from(context.env.CI_STARTUP_TEST_TOKEN);
    child.stderr.write(bytes.subarray(0, bytes.indexOf(Buffer.from("🔐")) + 2));
    child.exitCode = 2;
    child.emit("exit", 2, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 2, null);
    const error = await failure;
    expect(error.message).not.toContain("private-");
    expect(error.message).toContain('"outputClosed":true');
  });

  it.each([false, true])(
    "preserves all fixtures while failed-start child signal delivery is %s",
    async (delivered) => {
      const fixture = await createRuntimeTestContext(42424, { useFakeTools: false });
      child.kill.mockImplementation(() => {
        child.killed = delivered;
        return delivered;
      });
      try {
        const failure = failureOf(fixture.startDaemon(`${fixture.rootDir}/test.yaml`));
        await vi.advanceTimersByTimeAsync(22_250);
        const startupError = await failure;
        expect(startupError.message).toContain("UNRESOLVED owned child has not exited");
        expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        const cleanupError: unknown = await fixture.cleanup().catch((error: unknown) => error);
        for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
          expect(
            existsSync(directory),
            "live failed-start child still owns fixture directories",
          ).toBe(true);
        }
        expect(cleanupError).toBeInstanceOf(Error);
        expect((cleanupError as Error).message).toContain(startupError.message);
        // Repeated ordinary cleanup must neither signal again nor discard ownership.
        await expect(fixture.cleanup()).rejects.toThrow("UNRESOLVED");
        expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
        child.exit(0);
        await fixture.cleanup();
        for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
          expect(existsSync(directory)).toBe(false);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.exit(0);
        await fixture.cleanup();
      }
    },
  );

  it("retains earlier failed-start ownership after a later successful launch", async () => {
    const fixture = await createRuntimeTestContext(42424, { useFakeTools: false });
    const successfulChild = new FakeChild();
    successfulChild.pid = 424243;
    child.kill.mockReturnValue(false);
    try {
      const failure = failureOf(fixture.startDaemon(`${fixture.rootDir}/first.yaml`));
      await vi.advanceTimersByTimeAsync(22_250);
      const startupError = await failure;
      spawn.mockReturnValue(successfulChild as unknown as ReturnType<typeof ChildProcess.spawn>);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ pid: successfulChild.pid })));
      const result = await fixture.startDaemon(`${fixture.rootDir}/second.yaml`);
      expect(result.child).toBe(successfulChild);
      expect(successfulChild.kill).not.toHaveBeenCalled();
      const cleanupError: unknown = await fixture.cleanup().catch((error: unknown) => error);
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toContain(startupError.message);
      for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
        expect(existsSync(directory)).toBe(true);
      }
    } finally {
      child.exit(0);
      successfulChild.exit(0);
      await fixture.cleanup();
    }
  });

  it("retains each original startup failure until every failed child has actually exited", async () => {
    const fixture = await createRuntimeTestContext(42424, { useFakeTools: false });
    const secondChild = new FakeChild();
    secondChild.pid = 424243;
    child.kill.mockReturnValue(false);
    secondChild.kill.mockReturnValue(false);
    try {
      fetchMock.mockRejectedValue(new Error("fetch failed", { cause: { code: "FIRST_FAILURE" } }));
      const first = failureOf(fixture.startDaemon(`${fixture.rootDir}/first.yaml`));
      await vi.advanceTimersByTimeAsync(22_250);
      await first;
      spawn.mockReturnValue(secondChild as unknown as ReturnType<typeof ChildProcess.spawn>);
      fetchMock.mockRejectedValue(new Error("fetch failed", { cause: { code: "SECOND_FAILURE" } }));
      const second = failureOf(fixture.startDaemon(`${fixture.rootDir}/second.yaml`));
      await vi.advanceTimersByTimeAsync(22_250);
      await second;
      let cleanupError: unknown = await fixture.cleanup().catch((error: unknown) => error);
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toContain("FIRST_FAILURE");
      expect((cleanupError as Error).message).toContain("SECOND_FAILURE");
      child.exit(0);
      cleanupError = await fixture.cleanup().catch((error: unknown) => error);
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toContain("SECOND_FAILURE");
      for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
        expect(existsSync(directory)).toBe(true);
      }
      secondChild.exit(0);
      await fixture.cleanup();
      for (const directory of [fixture.rootDir, fixture.repoDir, fixture.originDir]) {
        expect(existsSync(directory)).toBe(false);
      }
    } finally {
      if (child.exitCode === null) child.exit(0);
      if (secondChild.exitCode === null) secondChild.exit(0);
      await fixture.cleanup();
    }
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

  it.each(["one chunk", "split chunks"])(
    "redacts secrets crossing the tail cutoff in %s",
    async (mode) => {
      const secret = "cutoff-private-prefix-private-suffix";
      context.env.CI_STARTUP_TEST_TOKEN = secret;
      const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
      const padding = "x".repeat(4096 - "private-suffix".length);
      for (const stream of [child.stdout, child.stderr]) {
        if (mode === "one chunk") stream.write(`discard${secret}${padding}`);
        else {
          stream.write(`discard${secret.slice(0, 25)}`);
          stream.write(`${secret.slice(25)}${padding}`);
        }
      }
      child.exit(2);
      const error = await failure;
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("private-suffix");
      expect(error.message).not.toContain("cutoff-private");
      expect(error.message.length).toBeLessThan(9000);
    },
  );

  it("masks overlapping fixture-path and credential matches without exposing either suffix", async () => {
    context.env.CI_STARTUP_TEST_TOKEN = `${context.rootDir}/overlapping-private-suffix`;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    child.stderr.write(`startup ${context.env.CI_STARTUP_TEST_TOKEN}`);
    child.exit(2);
    const error = await failure;
    expect(error.message).not.toContain(context.rootDir);
    expect(error.message).not.toContain("overlapping-private-suffix");
  });

  it("redacts a credential split inside a UTF-8 stream character", async () => {
    const secret = "private-🔐-credential";
    context.env.CI_STARTUP_TEST_TOKEN = secret;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    const bytes = Buffer.from(secret);
    const split = bytes.indexOf(Buffer.from("🔐")) + 2;
    child.stderr.write(bytes.subarray(0, split));
    child.stderr.write(bytes.subarray(split));
    child.exit(2);
    const error = await failure;
    expect(error.message).not.toContain("private-");
    expect(error.message).not.toContain("-credential");
    expect(error.message).not.toContain("�");
  });

  it.each([
    ["private-é", 1],
    ["private-€", 1],
    ["private-€", 2],
    ["private-🔐-credential", 1],
    ["private-🔐-credential", 2],
    ["private-🔐-credential", 3],
  ] as const)("redacts %s interrupted after %s character bytes at close", async (secret, count) => {
    context.env.CI_STARTUP_TEST_TOKEN = secret;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    const bytes = Buffer.from(secret);
    const split = Buffer.byteLength("private-") + count;
    child.stdout.write(bytes.subarray(0, split));
    child.stderr.write(bytes.subarray(0, split));
    child.exit(2);
    const error = await failure;
    expect(error.message).not.toContain("private-");
    expect(error.message).toContain("[redacted]");
    expect(error.message).toContain('"outputClosed":true');
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("redacts an unfinished credential split across chunks longer than the retained tail", async () => {
    const middle = "s".repeat(6000);
    context.env.CI_STARTUP_TEST_TOKEN = `private-start-${middle}-private-end`;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    child.stderr.write(`context private-start-${middle.slice(0, 3000)}`);
    child.stderr.write(middle.slice(3000));
    child.exit(2);
    const error = await failure;
    expect(error.message).not.toContain("s".repeat(20));
    expect(error.message).toContain("[redacted]");
    expect(error.message.length).toBeLessThan(9000);
  });

  it("redacts a credential prefix when failure interrupts a stream chunk boundary", async () => {
    context.env.CI_STARTUP_TEST_TOKEN = "unfinished-private-credential";
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    child.stderr.write("startup unfinished-private-");
    child.exit(2);
    expect((await failure).message).not.toContain("unfinished-private-");
  });

  it("retains stderr arriving after exit and waits for pipe closure before rejecting", async () => {
    let settled = false;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`)).then((error) => {
      settled = true;
      return error;
    });
    child.exit(2, null, false);
    setTimeout(() => child.stderr.write("late startup error\n"), 100);
    setTimeout(() => child.close(), 200);
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await failure;
    expect(error.message).toContain("late startup error");
    expect(error.message).toContain('"exitCode":2');
    expect(error.message).toContain('"outputClosed":true');
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds post-exit drainage when a pipe stays open", async () => {
    let settled = false;
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`)).then((error) => {
      settled = true;
      return error;
    });
    child.exit(2, null, false);
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await failure;
    expect(error.message).toContain('"exitCode":2');
    expect(error.message).toContain('"outputClosed":false');
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains spawn failure without signaling a child that never acquired a PID", async () => {
    const failure = failureOf(context.startDaemon(`${context.rootDir}/test.yaml`));
    child.pid = undefined;
    child.emit("error", new Error(`spawn ENOENT ${context.rootDir}/test.yaml`));
    child.close();
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
        vi.spyOn(response, "text").mockImplementation(() => new Promise<string>(() => {}));
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
      await vi.advanceTimersByTimeAsync(22_250);
      const error = await failure;
      expect(error.message).toContain("20000ms");
      expect(error.message).toContain("UNRESOLVED owned child has not exited");
      expect(error.message).toContain(mode === "denied" ? "EPERM" : "was not delivered");
      expect(Date.now() - started).toBe(22_250);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
