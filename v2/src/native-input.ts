import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { object, string } from "./github-app.js";
import { normalizeSubmitAckBaseline } from "./metadata.js";
import { atomicReceiptWrite, receiptHash, receiptIdentifier } from "./review-receipt.js";
import type { NativeUserObservation } from "./agents/index.js";
import type { AgentProcessRef } from "./agent-processes.js";
import type { ReleaseTaskIdentity } from "./session-service.js";
import type { AgentName, SubmitAckBaseline } from "./types.js";
import {
  parseConfiguredCallerBootstrap,
  type ConfiguredCallerBootstrap,
} from "./release-caller.js";

export type NativeInputIdentity = Omit<ReleaseTaskIdentity, "updatedAt"> & {
  agent: AgentName;
  launchDigest: string;
};

type InputState =
  | { kind: "intent" | "dispatched" }
  | { kind: "ambiguous"; reason: "native_input_retry_ambiguous" }
  | { kind: "accepted"; user: NativeUserObservation };

export interface NativeInputSource {
  path: string;
  size: number;
  device: number | null;
  inode: number | null;
  prefixDigest: string;
}

interface InputOccurrenceIdentity {
  id: string;
  initial: boolean;
  typedAt: number;
  predecessor: string | null;
}

interface KnownInputOccurrence extends InputOccurrenceIdentity {
  bodyDigest: string;
  baseline: SubmitAckBaseline;
  sources: NativeInputSource[];
  state: InputState;
}

interface UnobservableInputOccurrence extends InputOccurrenceIdentity {
  baseline: null;
  bodyDigest: null;
  sources: [];
  submittedDigest: string;
  state: {
    kind: "unobservable";
    reason: "native_input_baseline_unavailable" | "native_input_source_unavailable";
  };
}

export type NativeInputOccurrence = KnownInputOccurrence | UnobservableInputOccurrence;

export interface NativeInputJournal {
  identity: NativeInputIdentity;
  nativeSessionId: string | null;
  processes: AgentProcessRef[] | null;
  occurrences: NativeInputOccurrence[];
  caller?: ConfiguredCallerBootstrap;
}

export class NativeInputError extends Error {
  constructor(reason: string) {
    super(`native-input: ${reason}`);
  }
}

export class NativeInputSourceError extends NativeInputError {}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function segment(value: string): string {
  const result = receiptIdentifier(value);
  if (result === "." || result === "..") throw new NativeInputError("path-invalid");
  return result;
}

function journalPath(dataDir: string, identity: NativeInputIdentity): string {
  return join(
    dataDir,
    "native-inputs",
    segment(identity.project),
    segment(identity.sessionId),
    receiptHash(identity.launchDigest, 64),
    "inputs.json",
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Called inside the service's existing lifecycle serializer. Existing directories
// are synced too: a previous mkdir may have survived an interrupted parent sync.
async function publishAncestors(dataDir: string, identity: NativeInputIdentity): Promise<void> {
  let parent = resolve(dataDir);
  if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory()) {
    throw new NativeInputError("data-root-invalid");
  }
  for (const part of [
    "native-inputs",
    segment(identity.project),
    segment(identity.sessionId),
    receiptHash(identity.launchDigest, 64),
  ]) {
    const child = join(parent, part);
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const info = await lstat(child);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(child)) !== child) {
      throw new NativeInputError("journal-directory-invalid");
    }
    await syncDirectory(child);
    await syncDirectory(parent);
    parent = child;
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NativeInputError("position-invalid");
  }
  return value;
}

async function captureSource(path: string, size: number): Promise<NativeInputSource> {
  timestamp(size);
  const absolute = resolve(path);
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || (await realpath(absolute)) !== absolute) {
      throw new NativeInputSourceError("native-source-path-invalid");
    }
    const handle = await open(absolute, "r");
    try {
      const current = await handle.stat();
      if (info.dev !== current.dev || info.ino !== current.ino || current.size < size) {
        throw new NativeInputSourceError("native-source-changed");
      }
      const bytes = await handle.readFile();
      if (bytes.length < size) throw new NativeInputSourceError("native-source-truncated");
      return {
        path: absolute,
        size,
        device: current.dev,
        inode: current.ino,
        prefixDigest: createHash("sha256").update(bytes.subarray(0, size)).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!missing(error) || size !== 0) {
      if (error instanceof NativeInputSourceError) throw error;
      if (error instanceof Error && "errno" in error && typeof error.errno === "number") {
        throw new NativeInputSourceError("native-source-unreadable");
      }
      throw error;
    }
    return {
      path: absolute,
      size: 0,
      device: null,
      inode: null,
      prefixDigest: createHash("sha256").update("").digest("hex"),
    };
  }
}

