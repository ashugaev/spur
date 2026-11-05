import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CodexRateLimitPoller } from "../../src/agents/codex-rate-limits.js";
import { readCodexRolloutState, type CodexRolloutReaderState } from "../../src/agents/codex.js";

const localTime = Date.parse("2026-11-05T13:00:00.000Z");
const dirs: string[] = [];

function record(timestamp: string | null, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    ...(timestamp ? { timestamp } : {}),
    type: "event_msg",
    payload: { type, ...payload },
  });
}

function quota(timestamp: string | null, limited: boolean): string {
  return record(timestamp, "token_count", {
    rate_limits: {
      rate_limit_reached_type: limited ? "workspace_member_credits_depleted" : null,
      primary: { used_percent: limited ? 100 : 10 },
    },
  });
}

function appServer(permission: boolean) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: (line: string) => boolean };
    kill: () => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      const initialize = line.includes('"method":"initialize"');
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              id: initialize ? 1 : 2,
              result: initialize ? {} : { ordinaryUsageAllowed: permission },
            })}\n`,
          ),
        );
      });
      return true;
    },
  });
  child.kill = () => {
    child.emit("close", null);
    return true;
  };
  return child;
}

async function rollout(lines: string[]) {
  const root = await mkdtemp(join(tmpdir(), "codex-ordering-"));
  dirs.push(root);
  const sessionsDir = join(root, "sessions", "2026", "11", "05");
  await mkdir(sessionsDir, { recursive: true });
  const file = join(sessionsDir, "rollout-test.jsonl");
  await writeFile(file, `${lines.join("\n")}\n`);
  return { file, sessionsDir: join(root, "sessions"), home: root };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(localTime);
  spawnMock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Codex rollout and permission ordering", () => {
  it("holds a quota-only backward token count until a fresh allow", async () => {
    spawnMock.mockImplementation(() => appServer(true));
    const source = await rollout([quota("2026-11-05T12:00:00.000Z", true)]);
    const reader: CodexRolloutReaderState = { files: new Map() };
    const poller = new CodexRateLimitPoller();
    const initial = await readCodexRolloutState(source.sessionsDir, reader);
    expect(initial.rollout).toBeNull();
    expect(initial.rateLimit?.limited).toBe(true);
    expect(initial.rateLimitObservedAtMs).toBe(localTime);
    expect(
      poller.permission("session", source.home, initial.rateLimitObservedAtMs ?? 0),
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poller.permission("session", source.home, initial.rateLimitObservedAtMs ?? 0)).toBe(
      true,
    );

    vi.setSystemTime(localTime + 120_000);
    await appendFile(source.file, `${quota("2026-11-05T11:59:00.000Z", true)}\n`);
    const late = await readCodexRolloutState(source.sessionsDir, reader);
    expect(late.rollout).toBeNull();
    expect(late.rateLimit?.limited).toBe(true);
    expect(late.rateLimitObservedAtMs).toBe(localTime + 120_000);
    expect(poller.permission("session", source.home, late.rateLimitObservedAtMs ?? 0)).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(poller.permission("session", source.home, late.rateLimitObservedAtMs ?? 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(poller.permission("session", source.home, late.rateLimitObservedAtMs ?? 0)).toBe(true);
    poller.dispose();
  });

  it("keeps a backward hard completion through same-turn telemetry", async () => {
    spawnMock.mockImplementation(() => appServer(true));
    const source = await rollout([
      record("2026-11-05T12:00:00.000Z", "task_started", { turn_id: "one" }),
      record("2026-11-05T12:00:01.000Z", "task_complete", { turn_id: "one" }),
    ]);
    const reader: CodexRolloutReaderState = { files: new Map() };
    const poller = new CodexRateLimitPoller();
    const clean = await readCodexRolloutState(source.sessionsDir, reader);
    poller.permission("session", source.home, clean.rateLimitObservedAtMs ?? 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poller.permission("session", source.home, clean.rateLimitObservedAtMs ?? 0)).toBe(true);

    vi.setSystemTime(localTime + 120_000);
    await appendFile(
      source.file,
      [
        record("2026-11-05T11:59:00.000Z", "task_complete", {
          turn_id: "two",
          error: { codex_error_info: "usage_limit_exceeded" },
        }),
        quota("2026-11-05T11:59:01.000Z", false),
      ].join("\n") + "\n",
    );
    const hard = await readCodexRolloutState(source.sessionsDir, reader);
    expect(hard.rateLimit?.limited).toBe(true);
    expect(hard.rateLimit?.reason).toBe("codex usage_limit_exceeded");
    expect(hard.rateLimitObservedAtMs).toBe(localTime + 120_000);
    expect(poller.permission("session", source.home, hard.rateLimitObservedAtMs ?? 0)).toBeNull();
    expect(poller.permission("session", source.home, hard.rateLimitObservedAtMs ?? 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poller.permission("session", source.home, hard.rateLimitObservedAtMs ?? 0)).toBe(true);

    await appendFile(
      source.file,
      `${record("2026-11-05T11:58:00.000Z", "task_started", { turn_id: "three" })}\n`,
    );
    expect((await readCodexRolloutState(source.sessionsDir, reader)).rateLimit?.limited).toBe(
      false,
    );
    poller.dispose();
  });

  it("does not drift on replay, future dates, undated records or same-millisecond probes", async () => {
    spawnMock.mockImplementation(() => appServer(true));
    const source = await rollout([
      ...Array.from({ length: 200 }, () => quota("2099-01-01T00:00:00.000Z", true)),
      quota(null, true),
    ]);
    const reader: CodexRolloutReaderState = { files: new Map() };
    const first = await readCodexRolloutState(source.sessionsDir, reader);
    expect(first.rateLimitObservedAtMs).toBe(localTime);
    vi.setSystemTime(localTime + 1_000);
    expect((await readCodexRolloutState(source.sessionsDir, reader)).rateLimitObservedAtMs).toBe(
      localTime,
    );
    const poller = new CodexRateLimitPoller();
    poller.permission("session", source.home, 0);
    await vi.advanceTimersByTimeAsync(60_000);
    const probeAt = Date.now();
    await appendFile(source.file, `${quota(null, true)}\n`);
    const sameMs = await readCodexRolloutState(source.sessionsDir, reader);
    expect(sameMs.rateLimitObservedAtMs).toBe(probeAt);
    expect(poller.permission("session", source.home, sameMs.rateLimitObservedAtMs ?? 0)).toBeNull();
    vi.setSystemTime(probeAt + 1_000);
    await writeFile(source.file, `${quota("2020-01-01T00:00:00.000Z", true)}\n`);
    const replayed = await readCodexRolloutState(source.sessionsDir, reader);
    expect(replayed.rateLimitObservedAtMs).toBe(probeAt + 1_000);
    poller.dispose();
  });
});
