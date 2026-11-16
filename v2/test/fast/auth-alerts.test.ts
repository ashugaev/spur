import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuthAlerts,
  countSessionsWaiting,
  logAuthFailed,
  observeHostSource,
  type AlertEvaluationInput,
  type AlertEntry,
} from "../../src/auth-alerts.js";
import { readEventLog, resetEventLogCollapse } from "../../src/event-log.js";
import type { QuotaSourceResult } from "../../src/usage-report.js";

const T0 = new Date("2026-11-16T10:00:00.000Z");
const BROKEN_AT = "2026-11-16T09:00:00Z";

function input(overrides: Partial<AlertEvaluationInput> = {}): AlertEvaluationInput {
  return { managed: [], host: [], sessions: [], ...overrides };
}

function managed(brokenAt = BROKEN_AT) {
  return [{ accountId: "acc-1", provider: "claude" as const, label: "Work", brokenAt }];
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "spur-alerts-"));
  const opened: AlertEntry[] = [];
  const make = (writer?: (path: string, content: string) => void) =>
    new AuthAlerts({
      dataDir,
      onOpened: (entry) => opened.push(entry),
      ...(writer ? { write: writer } : {}),
    });
  return { dataDir, opened, make, alerts: make() };
}

function quota(
  status: "ok" | "unauthorized" | "expired" | "rate_limited" | "network_error" | "no_credentials",
): QuotaSourceResult {
  const base = { provider: "codex" as const, source: "codex", label: "codex", fetchedAt: "x" };
  return status === "ok"
    ? { ...base, status: "ok", plan: null, windows: [] }
    : { ...base, status: "error", error: status, message: "m", httpStatus: null };
}