export async function captureNativeInputSources(
  baseline: SubmitAckBaseline,
): Promise<NativeInputSource[]> {
  return Promise.all(sourceOffsets(baseline).map(([path, size]) => captureSource(path, size)));
}

function sourceOffsets(baseline: SubmitAckBaseline): [string, number][] {
  if (baseline.agent === "claude") return [[resolve(baseline.file), baseline.size]];
  if (baseline.agent === "cursor") {
    const positions: [string, number][] = [[resolve(baseline.file), baseline.size]];
    if (baseline.rotated) positions.push([resolve(baseline.rotated.file), baseline.rotated.size]);
    return positions;
  }
  if (baseline.agent === "codex") {
    return Object.entries(baseline.offsets).map(([path, size]) => [resolve(path), size]);
  }
  return [];
}

export async function verifyNativeInputSources(
  sources: readonly NativeInputSource[],
): Promise<void> {
  for (const source of sources) {
    const current = await captureSource(source.path, source.size);
    if (
      current.prefixDigest !== source.prefixDigest ||
      (source.inode !== null &&
        (source.device !== current.device || source.inode !== current.inode))
    ) {
      throw new NativeInputError("native-source-changed");
    }
  }
}

function parseUser(value: unknown): NativeUserObservation {
  const row = object(value);
  const source = string(row.source);
  if (resolve(source) !== source) throw new NativeInputError("native-source-path-invalid");
  return {
    nativeSessionId: string(row.nativeSessionId),
    source,
    recordId: string(row.recordId),
    recordDigest: receiptHash(row.recordDigest, 64),
    bodyDigest: receiptHash(row.bodyDigest, 64),
  };
}

function parseOccurrence(value: unknown): NativeInputOccurrence {
  const row = object(value);
  const common: InputOccurrenceIdentity = {
    id: receiptIdentifier(row.id),
    initial: row.initial === true,
    typedAt: timestamp(row.typedAt),
    predecessor: row.predecessor === null ? null : receiptIdentifier(row.predecessor),
  };
  if (!Number.isFinite(new Date(common.typedAt).getTime()))
    throw new NativeInputError("position-invalid");
  if (typeof row.initial !== "boolean") throw new NativeInputError("occurrence-invalid");
  const state = object(row.state);
  if (row.baseline === null) {
    if (
      row.bodyDigest !== null ||
      !Array.isArray(row.sources) ||
      row.sources.length !== 0 ||
      state.kind !== "unobservable" ||
      "user" in state ||
      (state.reason !== "native_input_baseline_unavailable" &&
        state.reason !== "native_input_source_unavailable")
    )
      throw new NativeInputError("opaque-occurrence-invalid");
    return {
      ...common,
      baseline: null,
      bodyDigest: null,
      sources: [],
      submittedDigest: receiptHash(row.submittedDigest, 64),
      state: { kind: "unobservable", reason: state.reason },
    };
  }
  const baseline = normalizeSubmitAckBaseline(row.baseline);
  // The pacing codec deliberately recovers lossy markers. A native attribution
  // journal must preserve the complete original boundary instead.
  if (!baseline || !isDeepStrictEqual(baseline, row.baseline)) {
    throw new NativeInputError("baseline-invalid");
  }
  if (baseline.agent === "claude" || baseline.agent === "cursor") {
    timestamp(baseline.size);
    if (baseline.agent === "cursor" && baseline.rotated) timestamp(baseline.rotated.size);
  } else if (baseline.agent === "codex") {
    Object.values(baseline.offsets).forEach(timestamp);
  } else if (baseline.after) {
    timestamp(baseline.after.createdMs);
  }
  if (!Array.isArray(row.sources)) throw new NativeInputError("native-source-invalid");
  const sources = row.sources.map((value: unknown) => {
    const source = object(value);
    return {
      path: string(source.path),
      size: timestamp(source.size),
      device: source.device === null ? null : timestamp(source.device),
      inode: source.inode === null ? null : timestamp(source.inode),
      prefixDigest: receiptHash(source.prefixDigest, 64),
    };
  });
  if (
    !isDeepStrictEqual(
      sources.map((source) => [source.path, source.size]),
      sourceOffsets(baseline),
    )
  ) {
    throw new NativeInputError("native-source-invalid");
  }
  let parsedState: InputState;
  switch (state.kind) {
    case "intent":
    case "dispatched":
      parsedState = { kind: state.kind };
      break;
    case "ambiguous":
      if (state.reason !== "native_input_retry_ambiguous") {
        throw new NativeInputError("occurrence-invalid");
      }
      parsedState = { kind: "ambiguous", reason: state.reason };
      break;
    case "accepted":
      parsedState = { kind: "accepted", user: parseUser(state.user) };
      break;
    default:
      throw new NativeInputError("occurrence-invalid");
  }
  return {
    ...common,
    bodyDigest: receiptHash(row.bodyDigest, 64),
    baseline,
    sources,
    state: parsedState,
  };
}

