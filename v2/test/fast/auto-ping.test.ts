import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_PING_MUTE_FOR_MAX_MS,
  AutoPingService,
  autoPingRouteFingerprint,
  redactAutoPingHandles,
} from "../../src/auto-ping.js";
import type { AutoPingMuteItem, AutoPingRouteDescriptor } from "../../src/types.js";

const dirs: string[] = [];

function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spur-auto-ping-"));
  dirs.push(dir);
  return dir;
}

function route(overrides: Partial<AutoPingRouteDescriptor> = {}): AutoPingRouteDescriptor {
  return {
    version: 1,
    projectId: "project",
    triggerId: "review",
    sourceId: "github",
    sourceType: "github",
    eventName: "github:review",
    actionKind: "send",
    destination: { kind: "session", sessionId: "owner" },
    spawnDeskGroup: false,
    ...overrides,
  };
}

const descriptor = route();
const fingerprint = autoPingRouteFingerprint(descriptor);
const destination = descriptor.destination;

function ciItem(changeKey = "head-a"): AutoPingMuteItem {
  return {
    subject: "review:github:o/r#7",
    kind: "ci_failed",
    label: "until next commit",
    changeKey,
  };
}

function commentItem(): AutoPingMuteItem {
  return { subject: "review:github:o/r#7", kind: "comment", label: "x", changeKey: "c1" };
}

