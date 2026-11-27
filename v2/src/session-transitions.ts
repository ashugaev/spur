import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { iterLiveLines } from "./jsonl-log-io.js";
import { matchesSessionLinks, parseSessionLinkFilters } from "./session-slots.js";
import {
  SESSION_STATES,
  SESSION_STATUSES,
  type SessionLink,
  type SessionRecord,
  type SessionState,
  type SessionTransition,
  type SessionTransitionsQuery,
  type SessionTransitionsResponse,
} from "./types.js";

export const TRANSITIONS_SEGMENT_BYTES = 16 * 1024 * 1024;
export const TRANSITIONS_RETAIN_SEGMENTS = 6;

const common = {
  cursor: z.string(),
  sessionId: z.string(),
  project: z.string(),
  at: z.iso.datetime(),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  error: z.string().optional(),
  rateLimitResetAt: z.iso.datetime().optional(),
  successorId: z.string().optional(),
};
const transitionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("status"),
    from: z.enum(SESSION_STATUSES).nullable(),
    to: z.enum(SESSION_STATUSES),
  }),
  z.object({
    ...common,
    kind: z.literal("state"),
    from: z.enum(SESSION_STATES).nullable(),
    to: z.enum(SESSION_STATES),
  }),
]);
const observationSchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  state: z.enum(SESSION_STATES).optional(),
  rateLimitResetAt: z.iso.datetime().optional(),
  successorId: z.string().optional(),
});
const checkpointSchema = z.object({
  stream: z.uuid(),
  sequence: z.number().int().nonnegative(),
  observations: z.record(z.string(), observationSchema),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
type PendingTransition =
  | Readonly<Omit<Extract<SessionTransition, { kind: "status" }>, "cursor">>
  | Readonly<Omit<Extract<SessionTransition, { kind: "state" }>, "cursor">>;

export class SessionTransitionsCursorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 410,
    readonly floorCursor?: string,
    readonly latestCursor?: string,
  ) {
    super(message);
  }
}