export async function readNativeInputJournal(
  dataDir: string,
  identity: NativeInputIdentity,
): Promise<NativeInputJournal | null> {
  const path = journalPath(dataDir, identity);
  let value: unknown;
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (await realpath(path)) !== resolve(path)) {
      throw new NativeInputError("journal-file-invalid");
    }
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (missing(error)) return null;
    throw new NativeInputError("journal-unreadable");
  }
  const row = object(value);
  if (!isDeepStrictEqual(row.identity, identity) || !Array.isArray(row.occurrences)) {
    throw new NativeInputError("journal-identity-invalid");
  }
  const occurrences = row.occurrences.map(parseOccurrence);
  const ids = new Set<string>();
  const accepted = new Set<string>();
  for (const occurrence of occurrences) {
    if (
      ids.has(occurrence.id) ||
      (occurrence.baseline !== null && occurrence.baseline.agent !== identity.agent)
    ) {
      throw new NativeInputError("journal-occurrence-invalid");
    }
    if (occurrence.predecessor && !ids.has(occurrence.predecessor)) {
      throw new NativeInputError("journal-predecessor-invalid");
    }
    ids.add(occurrence.id);
    if (occurrence.baseline !== null && occurrence.state.kind === "accepted") {
      const user = occurrence.state.user;
      const key = nativeUserKey(user);
      if (
        accepted.has(key) ||
        user.bodyDigest !== occurrence.bodyDigest ||
        user.nativeSessionId !== row.nativeSessionId
      ) {
        throw new NativeInputError("journal-owner-invalid");
      }
      accepted.add(key);
    }
  }
  let processes: AgentProcessRef[] | null = null;
  if (row.processes !== null) {
    if (!Array.isArray(row.processes) || row.processes.length === 0) {
      throw new NativeInputError("journal-process-invalid");
    }
    processes = row.processes.map((value: unknown) => {
      const process = object(value);
      const pid = timestamp(process.pid);
      if (pid === 0) throw new NativeInputError("journal-process-invalid");
      return { pid, identity: string(process.identity) };
    });
  }
  if (accepted.size > 0 && processes === null) {
    throw new NativeInputError("journal-process-invalid");
  }
  return {
    identity,
    nativeSessionId: row.nativeSessionId === null ? null : string(row.nativeSessionId),
    processes,
    occurrences,
    ...(row.caller === undefined ? {} : { caller: parseConfiguredCallerBootstrap(row.caller) }),
  };
}

export async function writeNativeInputJournal(
  dataDir: string,
  journal: NativeInputJournal,
): Promise<void> {
  const previous = await readNativeInputJournal(dataDir, journal.identity);
  if (previous) {
    if (previous.caller && !isDeepStrictEqual(previous.caller, journal.caller))
      throw new NativeInputError("caller-bootstrap-immutable");
    if (
      (previous.nativeSessionId !== null && previous.nativeSessionId !== journal.nativeSessionId) ||
      (previous.processes !== null && !isDeepStrictEqual(previous.processes, journal.processes)) ||
      previous.occurrences.length > journal.occurrences.length
    )
      throw new NativeInputError("journal-transition-invalid");
    for (const [index, old] of previous.occurrences.entries()) {
      const next = journal.occurrences[index];
      if (!next) throw new NativeInputError("journal-transition-invalid");
      const { state: oldState, ...oldIntent } = old;
      const { state: nextState, ...nextIntent } = next;
      if (!isDeepStrictEqual(oldIntent, nextIntent)) throw new NativeInputError("intent-immutable");
      if (
        oldState.kind === "unobservable" ||
        oldState.kind === "ambiguous" ||
        oldState.kind === "accepted"
          ? !isDeepStrictEqual(oldState, nextState)
          : oldState.kind === "intent"
            ? !["intent", "dispatched", "ambiguous"].includes(nextState.kind)
            : !["dispatched", "accepted", "ambiguous"].includes(nextState.kind)
      )
        throw new NativeInputError("journal-transition-invalid");
    }
  }
  for (const input of journal.occurrences.slice(previous?.occurrences.length ?? 0)) {
    if (
      input.state.kind !== "intent" &&
      input.state.kind !== "unobservable" &&
      input.state.kind !== "ambiguous"
    ) {
      throw new NativeInputError("intent-publication-required");
    }
  }
  await publishAncestors(dataDir, journal.identity);
  await atomicReceiptWrite(journalPath(dataDir, journal.identity), journal);
}

