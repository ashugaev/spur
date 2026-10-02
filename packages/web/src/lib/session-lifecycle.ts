import type { LifecycleAction, SessionLifecycleSnapshot, SpurSessionView } from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLifecycleSnapshot(value: unknown): SessionLifecycleSnapshot | null {
  if (
    !record(value) ||
    typeof value.instanceId !== "string" ||
    !value.instanceId.trim() ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  )
    return null;
  const operation = value.operation;
  if (operation === null)
    return value.revision === 0 ? (value as unknown as SessionLifecycleSnapshot) : null;
  if (
    !record(operation) ||
    typeof operation.operationId !== "string" ||
    !operation.operationId.trim() ||
    operation.operationId.length > 128 ||
    operation.operationId.trim() !== operation.operationId ||
    !["complete", "restore", "reopen"].includes(String(operation.action)) ||
    !["pending", "succeeded", "failed"].includes(String(operation.phase)) ||
    Number(value.revision) === 0 ||
    !Array.isArray(operation.targetIds) ||
    !operation.targetIds.every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(operation.outcomes) ||
    !operation.outcomes.every(
      (outcome) =>
        record(outcome) &&
        typeof outcome.sessionId === "string" &&
        operation.targetIds instanceof Array &&
        operation.targetIds.includes(outcome.sessionId) &&
        (outcome.phase === "succeeded" || outcome.phase === "failed"),
    )
  )
    return null;
  if (operation.phase === "pending" && operation.outcomes.length > 0) return null;
  const targets = new Set(operation.targetIds);
  const outcomes = new Set(operation.outcomes.map((outcome) => outcome.sessionId));
  if (
    targets.size !== operation.targetIds.length ||
    outcomes.size !== operation.outcomes.length ||
    (operation.phase !== "pending" && outcomes.size !== targets.size)
  )
    return null;
  return value as unknown as SessionLifecycleSnapshot;
}

export interface LifecycleRead {
  generation: number;
  sequence: number;
}
export interface LifecycleIntent {
  operationId: string;
  generation: number;
  instanceId: string;
  action: LifecycleAction;
  revisions: ReadonlyMap<string, number>;
}

/** Mounted consumer ordering; the daemon owns all work after its receipt arrives. */
export class SessionLifecycleConsumer {
  instanceId: string | null = null;
  generation = 0;
  private sequence = 0;
  private acceptedSequence = 0;
  private retired = new Set<string>();
  private rows = new Map<string, SpurSessionView>();
  private rejectedRows = new Set<string>();
  private intents = new Map<string, { owner: LifecycleIntent; source: SpurSessionView }>();

  beginRead(): LifecycleRead {
    return { generation: this.generation, sequence: ++this.sequence };
  }

  accept(
    instanceId: string,
    rows: readonly SpurSessionView[],
    read: LifecycleRead,
  ): SpurSessionView[] | null {
    if (
      read.generation !== this.generation ||
      read.sequence < this.acceptedSequence ||
      !instanceId.trim() ||
      this.retired.has(instanceId)
    )
      return null;
    for (const row of rows) {
      const snapshot = readLifecycleSnapshot(row.lifecycle);
      if (
        !snapshot ||
        snapshot.instanceId !== instanceId ||
        (snapshot.operation && !snapshot.operation.targetIds.includes(row.id))
      )
        throw new Error("Invalid session lifecycle snapshot");
    }
    if (this.instanceId !== instanceId) {
      if (this.instanceId !== null) {
        this.retired.add(this.instanceId);
        this.generation += 1;
      }
      this.instanceId = instanceId;
      this.rows.clear();
      this.intents.clear();
    }
    this.acceptedSequence = read.sequence;
    this.rejectedRows.clear();
    const accepted = rows.map((row) => this.acceptRow(row));
    return accepted;
  }

  private acceptRow(row: SpurSessionView): SpurSessionView {
    const snapshot = readLifecycleSnapshot(row.lifecycle);
    if (!snapshot) throw new Error("Invalid session lifecycle snapshot");
    const previous = this.rows.get(row.id);
    if (previous?.lifecycle && previous.lifecycle.revision > snapshot.revision) {
      this.rejectedRows.add(row.id);
      return previous;
    }
    this.rows.set(row.id, row);
    const intent = this.intents.get(row.id);
    if (
      intent &&
      snapshot.operation &&
      (snapshot.operation.operationId === intent.owner.operationId ||
        snapshot.revision > (intent.source.lifecycle?.revision ?? 0))
    )
      this.intents.delete(row.id);
    return row;
  }

  acceptMutation(row: SpurSessionView, owner: LifecycleIntent): SpurSessionView | null {
    if (!this.isCurrent(owner)) return null;
    return this.acceptUpdate(row);
  }

  acceptUpdate(row: SpurSessionView): SpurSessionView | null {
    const snapshot = readLifecycleSnapshot(row.lifecycle);
    if (
      !snapshot ||
      snapshot.instanceId !== this.instanceId ||
      (snapshot.operation && !snapshot.operation.targetIds.includes(row.id))
    )
      return null;
    this.acceptedSequence = ++this.sequence;
    return this.acceptRow(row);
  }

  reserve(rows: readonly SpurSessionView[], action: LifecycleAction): LifecycleIntent | null {
    if (
      !this.instanceId ||
      rows.length === 0 ||
      rows.some(
        (row) =>
          readLifecycleSnapshot(row.lifecycle)?.instanceId !== this.instanceId ||
          this.pending(row.id),
      )
    )
      return null;
    const owner = {
      operationId: crypto.randomUUID(),
      generation: this.generation,
      instanceId: this.instanceId,
      action,
      revisions: new Map(rows.map((row) => [row.id, row.lifecycle?.revision ?? 0])),
    };
    for (const row of rows) this.intents.set(row.id, { owner, source: row });
    return owner;
  }

  isCurrent(owner: LifecycleIntent): boolean {
    if (owner.generation !== this.generation || owner.instanceId !== this.instanceId) return false;
    for (const [id, revision] of owner.revisions) {
      const intent = this.intents.get(id);
      if (intent && intent.owner !== owner) return false;
      const snapshot = this.rows.get(id)?.lifecycle;
      if (
        snapshot &&
        snapshot.revision > revision &&
        snapshot.operation?.operationId !== owner.operationId
      )
        return false;
    }
    return true;
  }

  releaseUnmatched(owner: LifecycleIntent): void {
    if (!this.isCurrent(owner)) return;
    for (const [id, intent] of this.intents)
      if (intent.owner === owner && !this.rejectedRows.has(id)) this.intents.delete(id);
  }

  pending(id: string): LifecycleAction | null {
    const intent = this.intents.get(id);
    if (intent) return intent.owner.action;
    const operation = this.rows.get(id)?.lifecycle?.operation;
    return operation?.phase === "pending" ? operation.action : null;
  }

  project(rows: readonly SpurSessionView[]): SpurSessionView[] {
    const result = [...rows];
    for (const [id, intent] of this.intents)
      if (!result.some((row) => row.id === id)) result.push(intent.source);
    return result.map((row) => projectLifecycleSession(row, this.pending(row.id)));
  }
}

export function projectLifecycleSession<T extends { status: string; state: string }>(
  row: T,
  action: LifecycleAction | null = null,
): T {
  if (!action) return row;
  return action === "complete"
    ? { ...row, status: "completed", state: "stopped", lifecyclePending: action }
    : { ...row, status: "running", state: "working", lifecyclePending: action };
}