function setup(options: { now?: () => number; dir?: string } = {}) {
  const dir = options.dir ?? createDir();
  const logs: Array<{ event: string; sessionId: string | undefined; details: unknown }> = [];
  const service = new AutoPingService(dir, {
    ...(options.now ? { now: options.now } : {}),
    log: (event, sessionId, details) => logs.push({ event, sessionId, details }),
  });
  service.registerRoute(fingerprint, descriptor);
  service.setConfiguredRouteAuthorities([descriptor]);
  const grant = (items: AutoPingMuteItem[], untilChange = true, actor = "owner") =>
    service.createGrant({
      routeFingerprint: fingerprint,
      destination,
      actorSessionId: actor,
      items,
      untilChange,
    });
  return { dir, service, logs, grant };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("AutoPingService mute", () => {
  it("until-change holds on the same key and ends with endReason changed on a new key", async () => {
    const { service, logs, grant } = setup();
    const { handle } = grant([ciItem()]);
    const { record, created } = await service.mute("owner", { handle, mode: "until_change" });
    expect(created).toBe(true);
    expect(record.mode).toBe("until_change");

    expect(service.matchMute(fingerprint, destination, ciItem())).toMatchObject({
      mode: "until_change",
      suppressionId: record.suppressionId,
    });
    expect(service.matchMute(fingerprint, destination, ciItem("head-b"))).toBeNull();
    expect(service.list("owner")).toEqual([]);
    expect(service.history("owner")).toMatchObject([
      { suppressionId: record.suppressionId, endReason: "changed" },
    ]);
    expect(logs.map((entry) => entry.event)).toEqual(["auto-ping.muted", "auto-ping.unmuted"]);
    service.dispose();
  });

  it("until-change drops only the changed item and keeps the rest muted", async () => {
    const { service, grant } = setup();
    const { handle } = grant([ciItem(), commentItem()]);
    await service.mute("owner", { handle, mode: "until_change" });
    expect(service.matchMute(fingerprint, destination, ciItem("head-b"))).toBeNull();
    expect(service.list("owner")).toHaveLength(1);
    expect(service.matchMute(fingerprint, destination, commentItem())).not.toBeNull();
    service.dispose();
  });

  it("rejects until-change when the grant does not offer it", async () => {
    const { service, grant } = setup();
    const { handle } = grant([ciItem()], false);
    await expect(service.mute("owner", { handle, mode: "until_change" })).rejects.toMatchObject({
      status: 400,
    });
    service.dispose();
  });

  it("for mutes the ping items until expiry then ends with endReason expired", async () => {
    let now = Date.parse("2026-11-03T00:00:00.000Z");
    const { service, grant } = setup({ now: () => now });
    const { handle } = grant([ciItem()]);
    const { record } = await service.mute("owner", {
      handle,
      mode: "for",
      durationMs: 2 * 3_600_000,
      reason: "waiting on infra",
    });
    expect(record.expiresAt).toBe("2026-11-03T02:00:00.000Z");
    expect(service.matchMute(fingerprint, destination, ciItem("head-b"))).not.toBeNull();
    expect(
      service.matchMute(fingerprint, destination, { ...ciItem(), kind: "merge_conflict" }),
    ).toBeNull();

    now += 2 * 3_600_000 + 1;
    expect(service.matchMute(fingerprint, destination, ciItem())).toBeNull();
    expect(service.history("owner")).toMatchObject([
      { endReason: "expired", endedAt: "2026-11-03T02:00:00.000Z", reason: "waiting on infra" },
    ]);
    service.dispose();
  });

  it("validates reason and duration for for and forever", async () => {
    const { service, grant } = setup();
    const { handle } = grant([ciItem()]);
    await expect(
      service.mute("owner", { handle, mode: "for", durationMs: 3_600_000 }),
    ).rejects.toThrow(/reason is required/);
    await expect(service.mute("owner", { handle, mode: "forever" })).rejects.toThrow(
      /reason is required/,
    );
    await expect(
      service.mute("owner", {
        handle,
        mode: "for",
        durationMs: AUTO_PING_MUTE_FOR_MAX_MS + 1,
        reason: "x",
      }),
    ).rejects.toThrow(/max is 24h/);
    await expect(
      service.mute("owner", { handle, mode: "for", durationMs: 1_000, reason: "x" }),
    ).rejects.toThrow(/duration is invalid/);
    expect(service.list("owner")).toEqual([]);
    service.dispose();
  });

  it("forever covers every item on the route and destination only", async () => {
    const { service, grant } = setup();
    const { handle } = grant([ciItem()]);
    await service.mute("owner", { handle, mode: "forever", reason: "wrong trigger" });
    expect(
      service.matchMute(fingerprint, destination, {
        subject: "thread:x",
        kind: "comment",
        label: "",
      }),
    ).not.toBeNull();
    expect(
      service.matchMute(fingerprint, { kind: "session", sessionId: "other" }, ciItem()),
    ).toBeNull();
    expect(service.matchMute("other-route", destination, ciItem())).toBeNull();
    service.dispose();
  });

  it("resumes by handle and by suppression id", async () => {
    const { service, grant } = setup();
    const first = grant([ciItem()]);
    await service.mute("owner", { handle: first.handle, mode: "until_change" });
    const byHandle = await service.resume("owner", { handle: first.handle });
    expect(byHandle).toEqual({ records: [], removed: true });
    expect(await service.resume("owner", { handle: first.handle })).toMatchObject({
      removed: false,
    });

    const second = grant([ciItem()]);
    const { record } = await service.mute("owner", { handle: second.handle, mode: "until_change" });
    const byId = await service.resume("owner", { suppressionId: record.suppressionId });
    expect(byId.removed).toBe(true);
    expect(service.matchMute(fingerprint, destination, ciItem())).toBeNull();
    expect(service.history("owner").map((entry) => entry.endReason)).toEqual([
      "resumed",
      "resumed",
    ]);
    await expect(service.resume("owner", {})).rejects.toMatchObject({ status: 400 });
    service.dispose();
  });

  it("repeats the same mode idempotently and replaces a different mode", async () => {
    const { service, grant } = setup();
    const { handle } = grant([ciItem()]);
    const first = await service.mute("owner", { handle, mode: "until_change" });
    const again = await service.mute("owner", { handle, mode: "until_change" });
    expect(again.created).toBe(false);
    expect(again.record.suppressionId).toBe(first.record.suppressionId);
    const forever = await service.mute("owner", { handle, mode: "forever", reason: "broken" });
    expect(forever.created).toBe(true);
    expect(service.list("owner")).toHaveLength(1);
    service.dispose();
  });

  it("binds a handle to its destination session", async () => {
    const { service, grant } = setup();
    const { handle } = grant([ciItem()]);
    await expect(service.mute("intruder", { handle, mode: "until_change" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.resume("intruder", { handle })).rejects.toMatchObject({ status: 403 });
    await expect(
      service.mute("owner", { handle: `ap1_${"z".repeat(43)}`, mode: "until_change" }),
    ).rejects.toMatchObject({ status: 404 });
    service.dispose();
  });

  it("persists hashed grants at mode 0600 and never the handle", async () => {
    const { dir, service, grant } = setup();
    const { handle, handleHash } = grant([ciItem()]);
    await service.mute("owner", { handle, mode: "until_change" });
    const path = join(dir, "auto-ping.json");
    const text = readFileSync(path, "utf8");
    expect(text).toContain(handleHash);
    expect(text).not.toContain(handle);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    service.dispose();
  });

  it("keeps active mutes across restart and drops them with their route", async () => {
    const { dir, service, grant } = setup();
    const lease = service.registerRoute(fingerprint, descriptor);
    const { handle } = grant([ciItem()]);
    await service.mute("owner", { handle, mode: "forever", reason: "broken" });
    service.releaseRoute(lease);
    service.dispose();

    const restored = new AutoPingService(dir);
    restored.setConfiguredRouteAuthorities([descriptor]);
    expect(restored.list("owner")).toHaveLength(1);
    restored.setConfiguredRouteAuthorities([route({ triggerId: "replacement" })]);
    expect(restored.list("owner")).toEqual([]);
    restored.dispose();
  });
});

describe("AutoPingService state", () => {
  it("migrates v1 by dropping every grant and suppression and logging counts", () => {
    const dir = createDir();
    const path = join(dir, "auto-ping.json");
    const now = new Date().toISOString();
    const spawnRoute = {
      routeFingerprint: "spawnfp",
      descriptor: { ...route(), actionKind: "spawn", destination: { kind: "trigger" } },
    };
    const sendRoute = { routeFingerprint: fingerprint, descriptor };
    const grants = (["event", "thread", "subscription"] as const).map((scope) => ({
      handleHash: `hash-${scope}`,
      scope,
      routeFingerprint: fingerprint,
      destination,
      target: { kind: "subscription" },
      canonicalKey: `key-${scope}`,
      createdAt: now,
      state: "pending",
    }));
    const suppressions = (["event", "thread", "subscription"] as const).map((scope) => ({
      suppressionId: `sup-${scope}`,
      scope,
      routeFingerprint: fingerprint,
      destination,
      target: { kind: "subscription" },
      canonicalKey: `key-${scope}`,
      actorSessionId: "owner",
      createdAt: now,
    }));
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        routes: [spawnRoute, sendRoute],
        grants,
        suppressions,
        mergeConflicts: [
          { routeFingerprint: fingerprint, prNumber: 7, fingerprint: "f", attempts: 3 },
        ],
      }),
    );
    const logs: Array<{ event: string; details: unknown }> = [];
    const service = new AutoPingService(dir, {
      log: (event, _id, details) => logs.push({ event, details }),
    });
    service.dispose();

    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 2,
      routes: [sendRoute],
      grants: [],
      suppressions: [],
      mergeConflicts: [],
      ciSeen: [],
    });
    expect(logs).toEqual([
      { event: "auto-ping.migrated", details: { droppedGrants: 3, droppedSuppressions: 3 } },
    ]);
  });

  it("fails closed on malformed or unknown state", () => {
    const dir = createDir();
    writeFileSync(
      join(dir, "auto-ping.json"),
      JSON.stringify({ version: 3, grants: [], suppressions: [] }),
    );
    expect(() => new AutoPingService(dir)).toThrow("Invalid auto-ping policy state");
    expect(existsSync(join(dir, "auto-ping.json"))).toBe(true);
  });

  it("collects an unused route descriptor after its last lease is released", () => {
    const dir = createDir();
    const service = new AutoPingService(dir);
    const lease = service.registerRoute(fingerprint, descriptor);
    service.setConfiguredRouteAuthorities([descriptor]);
    expect(readFileSync(join(dir, "auto-ping.json"), "utf8")).toContain(fingerprint);
    service.releaseRoute(lease);
    expect(readFileSync(join(dir, "auto-ping.json"), "utf8")).not.toContain(fingerprint);
    service.dispose();
  });

  it("clears its GC timer once across repeated disposal", () => {
    const clearInterval = vi.fn<typeof globalThis.clearInterval>();
    const timer = setTimeout(() => undefined, 60_000);
    const service = new AutoPingService(createDir(), {
      setInterval: vi.fn(() => timer) as unknown as typeof globalThis.setInterval,
      clearInterval,
    });
    service.dispose();
    service.dispose();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    clearTimeout(timer);
  });

  it("redacts exact handle-shaped strings", () => {
    const handle = `ap1_${"a".repeat(43)}`;
    expect(redactAutoPingHandles(`use ${handle}`)).toBe("use [auto-ping-handle]");
  });
});

