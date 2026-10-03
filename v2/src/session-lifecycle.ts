import { randomUUID } from "node:crypto";
import type { LifecycleAction, LifecycleOperation, SessionLifecycleSnapshot } from "./types.js";

export class SessionLifecycleError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly payload: {
      code: "session_lifecycle_conflict" | "session_lifecycle_snapshot_changed";
      lifecycle: SessionLifecycleSnapshot;
      sessionIds?: string[];
    },
  ) {
    super(message);
  }
}

// Captured errors keep their original class/status/payload for HTTP handling.
const errorReceipts = new WeakMap<object, SessionLifecycleSnapshot>();

export function annotateLifecycleError(error: unknown, snapshot: SessionLifecycleSnapshot): void {
  if (typeof error === "object" && error !== null) errorReceipts.set(error, snapshot);
}

export function lifecycleErrorReceipt(error: unknown): SessionLifecycleSnapshot | undefined {
  return typeof error === "object" && error !== null ? errorReceipts.get(error) : undefined;
}

export function parseLifecycleOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    !value.trim()
  ) {
    throw new Error("operationId must be a nonblank, unpadded string of 1–128 characters");
  }
  return value;
}

export class SessionLifecycleRegister {
  readonly instanceId = randomUUID();
  private revision = 0;
  private readonly entries = new Map<string, SessionLifecycleSnapshot>();

  snapshot(id: string): SessionLifecycleSnapshot {
    return this.entries.get(id) ?? { instanceId: this.instanceId, revision: 0, operation: null };
  }

  begin(
    action: LifecycleAction,
    targetIds: string[],
    suppliedId?: string,
  ): SessionLifecycleSnapshot {
    const operationId = suppliedId ?? randomUUID();
    const targets = [...new Set(targetIds)];
    const conflicts = targets.filter((id) => {
      const operation = this.entries.get(id)?.operation;
      return operation?.phase === "pending" || operation?.operationId === operationId;
    });
    const firstConflict = conflicts[0];
    if (firstConflict) {
      throw new SessionLifecycleError("A lifecycle operation already owns this session", 409, {
        code: "session_lifecycle_conflict",
        sessionIds: conflicts,
        lifecycle: this.snapshot(firstConflict),
      });
    }
    const snapshot = this.create({
      operationId,
      action,
      phase: "pending",
      targetIds: targets,
      outcomes: [],
    });
    for (const id of targets) this.entries.set(id, snapshot);
    return snapshot;
  }

  settle(
    owner: SessionLifecycleSnapshot,
    succeeded: boolean,
    outcome: (id: string) => "succeeded" | "failed",
    exists: (id: string) => boolean,
  ): SessionLifecycleSnapshot {
    const operation = owner.operation;
    if (!operation) throw new Error("Lifecycle owner has no operation");
    const snapshot = this.create({
      ...operation,
      phase: succeeded ? "succeeded" : "failed",
      outcomes: operation.targetIds.map((sessionId) => ({ sessionId, phase: outcome(sessionId) })),
    });
    for (const id of operation.targetIds) {
      if (this.entries.get(id) !== owner) continue;
      if (exists(id)) this.entries.set(id, snapshot);
      else this.entries.delete(id);
    }
    return snapshot;
  }

  prune(existing: ReadonlySet<string>): void {
    for (const [id, snapshot] of this.entries) {
      if (!existing.has(id) && snapshot.operation?.phase !== "pending") this.entries.delete(id);
    }
  }

  private create(operation: LifecycleOperation): SessionLifecycleSnapshot {
    Object.freeze(operation.targetIds);
    for (const outcome of operation.outcomes) Object.freeze(outcome);
    Object.freeze(operation.outcomes);
    Object.freeze(operation);
    return Object.freeze({ instanceId: this.instanceId, revision: ++this.revision, operation });
  }
}
