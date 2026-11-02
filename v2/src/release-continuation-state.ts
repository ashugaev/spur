import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object, integer, string, ReviewAppError } from "./github-app.js";
import { atomicReceiptWrite, receiptHash, receiptIdentifier } from "./review-receipt.js";
import { readProcStarttime, type StarttimeProbe } from "./sidecars/reap.js";
import type { SessionLifecycleSnapshot } from "./types.js";

interface OwnerClaim {
  generation: number;
  holder: string;
  predecessor: string | null;
  boot: string;
  pid: number;
  starttime: number;
}
export interface ContinuationFence {
  generation: number;
  holder: string;
  assertCurrent(): Promise<void>;
  retire(): Promise<void>;
}
export interface ClaimProbes {
  boot(): Promise<string>;
  process(pid: number): Promise<StarttimeProbe>;
}
const defaultProbes: ClaimProbes = {
  boot: async () => string((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()),
  process: readProcStarttime,
};
function parseClaim(value: unknown): OwnerClaim {
  const row = object(value);
  return {
    generation: integer(row.generation),
    holder: receiptIdentifier(row.holder),
    predecessor: row.predecessor === null ? null : receiptIdentifier(row.predecessor),
    boot: string(row.boot),
    pid: integer(row.pid),
    starttime: integer(row.starttime),
  };
}
async function readClaims(root: string): Promise<OwnerClaim[]> {
  const names = (await readdir(root)).filter((name) => name.endsWith(".claim"));
  const claims: OwnerClaim[] = [];
  for (const name of names) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(root, name), "utf8")) as unknown;
    } catch {
      throw new ReviewAppError("continuation-claim-invalid");
    }
    const claim = parseClaim(value);
    if (name !== `${claim.generation}.claim`)
      throw new ReviewAppError("continuation-claim-invalid");
    claims.push(claim);
  }
  claims.sort((a, b) => a.generation - b.generation);
  if (
    claims.some(
      (claim, index) =>
        claim.generation !== index + 1 || claim.predecessor !== (claims[index - 1]?.holder ?? null),
    )
  )
    throw new ReviewAppError("continuation-claim-chain-invalid");
  return claims;
}
async function durableDirectory(root: string): Promise<void> {
  const handle = await open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function durableStateDirectory(root: string): Promise<void> {
  let missing = false;
  try {
    if (!(await lstat(root)).isDirectory())
      throw new ReviewAppError("continuation-directory-invalid");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
    missing = true;
  }
  const parent = dirname(root);
  if (parent !== root) await durableStateDirectory(parent);
  if (missing)
    await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
        throw error;
    });
  if (!(await lstat(root)).isDirectory())
    throw new ReviewAppError("continuation-directory-invalid");
  await durableDirectory(root);
  if (parent !== root) await durableDirectory(parent);
}
export async function claimContinuation(
  root: string,
  probes: ClaimProbes = defaultProbes,
): Promise<ContinuationFence> {
  await durableStateDirectory(root);
  const boot = await probes.boot();
  const self = await probes.process(process.pid);
  if (self.kind !== "ok" || self.state === "Z" || self.state === "X")
    throw new ReviewAppError("continuation-identity-unknown");
  const previous = (await readClaims(root)).at(-1);
  if (previous) {
    let retired = false;
    try {
      const marker = await readFile(join(root, `${previous.generation}.retired`), "utf8");
      if (marker !== previous.holder) throw new ReviewAppError("continuation-retirement-invalid");
      retired = true;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
    }
    if (!retired && previous.boot === boot) {
      const probe = await probes.process(previous.pid);
      if (probe.kind === "unknown") throw new ReviewAppError("continuation-identity-unknown");
      if (
        probe.kind === "ok" &&
        probe.starttime === previous.starttime &&
        probe.state !== "Z" &&
        probe.state !== "X"
      )
        throw new ReviewAppError("continuation-owner-live");
    }
  }
  const claim: OwnerClaim = {
    generation: (previous?.generation ?? 0) + 1,
    holder: randomUUID(),
    predecessor: previous?.holder ?? null,
    boot,
    pid: process.pid,
    starttime: self.starttime,
  };
  const stage = join(root, `${claim.holder}.stage`);
  try {
    await writeFile(stage, JSON.stringify(claim), { mode: 0o600, flag: "wx", flush: true });
    await link(stage, join(root, `${claim.generation}.claim`));
    await durableDirectory(root);
  } catch {
    throw new ReviewAppError("continuation-claim-denied");
  } finally {
    await rm(stage, { force: true });
  }
  let retired = false;
  const assertCurrent = async (): Promise<void> => {
    const current = (await readClaims(root)).at(-1);
    if (
      retired ||
      current?.holder !== claim.holder ||
      current.generation !== claim.generation ||
      (await probes.boot()) !== claim.boot
    )
      throw new ReviewAppError("continuation-fenced");
    const probe = await probes.process(claim.pid);
    if (
      probe.kind !== "ok" ||
      probe.starttime !== claim.starttime ||
      probe.state === "Z" ||
      probe.state === "X"
    )
      throw new ReviewAppError("continuation-fenced");
  };
  return {
    generation: claim.generation,
    holder: claim.holder,
    assertCurrent,
    retire: async () => {
      await assertCurrent();
      await writeFile(join(root, `${claim.generation}.retired`), claim.holder, {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      await durableDirectory(root);
      retired = true;
    },
  };
}
export interface ContinuationAction {
  kind: "send" | "restore";
  key: string;
  session: string;
  message: string;
  state: "intent" | "confirmed";
  launch: string;
}
function parseAction(value: unknown): ContinuationAction {
  const action = object(value);
  if (
    (action.kind !== "send" && action.kind !== "restore") ||
    (action.state !== "intent" && action.state !== "confirmed")
  )
    throw new ReviewAppError("continuation-state-invalid");
  return {
    kind: action.kind,
    key: string(action.key),
    session: receiptIdentifier(action.session),
    message: string(action.message),
    state: action.state,
    launch: string(action.launch),
  };
}
export interface ContinuationRecord {
  version: 1;
  authorityGeneration: number;
  invocation: string;
  H: string;
  B: string;
  reason: string;
  outcomes?: string[];
  affirmations: Partial<
    Record<
      "code" | "browser",
      { challenge: string; launch: string; receiptDigest: string; accepted: boolean }
    >
  >;
  actions: ContinuationAction[];
  mergeSha: string | null;
  publishedProofDigest: string | null;
  reviewerRestores?: Partial<Record<"code" | "browser", ReviewerRestoreFence>>;
}
export interface ReviewerRestoreFence {
  repository: string;
  PR: number;
  lane: "code" | "browser";
  session: string;
  taskDigest: string;
  authorityGeneration: number;
  H: string;
  B: string;
  launchDigest: string;
  nativeId: string | null;
  operationId: string;
  budgetKey: string;
  attempt: number;
  attemptedAt: number;
  deadline: number;
  prerequisiteDigest: string;
  capacity: { enabled: boolean; cap: number; liveCount: number };
  instanceId: string;
  phase: "intent" | "unknown" | "zero-denied" | "observed";
  denial: "cap" | "memory_guard" | null;
  receipt?: SessionLifecycleSnapshot;
}
function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ReviewAppError("reviewer-restore-invalid");
  return value;
}
export function parseReviewerRestore(value: unknown): ReviewerRestoreFence {
  const row = object(value),
    capacity = object(row.capacity);
  if (
    (row.lane !== "code" && row.lane !== "browser") ||
    !["intent", "unknown", "zero-denied", "observed"].includes(string(row.phase)) ||
    typeof capacity.enabled !== "boolean" ||
    (row.denial !== null && row.denial !== "cap" && row.denial !== "memory_guard")
  )
    throw new ReviewAppError("reviewer-restore-invalid");
  const phase = row.phase as ReviewerRestoreFence["phase"];
  const result: ReviewerRestoreFence = {
    repository: string(row.repository),
    PR: integer(row.PR),
    lane: row.lane,
    session: receiptIdentifier(row.session),
    taskDigest: receiptHash(row.taskDigest, 64),
    authorityGeneration: integer(row.authorityGeneration),
    H: receiptHash(row.H, 40),
    B: receiptHash(row.B, 40),
    launchDigest: receiptHash(row.launchDigest, 64),
    nativeId: row.nativeId === null ? null : string(row.nativeId),
    operationId: receiptIdentifier(row.operationId),
    budgetKey: receiptHash(row.budgetKey, 64),
    attempt: integer(row.attempt),
    attemptedAt: nonnegative(row.attemptedAt),
    deadline: nonnegative(row.deadline),
    prerequisiteDigest: receiptHash(row.prerequisiteDigest, 64),
    instanceId: string(row.instanceId),
    phase,
    denial: row.denial,
    capacity: {
      enabled: capacity.enabled,
      cap: nonnegative(capacity.cap),
      liveCount: nonnegative(capacity.liveCount),
    },
  };
  if (result.attempt > 3 || result.deadline < result.attemptedAt)
    throw new ReviewAppError("reviewer-restore-invalid");
  if (row.receipt !== undefined) {
    const receipt = object(row.receipt),
      operation = object(receipt.operation);
    if (
      operation.operationId !== result.operationId ||
      operation.action !== "restore" ||
      (operation.phase !== "failed" && operation.phase !== "succeeded") ||
      receipt.instanceId !== result.instanceId ||
      !Array.isArray(operation.targetIds) ||
      operation.targetIds.length !== 1 ||
      operation.targetIds[0] !== result.session ||
      !Array.isArray(operation.outcomes) ||
      operation.outcomes.length !== 1
    )
      throw new ReviewAppError("reviewer-restore-invalid");
    const outcome = object(operation.outcomes[0]);
    if (outcome.sessionId !== result.session || outcome.phase !== operation.phase)
      throw new ReviewAppError("reviewer-restore-invalid");
    result.receipt = {
      instanceId: result.instanceId,
      revision: integer(receipt.revision),
      operation: {
        operationId: result.operationId,
        action: "restore",
        phase: operation.phase,
        targetIds: [result.session],
        outcomes: [{ sessionId: result.session, phase: operation.phase }],
      },
    };
  }
  if (
    (phase === "zero-denied" || phase === "observed") &&
    (!result.receipt ||
      (phase === "zero-denied" && result.denial === null) ||
      result.receipt.operation?.phase !== (phase === "zero-denied" ? "failed" : "succeeded"))
  )
    throw new ReviewAppError("reviewer-restore-invalid");
  return result;
}
export function parseContinuationOutcomes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16)
    throw new ReviewAppError("continuation-outcomes-invalid");
  return value.map((value: unknown) => {
    const outcome = string(value);
    if (outcome.length > 160 || /[\r\n]/.test(outcome))
      throw new ReviewAppError("continuation-outcomes-invalid");
    return outcome;
  });
}
export function parseContinuationRecord(value: unknown): ContinuationRecord {
  const row = object(value);
  if (row.version !== 1 || !Array.isArray(row.actions))
    throw new ReviewAppError("continuation-state-invalid");
  const affirmations: ContinuationRecord["affirmations"] = {};
  const reviewerRestores: NonNullable<ContinuationRecord["reviewerRestores"]> = {};
  if (row.reviewerRestores !== undefined) {
    const restores = object(row.reviewerRestores);
    if (Object.keys(restores).some((lane) => lane !== "code" && lane !== "browser"))
      throw new ReviewAppError("reviewer-restore-invalid");
    for (const lane of ["code", "browser"] as const) {
      if (restores[lane] === undefined) continue;
      const restore = parseReviewerRestore(restores[lane]);
      if (restore.lane !== lane) throw new ReviewAppError("reviewer-restore-invalid");
      reviewerRestores[lane] = restore;
    }
  }
  const raw = object(row.affirmations);
  for (const lane of ["code", "browser"] as const) {
    if (raw[lane] === undefined) continue;
    const affirmation = object(raw[lane]);
    if (typeof affirmation.accepted !== "boolean")
      throw new ReviewAppError("continuation-state-invalid");
    affirmations[lane] = {
      challenge: string(affirmation.challenge),
      launch: string(affirmation.launch),
      receiptDigest: string(affirmation.receiptDigest),
      accepted: affirmation.accepted,
    };
  }
  return {
    version: 1,
    authorityGeneration: integer(row.authorityGeneration),
    invocation: string(row.invocation),
    H: string(row.H),
    B: string(row.B),
    reason: string(row.reason),
    outcomes: parseContinuationOutcomes(row.outcomes),
    affirmations,
    actions: row.actions.map(parseAction),
    mergeSha: row.mergeSha === null ? null : string(row.mergeSha),
    publishedProofDigest:
      row.publishedProofDigest === null ? null : string(row.publishedProofDigest),
    reviewerRestores,
  };
}
export async function saveContinuationRecord(
  path: string,
  record: ContinuationRecord,
  fence: ContinuationFence,
): Promise<void> {
  await fence.assertCurrent();
  await atomicReceiptWrite(path, record);
}