describe("AutoPingService conflict and CI budgets", () => {
  it("delivers one merge_conflict per head:base key and caps retries across reload", () => {
    const { dir, service } = setup();
    expect(service.claimMergeConflict(fingerprint, 7, "k1")).toBe("accepted");
    service.markMergeConflictDelivered(fingerprint, "k1");
    expect(service.claimMergeConflict(fingerprint, 7, "k1")).toBe("already_delivered");
    expect(service.claimMergeConflict(fingerprint, 7, "k2")).toBe("accepted");
    service.refundMergeConflict(fingerprint);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(service.claimMergeConflict(fingerprint, 7, "k2")).toBe("accepted");
    }
    expect(service.claimMergeConflict(fingerprint, 7, "k2")).toBe("exhausted");
    service.dispose();

    const restored = new AutoPingService(dir);
    restored.setConfiguredRouteAuthorities([descriptor]);
    expect(restored.claimMergeConflict(fingerprint, 7, "k2")).toBe("exhausted");
    expect(restored.claimMergeConflict(fingerprint, 7, "k1")).toBe("already_delivered");
    expect(restored.claimMergeConflict(fingerprint, 7, "k3")).toBe("accepted");
    restored.dispose();
  });

  it("treats a CI run as new only for an unseen head or run id, recorded on delivery", () => {
    const { service } = setup();
    expect(service.isCiRunNew(fingerprint, "A", ["r1"])).toBe(true);
    service.markCiDelivered(fingerprint, "A", ["r1"]);
    expect(service.isCiRunNew(fingerprint, "A", ["r1"])).toBe(false);
    expect(service.isCiRunNew(fingerprint, "A", ["r1", "r2"])).toBe(true);
    service.markCiDelivered(fingerprint, "A", ["r1", "r2"]);
    expect(service.isCiRunNew(fingerprint, "A", ["r1"])).toBe(false);
    expect(service.isCiRunNew(fingerprint, "A", ["r1", "r2"])).toBe(false);
    expect(service.isCiRunNew(fingerprint, "B", ["r1"])).toBe(true);
    service.markCiDelivered(fingerprint, "B", ["r1"]);
    expect(service.isCiRunNew(fingerprint, "A", ["r2"])).toBe(true);
    service.dispose();
  });
});
