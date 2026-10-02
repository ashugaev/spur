import { describe, expect, it } from "vitest";
import { readLifecycleSnapshot, SessionLifecycleConsumer } from "@/lib/session-lifecycle";
import type { LifecycleAction, LifecyclePhase, SessionLifecycleSnapshot, SpurSessionView } from "@/lib/types";

function row(snapshot: SessionLifecycleSnapshot = { instanceId: "epoch-a", revision: 0, operation: null },
  overrides: Partial<SpurSessionView> = {}): SpurSessionView {
  return { id: "one", project: "test", agent: "claude", prompt: "test", branch: "feature/test",
    worktree: true, tmuxSession: null, status: "stopped", state: "stopped", createdAt: "2026-01-01",
    updatedAt: "2026-01-01", lastActivityAt: "2026-01-01", runtimeAlive: false,
    workspaceExists: true, services: [], slots: { links: [] }, lifecycle: snapshot, ...overrides };
}
function receipt(operationId: string, revision: number, action: LifecycleAction = "restore",
  phase: LifecyclePhase = "pending", instanceId = "epoch-a"): SessionLifecycleSnapshot {
  return { instanceId, revision, operation: { operationId, action, phase, targetIds: ["one"],
    outcomes: phase === "pending" ? [] : [{ sessionId: "one", phase }] } };
}
function accept(consumer: SessionLifecycleConsumer, rows: SpurSessionView[], epoch = "epoch-a") {
  return consumer.accept(epoch, rows, consumer.beginRead());
}

describe("session lifecycle ownership", () => {
  it("requires an epoch before reserving intent", () => {
    expect(new SessionLifecycleConsumer().reserve([row()], "restore")).toBeNull();
  });

  it("hands off matching intent and settles before a pending POST returns", () => {
    const consumer = new SessionLifecycleConsumer();
    accept(consumer, [row()]);
    const owner = consumer.reserve([row()], "restore")!;
    expect(consumer.project([])[0]).toMatchObject({ state: "working", runtimeAlive: false });
    const waiting = row(receipt(owner.operationId, 2, "restore", "succeeded"),
      { status: "running", state: "waiting", runtimeAlive: true });
    accept(consumer, [waiting]);
    expect(consumer.pending("one")).toBeNull();
    expect(consumer.project([waiting])[0]).toEqual(waiting);
    expect(consumer.reserve([waiting], "complete")).not.toBeNull();
  });

  it("recovers pending restore with dead runtime in a fresh browser consumer", () => {
    const pending = row(receipt("server-restore", 1));
    for (const consumer of [new SessionLifecycleConsumer(), new SessionLifecycleConsumer()]) {
      accept(consumer, [pending]);
      expect(consumer.project([pending])[0]).toMatchObject({ status: "running", state: "working", runtimeAlive: false });
      expect(consumer.reserve([pending], "complete")).toBeNull();
    }
  });

  it("rejects stale read sequence and lower receipt revisions, preserving equal-revision current state", () => {
    const consumer = new SessionLifecycleConsumer();
    accept(consumer, [row()]);
    const old = consumer.beginRead();
    const settled = row(receipt("restore", 4, "restore", "succeeded"), { status: "running", state: "waiting" });
    accept(consumer, [settled]);
    expect(consumer.accept("epoch-a", [row()], old)).toBeNull();
    expect(accept(consumer, [row(receipt("older", 3))])?.[0]).toEqual(settled);
    const stopped = { ...settled, state: "stopped" as const, runtimeAlive: false };
    expect(accept(consumer, [stopped])?.[0]).toEqual(stopped);
  });

  it("retains revision floor through an omitted row", () => {
    const consumer = new SessionLifecycleConsumer();
    const settled = row(receipt("complete", 4, "complete", "succeeded"), { status: "completed" });
    accept(consumer, [settled]);
    accept(consumer, []);
    expect(accept(consumer, [row(receipt("older", 3))])?.[0]).toEqual(settled);
  });

  it("retires epochs from empty-list restart and rejects old read and POST callbacks", () => {
    const consumer = new SessionLifecycleConsumer();
    accept(consumer, [row()]);
    const owner = consumer.reserve([row()], "restore")!;
    const old = consumer.beginRead();
    expect(accept(consumer, [], "epoch-b")).toEqual([]);
    expect(consumer.pending("one")).toBeNull();
    expect(consumer.accept("epoch-a", [row()], old)).toBeNull();
    expect(accept(consumer, [row()], "epoch-a")).toBeNull();
    expect(consumer.acceptMutation(row(receipt(owner.operationId, 2)), owner)).toBeNull();
  });

  it("keeps newer server ownership against a late old POST result", () => {
    const consumer = new SessionLifecycleConsumer();
    accept(consumer, [row()]);
    const owner = consumer.reserve([row()], "restore")!;
    const newer = row(receipt("new-owner", 4, "complete"));
    accept(consumer, [newer]);
    consumer.acceptMutation(row(receipt(owner.operationId, 2, "restore", "failed")), owner);
    consumer.releaseUnmatched(owner);
    expect(consumer.pending("one")).toBe("complete");
  });

  it("does not let an old response overwrite intent reserved after fast settlement", () => {
    const consumer = new SessionLifecycleConsumer();
    accept(consumer, [row()]);
    const oldOwner = consumer.reserve([row()], "restore")!;
    const waiting = row(receipt(oldOwner.operationId, 2, "restore", "succeeded"),
      { status: "running", state: "waiting" });
    accept(consumer, [waiting]);
    const newOwner = consumer.reserve([waiting], "complete")!;
    consumer.acceptMutation(row(receipt(oldOwner.operationId, 2, "restore", "succeeded")), oldOwner);
    consumer.releaseUnmatched(oldOwner);
    expect(consumer.pending("one")).toBe("complete");
    expect(consumer.project([waiting])[0].status).toBe("completed");
    consumer.releaseUnmatched(newOwner);
    expect(consumer.pending("one")).toBeNull();
  });

  it("accepts a later real reopen while retaining the settled complete receipt", () => {
    const consumer = new SessionLifecycleConsumer();
    const done = row(receipt("done", 2, "complete", "succeeded"), { status: "completed" });
    accept(consumer, [done]);
    const reopened = { ...done, status: "running" as const, state: "waiting" as const, runtimeAlive: true };
    accept(consumer, [reopened]);
    expect(consumer.project([reopened])[0]).toEqual(reopened);
  });

  it("releases each desk target from current rows after partial failure", () => {
    const consumer = new SessionLifecycleConsumer();
    const first = row();
    const second = row(undefined, { id: "two" });
    accept(consumer, [first, second]);
    const owner = consumer.reserve([first, second], "complete")!;
    const snapshot = receipt(owner.operationId, 2, "complete", "failed");
    snapshot.operation!.targetIds = ["one", "two"];
    snapshot.operation!.outcomes = [{ sessionId: "one", phase: "succeeded" }, { sessionId: "two", phase: "failed" }];
    const current = [row(snapshot, { status: "completed" }), row(snapshot, { id: "two", status: "errored", state: "error" })];
    accept(consumer, current);
    expect(consumer.project(current)).toEqual(current);
    expect(consumer.pending("one")).toBeNull();
    expect(consumer.pending("two")).toBeNull();
  });

  it.each([null, {}, { instanceId: "a", revision: 1, operation: null },
    receipt(" space ", 1), receipt("valid", -1), receipt("valid", 0)])("rejects invalid snapshot %j", (snapshot) => {
    expect(readLifecycleSnapshot(snapshot)).toBeNull();
  });
});