// No lock here: all callers hold the owning session/workspace lifecycle locks.
export function appendNativeInputIntent(
  journal: NativeInputJournal,
  input: Omit<KnownInputOccurrence, "id" | "state">,
): KnownInputOccurrence;
export function appendNativeInputIntent(
  journal: NativeInputJournal,
  input: Omit<UnobservableInputOccurrence, "id">,
): UnobservableInputOccurrence;
export function appendNativeInputIntent(
  journal: NativeInputJournal,
  input: Omit<KnownInputOccurrence, "id" | "state"> | Omit<UnobservableInputOccurrence, "id">,
): NativeInputOccurrence {
  const occurrence: NativeInputOccurrence =
    input.baseline === null
      ? { ...input, id: randomUUID() }
      : { ...input, id: randomUUID(), state: { kind: "intent" } };
  journal.occurrences.push(occurrence);
  return occurrence;
}

export function nativeUserKey(user: NativeUserObservation): string {
  return JSON.stringify([user.nativeSessionId, resolve(user.source), user.recordId]);
}

// Each candidate list comes from the existing native scanner rebound to that
// occurrence's original baseline, after stable canonical/process source checks.
export function bindNativeInputUsers(
  journal: NativeInputJournal,
  candidates: ReadonlyMap<string, readonly NativeUserObservation[]>,
): void {
  if (
    !journal.nativeSessionId ||
    !journal.processes?.length ||
    journal.processes.some((process) => process.identity === null)
  )
    return;
  const owners = new Map<string, string>();
  for (const occurrence of journal.occurrences) {
    if (occurrence.baseline !== null && occurrence.state.kind === "accepted") {
      owners.set(nativeUserKey(occurrence.state.user), occurrence.id);
    }
  }
  const eligible = journal.occurrences.filter(
    (row): row is KnownInputOccurrence => row.baseline !== null && row.state.kind === "dispatched",
  );
  const matched = new Map<string, NativeUserObservation[]>();
  for (const occurrence of eligible) {
    const unique = new Map<string, NativeUserObservation>();
    for (const user of candidates.get(occurrence.id) ?? []) {
      if (
        user.nativeSessionId === journal.nativeSessionId &&
        user.bodyDigest === occurrence.bodyDigest
      ) {
        const key = nativeUserKey(user);
        const previous = unique.get(key);
        if (previous && !isDeepStrictEqual(previous, user)) {
          throw new NativeInputError("native-source-changed");
        }
        unique.set(key, user);
      }
    }
    matched.set(occurrence.id, [...unique.values()]);
  }
  for (const occurrence of eligible) {
    const users = matched.get(occurrence.id) ?? [];
    const overlaps = users.some((user) =>
      journal.occurrences.some(
        (other) =>
          other.id !== occurrence.id &&
          (other.baseline === null || other.bodyDigest === occurrence.bodyDigest) &&
          (other.state.kind === "unobservable" ||
            other.state.kind === "intent" ||
            other.state.kind === "ambiguous" ||
            (matched.get(other.id) ?? []).some(
              (candidate) => nativeUserKey(candidate) === nativeUserKey(user),
            )),
      ),
    );
    if (users.length > 1 || overlaps) {
      occurrence.state = { kind: "ambiguous", reason: "native_input_retry_ambiguous" };
    } else if (users.length === 1) {
      const user = users[0];
      if (user && !owners.has(nativeUserKey(user))) {
        occurrence.state = { kind: "accepted", user };
        owners.set(nativeUserKey(user), occurrence.id);
      }
    }
  }
}
