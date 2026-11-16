import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthQuota,
  quotaFromWindows,
  type AuthQuotaAccount,
  type UsageEntry,
} from "../../src/auth-quota.js";

const claude = (id: string): AuthQuotaAccount => ({
  id,
  provider: "claude",
  status: "ready",
  credential: "oauth",
});
const codex = (id: string): AuthQuotaAccount => ({
  id,
  provider: "codex",
  status: "ready",
  credential: "oauth",
});

const claudeBody = (five: number, week: number): string =>
  JSON.stringify({
    five_hour: { utilization: five, resets_at: "2026-11-16T20:00:00Z" },
    seven_day: { utilization: week, resets_at: "2026-11-20T00:00:00Z" },
  });
const ok = (accountId: string, body: string): UsageEntry => ({
  accountId,
  status: "ok",
  httpStatus: 200,
  body,
});

describe("AuthQuota", () => {
  let dataDir: string;
  let clock: number;
  let calls: string[][];
  let answer: (ids: string[]) => Promise<UsageEntry[]>;

  const create = (): AuthQuota =>
    new AuthQuota({
      dataDir,
      now: () => clock,
      fetchUsage: (ids) => {
        calls.push(ids);
        return answer(ids);
      },
    });
  const settle = async (): Promise<void> => {
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-auth-quota-"));
    clock = Date.parse("2026-11-16T12:00:00Z");
    calls = [];
    answer = (ids) => Promise.resolve(ids.map((id) => ok(id, claudeBody(10, 40))));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("reads synchronously while the provider call never resolves, and starts one call for 10 reads", () => {
    answer = () => new Promise(() => undefined);
    const quota = create();
    for (let i = 0; i < 10; i += 1) expect(quota.read([claude("a")]).size).toBe(0);
    expect(calls).toEqual([["a"]]);
  });

  it("stores the tightest window and serves it", async () => {
    const quota = create();
    quota.read([claude("a")]);
    await settle();
    const served = quota.read([claude("a")]).get("a");
    expect(served).toMatchObject({ leftPercent: 60, resetsAt: "2026-11-20T00:00:00Z" });
    expect(served?.windows).toHaveLength(2);
    expect(served?.fetchedAt).toBe("2026-11-16T12:00:00.000Z");
    expect(statSync(join(dataDir, "auth-quota.json")).mode & 0o777).toBe(0o600);
  });

  it("parses Codex bodies", async () => {
    answer = (ids) =>
      Promise.resolve(
        ids.map((id) =>
          ok(
            id,
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1_800_000_000 },
                secondary_window: { used_percent: 5, reset_at: 1_800_100_000 },
              },
            }),
          ),
        ),
      );
    const quota = create();
    quota.read([codex("c")]);
    await settle();
    expect(quota.read([codex("c")]).get("c")?.leftPercent).toBe(75);
  });

  it("chunks due accounts by 4 and runs chunks one after another", async () => {
    const releases: (() => void)[] = [];
    answer = (ids) =>
      new Promise((resolve) => {
        releases.push(() => resolve(ids.map((id) => ok(id, claudeBody(1, 1)))));
      });
    const quota = create();
    const accounts = ["a", "b", "c", "d", "e", "f"].map(claude);
    quota.read(accounts);
    expect(calls).toEqual([["a", "b", "c", "d"]]);
    releases[0]?.();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual(["e", "f"]);
    releases[1]?.();
    await vi.waitFor(() => expect(quota.read(accounts).size).toBe(6));
    expect(calls).toHaveLength(2);
  });

  it("holds a 429 for Retry-After capped at 3600 s and keeps the prior quota", async () => {
    const quota = create();
    quota.read([claude("a")]);
    await settle();
    clock += 180_000;
    answer = (ids) =>
      Promise.resolve(
        ids.map((id) => ({
          accountId: id,
          status: "error" as const,
          httpStatus: 429,
          retryAfterSeconds: 99_999,
        })),
      );
    quota.read([claude("a")]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(quota.read([claude("a")]).get("a")?.leftPercent).toBe(60);
    const stored = JSON.parse(readFileSync(join(dataDir, "auth-quota.json"), "utf8")) as {
      entries: Record<string, { nextAt: number }>;
    };
    expect(stored.entries.a?.nextAt).toBe(clock + 3_600_000);
  });

  it("backs off 180, 360 then 720 s on consecutive errors and drops the quota", async () => {
    answer = (ids) =>
      Promise.resolve(ids.map((id) => ({ accountId: id, status: "error" as const })));
    const quota = create();
    const holds: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      quota.read([claude("a")]);
      await vi.waitFor(() => expect(calls).toHaveLength(attempt + 1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const stored = JSON.parse(readFileSync(join(dataDir, "auth-quota.json"), "utf8")) as {
        entries: Record<string, { nextAt: number }>;
      };
      holds.push(((stored.entries.a?.nextAt ?? 0) - clock) / 1000);
      clock = stored.entries.a?.nextAt ?? clock;
    }
    expect(holds).toEqual([180, 360, 720]);
    expect(quota.read([claude("a")]).size).toBe(0);
  });

  it("counts a rejected call as one error for every requested id", async () => {
    answer = () => Promise.reject(new Error("timeout"));
    const quota = create();
    quota.read([claude("a"), claude("b")]);
    await settle();
    const stored = JSON.parse(readFileSync(join(dataDir, "auth-quota.json"), "utf8")) as {
      entries: Record<string, { nextAt: number; failures: number }>;
    };
    expect(stored.entries.a).toMatchObject({ failures: 1, nextAt: clock + 180_000 });
    expect(stored.entries.b).toMatchObject({ failures: 1, nextAt: clock + 180_000 });
  });

  it("backs off only the id the companion could not read", async () => {
    answer = (ids) =>
      Promise.resolve(
        ids.map((id) =>
          id === "gone" ? { accountId: id, status: "error" as const } : ok(id, claudeBody(10, 40)),
        ),
      );
    const quota = create();
    quota.read([claude("a"), claude("gone")]);
    await settle();
    const served = quota.read([claude("a"), claude("gone")]);
    expect(served.has("a")).toBe(true);
    expect(served.has("gone")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not burst after a restart inside the hold", async () => {
    create().read([claude("a")]);
    await settle();
    clock += 60_000;
    const restarted = create();
    restarted.read([claude("a")]);
    expect(calls).toHaveLength(1);
    expect(restarted.read([claude("a")]).get("a")?.leftPercent).toBe(60);
  });

  it("never requests API-key or not-ready accounts", () => {
    const quota = create();
    quota.read([
      { id: "key", provider: "claude", status: "ready", credential: "api_key" },
      { id: "out", provider: "claude", status: "sign_in_required", credential: "oauth" },
      { id: "pending", provider: "codex", status: "pending", credential: "oauth" },
      { id: "unknown", provider: "codex", status: "ready" },
    ]);
    expect(calls).toEqual([]);
  });

  it("stops serving quota older than 3600 s", async () => {
    answer = (ids) => Promise.resolve(ids.map((id) => ok(id, claudeBody(10, 40))));
    const quota = create();
    quota.read([claude("a")]);
    await settle();
    clock += 3_601_000;
    answer = () => new Promise(() => undefined);
    expect(quota.read([claude("a")]).size).toBe(0);
  });

  it("prunes removed accounts and keeps other providers on a full-list read", async () => {
    answer = (ids) =>
      Promise.resolve(
        ids.map((id) =>
          ok(
            id,
            id === "c"
              ? JSON.stringify({ rate_limit: { primary_window: { used_percent: 5 } } })
              : claudeBody(10, 40),
          ),
        ),
      );
    const quota = create();
    quota.read([claude("a"), codex("c")]);
    await settle();
    await vi.waitFor(() => expect(quota.read([claude("a"), codex("c")]).size).toBe(2));
    expect(quota.read([codex("c")]).has("a")).toBe(false);
    const stored = JSON.parse(readFileSync(join(dataDir, "auth-quota.json"), "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(stored.entries)).toEqual(["c"]);
  });

  it("keeps a Codex hold across reads that include every account", async () => {
    answer = (ids) =>
      Promise.resolve(
        ids.map((id) => ({
          accountId: id,
          status: "error" as const,
          httpStatus: 429,
          retryAfterSeconds: 900,
        })),
      );
    const quota = create();
    quota.read([codex("c"), claude("a")]);
    await settle();
    const before = calls.length;
    clock += 60_000;
    quota.read([codex("c"), claude("a")]);
    expect(calls).toHaveLength(before);
  });

  it("makes an account due at once when it becomes ready again", async () => {
    const quota = create();
    quota.read([claude("a")]);
    await settle();
    quota.read([{ ...claude("a"), status: "pending" }]);
    quota.read([claude("a")]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });

  it("returns no quota for zero windows", () => {
    expect(quotaFromWindows([])).toBeUndefined();
  });
});