export function parseSessionTransitionsQuery(params: URLSearchParams): SessionTransitionsQuery {
  for (const key of ["since", "limit", "kinds"]) {
    if (params.getAll(key).length > 1) throw new Error(`${key} must occur once`);
  }
  const limit = params.get("limit");
  if (limit !== null && (!/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000)) {
    throw new Error("limit must be an integer from 1 through 1000");
  }
  const kinds = params.get("kinds")?.split(",");
  if (kinds && kinds.some((kind) => kind !== "status" && kind !== "state")) {
    throw new Error("kinds must be status, state, or status,state");
  }
  const since = params.get("since");
  return {
    ...(since !== null ? { since } : {}),
    links: parseSessionLinkFilters(params.getAll("link")),
    limit: limit === null ? 200 : Number(limit),
    ...(kinds ? { kinds: kinds as ("status" | "state")[] } : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid session transitions JSON");
  }
}

/** Retained facts use immutable numbered segments; checkpoints never precede appends. */
export class SessionTransitions {
  private readonly dir: string;
  private readonly checkpointPath: string;
  private checkpoint: Checkpoint;
  private segments: [number, ...number[]];
  private readonly segmentRanges = new Map<number, { first: number; last: number }>();
  private firstSequence = 1;
  private dirty = false;
  private readonly pending: PendingTransition[] = [];

  constructor(
    dataDir: string,
    private readonly bounds = {
      segmentBytes: TRANSITIONS_SEGMENT_BYTES,
      retainSegments: TRANSITIONS_RETAIN_SEGMENTS,
    },
  ) {
    this.dir = join(dataDir, "session-transitions");
    mkdirSync(this.dir, { recursive: true });
    this.checkpointPath = join(this.dir, "checkpoint.json");
    this.checkpoint = existsSync(this.checkpointPath)
      ? checkpointSchema.parse(parseJson(readFileSync(this.checkpointPath, "utf8")))
      : { stream: randomUUID(), sequence: 0, observations: {} };
    // Persist identity before the first entry, including an empty feed cursor.
    if (!existsSync(this.checkpointPath)) this.saveCheckpoint();
    const [first = 1, ...older] = readdirSync(this.dir)
      .filter((name) => /^\d+\.jsonl$/.test(name))
      .map((name) => Number(name.slice(0, -6)))
      .sort((a, b) => a - b);
    this.segments = [first, ...older];
    let prior: number | undefined;
    for (const entry of this.entries()) {
      const sequence = this.sequenceOf(entry.cursor);
      if (prior === undefined) this.firstSequence = sequence;
      else if (sequence !== prior + 1) throw new Error("Gap in session transitions journal");
      prior = sequence;
      if (sequence > this.checkpoint.sequence) this.apply(entry, sequence);
    }
    if ((prior ?? 0) < this.checkpoint.sequence) {
      throw new Error("Session transitions checkpoint exceeds journal");
    }
    this.saveCheckpoint();
    this.prune();
  }

  private path(segment: number): string {
    return join(this.dir, `${segment}.jsonl`);
  }
  private cursor(sequence: number): string {
    return `${this.checkpoint.stream}.${sequence}`;
  }
  private sequenceOf(cursor: string): number {
    const separator = cursor.lastIndexOf(".");
    const stream = cursor.slice(0, separator);
    const raw = cursor.slice(separator + 1);
    const sequence = Number(raw);
    if (
      separator < 0 ||
      stream !== this.checkpoint.stream ||
      !/^(0|[1-9]\d*)$/.test(raw) ||
      !Number.isSafeInteger(sequence)
    ) {
      throw new SessionTransitionsCursorError("Invalid or foreign transitions cursor", 400);
    }
    return sequence;
  }

  private *entries(after = 0): Generator<SessionTransition> {
    for (const segment of this.segments) {
      const range = this.segmentRanges.get(segment);
      if (range && range.last <= after) continue;
      const path = this.path(segment);
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      let offset = 0;
      for (const line of iterLiveLines(path)) {
        const end = offset + Buffer.byteLength(line) + 1;
        if (end > size) {
          if (segment !== this.segments.at(-1)) throw new Error("Incomplete archived transition");
          truncateSync(path, offset);
          break;
        }
        const entry = transitionSchema.parse(parseJson(line)) as SessionTransition;
        this.noteSegmentSequence(segment, this.sequenceOf(entry.cursor));
        yield entry;
        offset = end;
      }
    }
  }

  private noteSegmentSequence(segment: number, sequence: number): void {
    const range = this.segmentRanges.get(segment);
    this.segmentRanges.set(segment, {
      first: range?.first ?? sequence,
      last: Math.max(range?.last ?? sequence, sequence),
    });
  }

  private saveCheckpoint(): void {
    const temp = `${this.checkpointPath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.checkpoint), { mode: 0o600 });
    renameSync(temp, this.checkpointPath);
    this.dirty = false;
  }

  private apply(entry: SessionTransition, sequence: number): void {
    const old = this.checkpoint.observations[entry.sessionId] ?? {};
    this.checkpoint.observations[entry.sessionId] =
      entry.kind === "status"
        ? {
            ...old,
            status: entry.to,
            ...(entry.successorId ? { successorId: entry.successorId } : {}),
          }
        : { ...old, state: entry.to, rateLimitResetAt: entry.rateLimitResetAt };
    this.checkpoint.sequence = sequence;
    this.dirty = true;
  }

  private prune(): void {
    // Checkpoint precedes deletion: interruption leaves extra readable segments.
    while (this.segments.length > this.bounds.retainSegments) {
      const segment = this.segments[0];
      unlinkSync(this.path(segment));
      this.segments.shift();
      this.segmentRanges.delete(segment);
    }
    this.firstSequence =
      this.segmentRanges.get(this.segments[0])?.first ?? this.checkpoint.sequence + 1;
  }

  private settle(): void {
    if (this.dirty) this.saveCheckpoint();
    this.prune();
  }

  flushPending(): void {
    this.settle();
    for (let head = this.pending[0]; head; head = this.pending[0]) {
      const sequence = this.checkpoint.sequence;
      try {
        this.append(head);
      } catch (error) {
        if (this.checkpoint.sequence > sequence) this.pending.shift();
        throw error;
      }
      this.pending.shift();
    }
  }

  private latestPending(
    sessionId: string,
    kind: PendingTransition["kind"],
  ): PendingTransition | undefined {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (entry?.sessionId === sessionId && entry.kind === kind) return entry;
    }
    return undefined;
  }

  private append(entry: PendingTransition): void {
    let segment = this.segments.reduce((_, current) => current);
    const path = this.path(segment);
    if (existsSync(path) && statSync(path).size >= this.bounds.segmentBytes) {
      segment += 1;
      this.segments.push(segment);
    }
    const sequence = this.checkpoint.sequence + 1;
    const complete = { ...entry, cursor: this.cursor(sequence) };
    const target = this.path(segment);
    const priorBytes = existsSync(target) ? statSync(target).size : 0;
    try {
      appendFileSync(target, `${JSON.stringify(complete)}\n`, { mode: 0o600 });
    } catch (error) {
      // Only discard an uncommitted partial append; prior committed bytes stay.
      if (existsSync(target)) truncateSync(target, priorBytes);
      throw error;
    }
    this.noteSegmentSequence(segment, sequence);
    this.apply(complete, sequence);
    this.settle();
  }

  observeStatus(session: SessionRecord, links: SessionLink[], successorId?: string): void {
    const previous = this.checkpoint.observations[session.id];
    const pending = this.latestPending(session.id, "status");
    const status = pending?.kind === "status" ? pending.to : previous?.status;
    const carriedSuccessor =
      pending?.kind === "status" ? pending.successorId : previous?.successorId;
    if (status !== session.status || (successorId && carriedSuccessor !== successorId)) {
      const successor = successorId ?? carriedSuccessor;
      this.pending.push({
        kind: "status",
        from: status ?? null,
        to: session.status,
        ...this.fields(session, links),
        ...(successor ? { successorId: successor } : {}),
      });
    }
    this.flushPending();
  }

  observeState(session: SessionRecord, state: SessionState, links: SessionLink[]): void {
    const previous = this.checkpoint.observations[session.id];
    const pending = this.latestPending(session.id, "state");
    const previousState = pending?.kind === "state" ? pending.to : previous?.state;
    const previousReset =
      pending?.kind === "state" ? pending.rateLimitResetAt : previous?.rateLimitResetAt;
    const reset = state === "rate_limited" ? session.rateLimitResetAt : undefined;
    if (previousState !== state || previousReset !== reset) {
      this.pending.push({
        kind: "state",
        from: previousState ?? null,
        to: state,
        ...this.fields(session, links),
        ...(reset ? { rateLimitResetAt: reset } : {}),
      });
    }
    this.flushPending();
  }

  observedStatus(sessionId: string): SessionRecord["status"] | undefined {
    return this.checkpoint.observations[sessionId]?.status;
  }

  observedState(sessionId: string): SessionState | undefined {
    return this.checkpoint.observations[sessionId]?.state;
  }

  private fields(session: SessionRecord, links: SessionLink[]) {
    return {
      sessionId: session.id,
      project: session.project,
      at: new Date().toISOString(),
      links: links.map((link) => ({ ...link })),
      ...(session.stopReason ? { stopReason: session.stopReason } : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }

  query(query: SessionTransitionsQuery = {}): SessionTransitionsResponse {
    this.flushPending();
    const floor = this.firstSequence - 1;
    const after = query.since === undefined ? floor : this.sequenceOf(query.since);
    if (after > this.checkpoint.sequence)
      throw new SessionTransitionsCursorError("Future transitions cursor", 400);
    if (after < floor)
      throw new SessionTransitionsCursorError(
        "Transitions cursor expired; resync session list",
        410,
        this.cursor(floor),
        this.cursor(this.checkpoint.sequence),
      );
    const limit = query.limit ?? 200;
    const entries: SessionTransition[] = [];
    let position = after;
    for (const entry of this.entries(after)) {
      const sequence = this.sequenceOf(entry.cursor);
      if (sequence <= after) continue;
      const selected = query.kinds
        ? query.kinds.includes(entry.kind)
        : entry.kind === "status" ||
          (entry.from !== null && entry.from !== "working" && entry.from !== "waiting") ||
          (entry.to !== "working" && entry.to !== "waiting");
      if (selected && matchesSessionLinks(entry.links, query.links)) {
        if (entries.length === limit)
          return { entries, nextCursor: this.cursor(position), hasMore: true };
        entries.push(entry);
      }
      position = sequence;
    }
    return { entries, nextCursor: this.cursor(this.checkpoint.sequence), hasMore: false };
  }
}