export interface ReviewerRecoveryRecord {
  key: string;
  attempts: number;
  attemptedAt: number;
  launch: string;
  state: "intent" | "confirmed" | "blocked";
  reason: string;
  source: string;
  actions: ContinuationAction[];
  prerequisite: string | null;
  restoreAttempts?: ReviewerRestoreFence[];
}
export async function readReviewerRecovery(
  path: string,
  key: string,
): Promise<ReviewerRecoveryRecord | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw new ReviewAppError("reviewer-recovery-invalid");
  }
  const row = object(value);
  if (
    row.key !== key ||
    !Number.isSafeInteger(row.attempts) ||
    Number(row.attempts) < 0 ||
    typeof row.attemptedAt !== "number" ||
    !Number.isFinite(row.attemptedAt) ||
    row.attemptedAt < 0 ||
    (row.state !== "intent" && row.state !== "confirmed" && row.state !== "blocked") ||
    typeof row.reason !== "string" ||
    !Array.isArray(row.actions) ||
    (row.source !== undefined && typeof row.source !== "string")
  )
    throw new ReviewAppError("reviewer-recovery-invalid");
  const rawAttempts = row.restoreAttempts === undefined ? [] : row.restoreAttempts;
  if (!Array.isArray(rawAttempts)) throw new ReviewAppError("reviewer-recovery-invalid");
  const restoreAttempts = rawAttempts.map(parseReviewerRestore);
  if (
    restoreAttempts.some(
      (attempt, index) => attempt.budgetKey !== key || attempt.attempt !== index + 1,
    ) ||
    restoreAttempts.length > Number(row.attempts) ||
    restoreAttempts.length > 3 ||
    new Set(restoreAttempts.map((attempt) => attempt.operationId)).size !== restoreAttempts.length
  )
    throw new ReviewAppError("reviewer-recovery-invalid");
  return {
    key,
    attempts: Number(row.attempts),
    attemptedAt: row.attemptedAt,
    launch: string(row.launch),
    state: row.state,
    reason: row.reason,
    source: row.source ?? "",
    actions: row.actions.map(parseAction),
    prerequisite: row.prerequisite === null ? null : string(row.prerequisite),
    restoreAttempts,
  };
}
