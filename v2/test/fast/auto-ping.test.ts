import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoPingService,
  autoPingRouteFingerprint,
  redactAutoPingHandles,
  type AutoPingError,
} from "../../src/auto-ping.js";
import type { AutoPingRouteDescriptor } from "../../src/types.js";

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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("AutoPingService", () => {
  it("persists only hashed owner-bound grants at mode 0600", async () => {
    const dir = createDir();
    const service = new AutoPingService(dir);
    const fingerprint = autoPingRouteFingerprint(route());
    service.registerRoute(fingerprint);
    const grant = service.createGrant({
      scope: "event",
      routeFingerprint: fingerprint,
      destination: { kind: "session", sessionId: "owner" },
      target: { kind: "occurrence", occurrenceId: "occurrence" },
      actorSessionId: "owner",
    });

    const result = await service.unsubscribe("owner", "event", grant.handle);
    const raw = readFileSync(join(dir, "auto-ping.json"), "utf8");
    expect(result.created).toBe(true);
    expect(raw).not.toContain(grant.handle);
    expect(raw).toContain(grant.handleHash);
    expect(statSync(join(dir, "auto-ping.json")).mode & 0o777).toBe(0o600);
    service.dispose();
  });

  it("returns pending without waiting for the route mutex and binds one actor", async () => {
    const dir = createDir();
    const service = new AutoPingService(dir);
    const fingerprint = autoPingRouteFingerprint(
      route({ actionKind: "spawn", destination: { kind: "trigger" } }),
    );
    service.registerRoute(fingerprint);
    const grant = service.createGrant({
      scope: "subscription",
      routeFingerprint: fingerprint,
      destination: { kind: "trigger" },
      target: { kind: "subscription" },
    });
    let release!: () => void;
    const held = service.withRouteLock(
      fingerprint,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();

    await expect(service.unsubscribe("owner", "subscription", grant.handle)).rejects.toMatchObject({
      code: "grant_not_ready",
      status: 409,
    } satisfies Partial<AutoPingError>);
    release();
    await held;
    service.bindGrant(grant.handleHash, "owner");
    await expect(
      service.unsubscribe("foreign", "subscription", grant.handle),
    ).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await expect(service.unsubscribe("owner", "subscription", grant.handle)).resolves.toMatchObject(
      {
        created: true,
      },
    );
    service.dispose();
  });

  it("deduplicates canonical targets across grants and invalidates siblings on resume", async () => {
    const dir = createDir();
    const service = new AutoPingService(dir);
    const fingerprint = autoPingRouteFingerprint(route());
    service.registerRoute(fingerprint);
    const input = {
      scope: "thread" as const,
      routeFingerprint: fingerprint,
      destination: { kind: "session" as const, sessionId: "owner" },
      target: { kind: "github-review-thread" as const, threadId: "thread" },
      actorSessionId: "owner",
    };
    const first = service.createGrant(input);
    const sibling = service.createGrant(input);
    const one = await service.unsubscribe("owner", "thread", first.handle);
    const two = await service.unsubscribe("owner", "thread", sibling.handle);
    expect(two).toEqual({ record: one.record, created: false });
    expect(service.list("owner")).toHaveLength(1);

    await expect(service.resume("owner", one.record.suppressionId)).resolves.toMatchObject({
      records: [],
      removed: true,
    });
    await expect(service.resume("owner", one.record.suppressionId)).resolves.toMatchObject({
      removed: false,
    });
    await expect(service.unsubscribe("owner", "thread", sibling.handle)).rejects.toMatchObject({
      code: "grant_consumed",
      status: 409,
    });
    service.dispose();
  });

  it("isolates destination and target matching", async () => {
    const dir = createDir();
    const service = new AutoPingService(dir);
    const fingerprint = autoPingRouteFingerprint(route());
    service.registerRoute(fingerprint);
    const grant = service.createGrant({
      scope: "event",
      routeFingerprint: fingerprint,
      destination: { kind: "session", sessionId: "owner" },
      target: { kind: "occurrence", occurrenceId: "one" },
      actorSessionId: "owner",
    });
    await service.unsubscribe("owner", "event", grant.handle);
    expect(service.isSuppressed(fingerprint, { kind: "session", sessionId: "owner" }, "one")).toBe(
      true,
    );
    expect(service.isSuppressed(fingerprint, { kind: "session", sessionId: "owner" }, "two")).toBe(
      false,
    );
    expect(
      service.isSuppressed(fingerprint, { kind: "session", sessionId: "sibling" }, "one"),
    ).toBe(false);
    service.dispose();
  });

  it("retains the persisted occurrence grace clock across reconstruction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const dir = createDir();
    const fingerprint = autoPingRouteFingerprint(route());
    let service = new AutoPingService(dir);
    service.registerRoute(fingerprint);
    const grant = service.createGrant({
      scope: "event",
      routeFingerprint: fingerprint,
      destination: { kind: "session", sessionId: "owner" },
      target: { kind: "occurrence", occurrenceId: "one" },
      actorSessionId: "owner",
    });
    await service.unsubscribe("owner", "event", grant.handle);
    service.addOccurrenceReference(fingerprint, "one");
    service.releaseOccurrenceReference(fingerprint, "one");
    service.dispose();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    service = new AutoPingService(dir);
    service.registerRoute(fingerprint);
    expect(service.list("owner")).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-01T23:59:00.000Z"));
    service.gc();
    expect(service.list("owner")).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    service.gc();
    expect(service.list("owner")).toEqual([]);
    service.dispose();
  });

  it("collects an event suppression created after its occurrence became unreferenced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const service = new AutoPingService(createDir());
    const fingerprint = autoPingRouteFingerprint(route());
    service.registerRoute(fingerprint);
    const grant = service.createGrant({
      scope: "event",
      routeFingerprint: fingerprint,
      destination: { kind: "session", sessionId: "owner" },
      target: { kind: "occurrence", occurrenceId: "finished" },
      actorSessionId: "owner",
    });

    await service.unsubscribe("owner", "event", grant.handle);
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    service.gc();

    expect(service.list("owner")).toEqual([]);
    service.dispose();
  });

  it("retains a dormant send destination while its route exists and collects it after removal", async () => {
    const dir = createDir();
    const descriptor = route();
    const fingerprint = autoPingRouteFingerprint(descriptor);
    let service = new AutoPingService(dir);
    const lease = service.registerRoute(fingerprint, descriptor);
    const grant = service.createGrant({
      scope: "subscription",
      routeFingerprint: fingerprint,
      destination: descriptor.destination,
      target: { kind: "subscription" },
      actorSessionId: "owner",
    });
    await service.unsubscribe("owner", "subscription", grant.handle);
    service.setConfiguredRouteAuthorities([
      route({ destination: { kind: "session", sessionId: "*" } }),
    ]);
    service.releaseRoute(lease);
    service.dispose();

    service = new AutoPingService(dir);
    service.setConfiguredRouteAuthorities([
      route({ destination: { kind: "session", sessionId: "*" } }),
    ]);
    expect(service.list("owner")).toHaveLength(1);
    service.setConfiguredRouteAuthorities([
      route({ triggerId: "replacement", destination: { kind: "session", sessionId: "*" } }),
    ]);
    expect(service.list("owner")).toEqual([]);
    service.dispose();
  });

  it("fails closed on malformed or unknown state", () => {
    const dir = createDir();
    writeFileSync(
      join(dir, "auto-ping.json"),
      JSON.stringify({ version: 2, grants: [], suppressions: [] }),
    );
    expect(() => new AutoPingService(dir)).toThrow("Invalid auto-ping policy state");
    expect(existsSync(join(dir, "auto-ping.json"))).toBe(true);
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