describe("auth alerts", () => {
  it("opens a managed alert once per brokenAt", async () => {
    const s = await setup();
    const result = await s.alerts.evaluate(input({ managed: managed() }), T0);
    expect(result.alerts).toEqual([
      {
        id: "managed:acc-1",
        kind: "managed",
        provider: "claude",
        accountId: "acc-1",
        label: "Work",
        since: BROKEN_AT,
        sessionsWaiting: 0,
      },
    ]);
    expect(s.opened).toHaveLength(1);
  });

  it("repeat evaluation logs nothing", async () => {
    const s = await setup();
    for (let index = 0; index < 4; index += 1) {
      await s.alerts.evaluate(input({ managed: managed() }), new Date(T0.getTime() + index));
    }
    expect(s.opened).toHaveLength(1);
  });

  it("restart over same dataDir logs nothing and keeps the row", async () => {
    const s = await setup();
    await s.alerts.evaluate(input({ managed: managed() }), T0);
    const restarted = s.make();
    const result = await restarted.evaluate(input({ managed: managed() }), T0);
    expect(result.alerts).toHaveLength(1);
    expect(s.opened).toHaveLength(1);
    const unavailable = await s.make().evaluate(input({ managed: null }), T0);
    expect(unavailable.alerts).toHaveLength(1);
    expect(s.opened).toHaveLength(1);
  });

  it("new brokenAt after a verified sign-in reopens with one event", async () => {
    const s = await setup();
    await s.alerts.evaluate(input({ managed: managed() }), T0);
    await s.alerts.evaluate(input({ managed: [] }), T0);
    await s.alerts.evaluate(input({ managed: managed("2026-11-16T09:30:00Z") }), T0);
    await s.alerts.evaluate(input({ managed: managed("2026-11-16T09:30:00Z") }), T0);
    expect(s.opened.map((entry) => entry.since)).toEqual([BROKEN_AT, "2026-11-16T09:30:00Z"]);
  });

  it("row closes when brokenAt disappears", async () => {
    const s = await setup();
    await s.alerts.evaluate(input({ managed: managed() }), T0);
    const closed = await s.alerts.evaluate(input({ managed: [] }), T0);
    expect(closed.alerts).toEqual([]);
    expect(JSON.parse(await readFile(join(s.dataDir, "auth-alerts.json"), "utf8")).entries).toEqual(
      [],
    );
  });

  it("host expired/unauthorized open once, ok and rate_limited close, other errors leave state", async () => {
    expect(observeHostSource(quota("expired"))).toBe("broken");
    expect(observeHostSource(quota("unauthorized"))).toBe("broken");
    expect(observeHostSource(quota("ok"))).toBe("ok");
    expect(observeHostSource(quota("rate_limited"))).toBe("ok");
    for (const kind of ["network_error", "no_credentials"] as const) {
      expect(observeHostSource(quota(kind))).toBe("unknown");
    }
    const s = await setup();
    const broken = input({ host: [{ provider: "codex", observation: "broken" }] });
    const first = await s.alerts.evaluate(broken, T0);
    const later = await s.alerts.evaluate(broken, new Date(T0.getTime() + 60_000));
    expect(first.alerts[0]).toMatchObject({
      id: "host:codex",
      kind: "host",
      since: T0.toISOString(),
    });
    expect(later.alerts[0]?.since).toBe(T0.toISOString());
    expect(s.opened).toHaveLength(1);
    const unknown = await s.alerts.evaluate(
      input({ host: [{ provider: "codex", observation: "unknown" }] }),
      T0,
    );
    expect(unknown.alerts).toHaveLength(1);
    const ok = await s.alerts.evaluate(
      input({ host: [{ provider: "codex", observation: "ok" }] }),
      T0,
    );
    expect(ok.alerts).toEqual([]);
    await s.alerts.evaluate(broken, new Date(T0.getTime() + 120_000));
    expect(s.opened).toHaveLength(2);
  });

  it("concurrent evaluations log one event", async () => {
    const s = await setup();
    await Promise.all(
      Array.from({ length: 8 }, () => s.alerts.evaluate(input({ managed: managed() }), T0)),
    );
    expect(s.opened).toHaveLength(1);
  });

  it("failed file write logs nothing and next evaluation logs once", async () => {
    const s = await setup();
    const failing = vi.fn(() => {
      throw new Error("disk full");
    });
    const broken = s.make(failing);
    const first = await broken.evaluate(input({ managed: managed() }), T0);
    expect(first.alerts).toHaveLength(1);
    expect(s.opened).toHaveLength(0);
    await broken.evaluate(input({ managed: managed() }), T0);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(s.opened).toHaveLength(0);
    const healthy = s.make();
    await healthy.evaluate(input({ managed: managed() }), T0);
    await healthy.evaluate(input({ managed: managed() }), T0);
    expect(s.opened).toHaveLength(1);
  });

  it("companion unavailable skips managed part", async () => {
    const s = await setup();
    const result = await s.alerts.evaluate(input({ managed: null }), T0);
    expect(result.alerts).toEqual([]);
    expect(s.opened).toHaveLength(0);
  });

  it("sessionsWaiting counts non-terminal bound sessions", async () => {
    const sessions: Parameters<typeof countSessionsWaiting>[0] = [
      { status: "running", auth: { effectiveAccountId: "acc-1" } },
      { status: "paused", auth: { effectiveAccountId: "acc-1" } },
      { status: "completed", auth: { effectiveAccountId: "acc-1" } },
      { status: "killed", auth: { effectiveAccountId: "acc-1" } },
      { status: "running", auth: { effectiveAccountId: "acc-2" } },
      { status: "running" },
    ];
    expect(countSessionsWaiting(sessions, "acc-1")).toBe(2);
    const s = await setup();
    const result = await s.alerts.evaluate(input({ managed: managed(), sessions }), T0);
    expect(result.alerts[0]?.sessionsWaiting).toBe(2);
  });

  it("writes one session.auth.failed line per breakage through the real log path", async () => {
    resetEventLogCollapse();
    const dataDir = await mkdtemp(join(tmpdir(), "spur-alerts-log-"));
    const alerts = new AuthAlerts({ dataDir, onOpened: (entry) => logAuthFailed(dataDir, entry) });
    const breakages = ["acc-1", "acc-2", "acc-3"].map((accountId) => ({
      accountId,
      provider: "claude" as const,
      label: accountId,
      brokenAt: BROKEN_AT,
    }));

    await alerts.evaluate(input({ managed: breakages }), T0);

    const lines = readEventLog(dataDir).filter((entry) => entry.event === "session.auth.failed");
    expect(lines.map((line) => line.details)).toEqual([
      { kind: "managed", provider: "claude", accountId: "acc-1" },
      { kind: "managed", provider: "claude", accountId: "acc-2" },
      { kind: "managed", provider: "claude", accountId: "acc-3" },
    ]);
    resetEventLogCollapse();
  });

  it("gathers a function input inside the chain, after the earlier evaluation settled", async () => {
    const s = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = vi.fn(() => input({ managed: [] }));

    const first = s.alerts.evaluate(async () => {
      await gate;
      return input({ managed: managed() });
    }, T0);
    const closing = s.alerts.evaluate(second, T0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second).not.toHaveBeenCalled();
    release();

    expect((await first).alerts).toHaveLength(1);
    expect((await closing).alerts).toEqual([]);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
