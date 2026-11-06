import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSlotLinks } from "../../src/session-slots.js";
import type { ScriptSourceConfig } from "../../src/types.js";
import type { ScriptProcessResult } from "../../src/event-sources/script-process.js";
import type * as metadataModule from "../../src/metadata.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  read: vi.fn(),
  record: vi.fn(),
  log: vi.fn(),
  crons: [] as { tick: () => void; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock("croner", () => ({
  Cron: class {
    stop = vi.fn();
    constructor(_schedule: string, tick: () => void) {
      mocks.crons.push({ tick, stop: this.stop });
    }
    nextRuns() {
      return [new Date(0), new Date(60_000), new Date(120_000)];
    }
  },
}));
vi.mock("../../src/event-sources/script-process.js", () => ({ runScriptProcess: mocks.run }));
vi.mock("../../src/event-log.js", () => ({ logSpurEvent: mocks.log }));
vi.mock("../../src/metadata.js", async (original) => ({
  ...(await original<typeof metadataModule>()),
  readWorkItemRegistry: mocks.read,
  recordWorkItem: mocks.record,
}));
import { parseScriptOutput, scriptSourceModule } from "../../src/event-sources/script.js";

let dir: string;
const handles: { stop(): void | Promise<void> }[] = [];
const ok = (items: unknown): ScriptProcessResult => ({
  status: "ok",
  stdout: typeof items === "string" ? items : JSON.stringify(items),
  durationMs: 1,
  stderrTail: "",
});
const item = (id: string) => ({ id, title: "Failure", branch: "main" });
async function start(overrides: Partial<ScriptSourceConfig> = {}) {
  const emit = vi.fn();
  const abort = new AbortController();
  const handle = await scriptSourceModule.start({
    sourceId: "check",
    projectId: "api",
    dataDir: dir,
    config: {
      type: "script",
      command: ["./check.sh"],
      cwd: dir,
      env: { REGION: "US" },
      schedule: "* * * * *",
      timeoutMs: 60_000,
      emitExisting: true,
      runOnStart: true,
      ...overrides,
    },
    emit,
    signal: abort.signal,
    logger: { warn: vi.fn() },
    resolveWebBaseUrl: async () => null,
  });
  handles.push(handle);
  return { handle, emit, abort };
}
async function tick() {
  vi.advanceTimersByTime(60_000);
  mocks.crons.at(-1)?.tick();
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
  // Drain run, catch and finally microtasks.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.crons.length = 0;
  mocks.read.mockReturnValue(new Set());
  mocks.run.mockResolvedValue(ok([]));
  dir = await mkdtemp(join(tmpdir(), "spur-script-source-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("script output", () => {
  it("normalizes optional URLs and scalar extras; rejects invalid IDs and fields", () => {
    const parsed = parseScriptOutput(
      JSON.stringify([
        item("a"),
        { ...item("b"), url: " https://EXAMPLE.com " },
        { ...item("c"), url: "" },
        { ...item("d"), url: " " },
        { ...item("e"), url: "/relative" },
        { ...item("f"), url: "malformed" },
        { title: "missing" },
        { ...item("g"), title: "" },
        { ...item("h"), field: {} },
        { ...item("i"), "bad-key": true },
        { ...item("j"), sessionId: "spoof" },
        { ...item("k"), externalId: "spoof" },
        { ...item("l"), repo: "spoof" },
        { ...item("m"), number: -1 },
        { ...item("n"), field: "x".repeat(2049) },
        { ...item("o"), title: "é".repeat(1025) },
        { ...item("p"), field: "x".repeat(2048), flag: true, count: 2 },
        { ...item("a"), title: "duplicate" },
        { ...item("q"), id: "x".repeat(257) },
      ]),
      "check",
    );
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.items.map((x) => x.id)).toEqual(["a", "b", "c", "p"]);
    expect(parsed.items[0]).toEqual({
      ...item("a"),
      url: "",
      number: 0,
      repo: "script:check",
      externalId: "script:check#a",
    });
    expect(parsed.items[1]?.url).toBe("https://example.com/");
    expect(normalizeSlotLinks([{ label: "pr", url: parsed.items[1]?.url as string }])).toHaveLength(
      1,
    );
    expect(parsed.dropped).toHaveLength(14);
  });
  it.each([
    ["", "ok"],
    ["[]", "ok"],
    ["broken", "invalid_json"],
    ["{}", "not_array"],
    [JSON.stringify(Array.from({ length: 501 }, (_, n) => item(String(n)))), "too_many_items"],
  ])("validates run %s", (stdout, status) => {
    const result = parseScriptOutput(stdout, "check");
    expect(result.status === "ok" ? result.status : result.reason).toBe(status);
  });
  it("accepts 500 items", () => {
    const result = parseScriptOutput(
      JSON.stringify(Array.from({ length: 500 }, (_, n) => item(String(n)))),
      "check",
    );
    expect(result.status === "ok" && result.items.length).toBe(500);
  });
});

describe("script source", () => {
  it("runs consecutive scheduled ticks despite callback jitter after prior run completes", async () => {
    mocks.run.mockResolvedValueOnce(ok([item("a")])).mockResolvedValueOnce(ok([item("b")]));
    const { emit } = await start({ runOnStart: false });
    vi.setSystemTime(60_001);
    mocks.crons[0]?.tick();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));

    vi.setSystemTime(120_000);
    mocks.crons[0]?.tick();
    expect(mocks.run).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.log).not.toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ event: "source.script.run.skipped" }),
    );
  });

  it("creates private persistent state and passes identity env", async () => {
    const { handle } = await start();
    handle.runOnStart?.();
    await tick();
    const stateDir = join(dir, "source-state", "script", "api", "check");
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          REGION: "US",
          SPUR_SOURCE_ID: "check",
          SPUR_PROJECT_ID: "api",
          SPUR_STATE_DIR: stateDir,
        },
      }),
    );
  });
  it("establishes nonempty baseline by default and emits only later new IDs", async () => {
    mocks.run.mockResolvedValue(ok([item("a")]));
    const { handle, emit } = await start({ emitExisting: false });
    handle.runOnStart?.();
    await tick();
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    mocks.run.mockResolvedValue(ok([item("a"), item("b")]));
    await tick();
    expect(emit).toHaveBeenCalledExactlyOnceWith("script:item.new", {
      ...item("b"),
      number: 0,
      url: "",
      repo: "script:check",
      externalId: "script:check#b",
    });
  });
  it("emits first positive condition once after empty run", async () => {
    const { handle, emit } = await start();
    handle.runOnStart?.();
    await tick();
    expect(mocks.record).not.toHaveBeenCalled();
    mocks.run.mockResolvedValue(ok([item("a")]));
    await tick();
    await tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "drains replayed snapshots ten per run, with prior registry=%s",
    async (existing) => {
      if (existing) mocks.read.mockReturnValue(new Set(["script:check#old"]));
      mocks.run.mockResolvedValue(ok(Array.from({ length: 25 }, (_, n) => item(String(n)))));
      const { handle, emit } = await start();
      handle.runOnStart?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(emit).toHaveBeenCalledTimes(10);
      expect(mocks.record).toHaveBeenCalledTimes(10);
      await tick();
      expect(emit).toHaveBeenCalledTimes(20);
      await tick();
      await tick();
      expect(emit).toHaveBeenCalledTimes(25);
      expect(mocks.record).toHaveBeenCalledTimes(25);
    },
  );
  it("retains persisted dedupe across source restart", async () => {
    mocks.read.mockReturnValue(new Set(["script:check#a"]));
    mocks.run.mockResolvedValue(ok([item("a")]));
    const { handle, emit } = await start();
    handle.runOnStart?.();
    await tick();
    expect(emit).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each([
    ok("broken"),
    ok("{}"),
    ok(Array.from({ length: 501 }, (_, n) => item(String(n)))),
    {
      status: "failed",
      reason: "exit",
      exitCode: 1,
      signal: null,
      durationMs: 1,
      stderrTail: "oops",
    },
  ])("records nothing on failed runs", async (result) => {
    mocks.run.mockResolvedValue(result);
    const { handle, emit } = await start();
    handle.runOnStart?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith(
      dir,
      expect.objectContaining({ event: "source.script.run.failed" }),
    );
  });
  it("drops invalid URL before recording and logs one drop warning", async () => {
    mocks.run.mockResolvedValue(ok([{ ...item("a"), url: "bad" }, item("b")]));
    const { handle, emit } = await start();
    handle.runOnStart?.();
    await tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(mocks.record).not.toHaveBeenCalledWith(dir, "api", "check", "script:check#a");
    expect(mocks.log).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({
        event: "source.script.items.dropped",
        details: { count: 1, items: ["0: invalid item"] },
      }),
    );
  });
  it("prevents overlap and discards resolve-before-stop result", async () => {
    let resolve: (value: ScriptProcessResult) => void = () => {};
    mocks.run.mockImplementation(
      () =>
        new Promise<ScriptProcessResult>((done) => {
          resolve = done;
        }),
    );
    const { handle, emit } = await start();
    handle.runOnStart?.();
    await tick();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const signal = mocks.run.mock.calls[0]?.[0].signal as AbortSignal;
    resolve(ok([item("a")]));
    const stopping = handle.stop();
    await stopping;
    expect(signal.aborted).toBe(true);
    expect(mocks.crons[0]?.stop).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(
      mocks.log.mock.calls.some(([, entry]) => entry.event === "source.script.run.failed"),
    ).toBe(false);
  });
  it("schedules without an initial run when runOnStart=false", async () => {
    const { handle } = await start({ runOnStart: false });
    expect(handle.runOnStart).toBeUndefined();
    expect(mocks.run).not.toHaveBeenCalled();
    await tick();
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
