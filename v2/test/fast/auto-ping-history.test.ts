import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoPingService, autoPingRouteFingerprint } from "../../src/auto-ping.js";
import {
  appendMuteHistory,
  deleteMuteHistory,
  readMuteHistory,
} from "../../src/auto-ping-history.js";
import type { AutoPingMuteView } from "../../src/types.js";

const dirs: string[] = [];

function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spur-auto-ping-history-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(id: string, overrides: Partial<AutoPingMuteView> = {}): AutoPingMuteView {
  return {
    suppressionId: id,
    mode: "forever",
    routeFingerprint: "route",
    destination: { kind: "session", sessionId: "s1" },
    actorSessionId: "s1",
    items: [{ subject: "review:github:o/r#1", kind: "ci_failed", label: "until next commit" }],
    reason: "broken",
    createdAt: "2026-11-03T00:00:0" + id.slice(-1) + ".000Z",
    ...overrides,
  };
}

describe("auto-ping mute history", () => {
  it("folds events by suppression id, oldest first, and stays 0600", () => {
    const dir = createDir();
    appendMuteHistory(dir, "s1", "muted", record("m1"));
    appendMuteHistory(dir, "s1", "muted", record("m2"));
    appendMuteHistory(
      dir,
      "s1",
      "ended",
      record("m1", { endedAt: "2026-11-03T01:00:00.000Z", endReason: "resumed" }),
    );

    const history = readMuteHistory(dir, "s1");
    expect(history.map((entry) => entry.suppressionId)).toEqual(["m1", "m2"]);
    expect(history[0]).toMatchObject({ endReason: "resumed" });
    expect(history[1]?.endedAt).toBeUndefined();
    expect(readMuteHistory(dir, "other")).toEqual([]);
    const [file] = readdirSync(join(dir, "auto-ping-history"));
    expect(statSync(join(dir, "auto-ping-history", file ?? "")).mode & 0o777).toBe(0o600);
  });

  it("skips corrupt lines and deletes with the session", () => {
    const dir = createDir();
    appendMuteHistory(dir, "s1", "muted", record("m1"));
    deleteMuteHistory(dir, "s1");
    expect(readMuteHistory(dir, "s1")).toEqual([]);
    deleteMuteHistory(dir, "s1");
  });

  it("keeps records after resume and expiry and never writes a handle", async () => {
    let now = Date.parse("2026-11-03T00:00:00.000Z");
    const dir = createDir();
    const descriptor = {
      version: 1 as const,
      projectId: "p",
      triggerId: "t",
      sourceId: "s",
      sourceType: "github" as const,
      eventName: "github:review",
      actionKind: "send" as const,
      destination: { kind: "session" as const, sessionId: "s1" },
      spawnDeskGroup: false,
    };
    const fingerprint = autoPingRouteFingerprint(descriptor);
    const service = new AutoPingService(dir, { now: () => now });
    service.registerRoute(fingerprint, descriptor);
    const grant = () =>
      service.createGrant({
        routeFingerprint: fingerprint,
        destination: descriptor.destination,
        actorSessionId: "s1",
        items: [{ subject: "review:github:o/r#1", kind: "ci_failed", label: "x", changeKey: "a" }],
        untilChange: true,
      });
    const first = grant();
    const second = grant();
    await service.mute("s1", { handle: first.handle, mode: "until_change", reason: "r1" });
    await service.resume("s1", { handle: first.handle });
    await service.mute("s1", {
      handle: second.handle,
      mode: "for",
      durationMs: 60_000,
      reason: "r2",
    });
    now += 120_000;
    expect(service.list("s1")).toEqual([]);

    const history = service.history("s1");
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.endReason).sort()).toEqual(["expired", "resumed"]);
    expect(history.map((entry) => entry.reason).sort()).toEqual(["r1", "r2"]);
    const file = readFileSync(
      join(dir, "auto-ping-history", readdirSync(join(dir, "auto-ping-history"))[0] ?? ""),
      "utf8",
    );
    expect(file).not.toContain("ap1_");
    expect(file).not.toContain(first.handleHash);
    service.dispose();
  });

  it("closes an active mute in history when gc drops its route", async () => {
    const dir = createDir();
    const descriptor = {
      version: 1 as const,
      projectId: "p",
      triggerId: "t",
      sourceId: "s",
      sourceType: "github" as const,
      eventName: "github:review",
      actionKind: "send" as const,
      destination: { kind: "session" as const, sessionId: "s1" },
      spawnDeskGroup: false,
    };
    const fingerprint = autoPingRouteFingerprint(descriptor);
    const service = new AutoPingService(dir);
    const lease = service.registerRoute(fingerprint, descriptor);
    const grant = service.createGrant({
      routeFingerprint: fingerprint,
      destination: descriptor.destination,
      actorSessionId: "s1",
      items: [{ subject: "review:github:o/r#1", kind: "ci_failed", label: "x", changeKey: "a" }],
      untilChange: true,
    });
    await service.mute("s1", { handle: grant.handle, mode: "forever", reason: "r" });
    expect(service.history("s1")[0]?.endedAt).toBeUndefined();

    service.releaseRoute(lease);

    const history = readMuteHistory(dir, "s1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ endReason: "route_removed" });
    expect(history[0]?.endedAt).toBeDefined();
    service.dispose();
  });
});
