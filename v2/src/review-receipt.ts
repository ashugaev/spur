import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { integer, object, ReviewAppError, string } from "./github-app.js";

export type ReviewLane = "code" | "browser";
export interface ReviewAttempt {
  repo: string;
  pr: number;
  lane: ReviewLane;
  session: string;
  attempt: string;
  H: string;
  B: string;
  contractDigest: string;
  receipt: string;
}
export interface ReviewReceipt {
  repository: string;
  PR: number;
  lane: ReviewLane;
  session: string;
  attempt: string;
  H: string;
  B: string;
  contractDigest: string;
  status: "PENDING" | "BLOCKED" | "APPROVED" | "CHANGES_REQUESTED";
  localVerdict: "APPROVED" | "CHANGES_REQUESTED" | null;
  evidence: { status: "passed" | "failed"; evidence: string }[];
  coverage: { challenger: string; output: string; omissionsClosed: true } | null;
  reviewId: number | null;
  reason: string;
  inputDigest: string | null;
  appId: number;
  reviewBlocked: boolean;
  mutationStarted: boolean;
  supersededAttempts: string[];
}
export function receiptIdentifier(value: unknown): string {
  const result = string(value);
  if (!/^[a-zA-Z0-9_.-]+$/.test(result)) throw new ReviewAppError("receipt-state-invalid");
  return result;
}
export function receiptHash(value: unknown, length: number): string {
  const result = string(value);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result))
    throw new ReviewAppError("receipt-state-invalid");
  return result;
}
export function parseReviewReceipt(value: unknown): ReviewReceipt {
  try {
    const row = object(value);
    if (row.lane !== "code" && row.lane !== "browser") throw new Error();
    if (
      row.status !== "PENDING" &&
      row.status !== "BLOCKED" &&
      row.status !== "APPROVED" &&
      row.status !== "CHANGES_REQUESTED"
    )
      throw new Error();
    if (
      row.localVerdict !== null &&
      row.localVerdict !== "APPROVED" &&
      row.localVerdict !== "CHANGES_REQUESTED"
    )
      throw new Error();
    if (
      typeof row.reviewBlocked !== "boolean" ||
      typeof row.mutationStarted !== "boolean" ||
      typeof row.reason !== "string"
    )
      throw new Error();
    if (!Array.isArray(row.evidence) || !Array.isArray(row.supersededAttempts)) throw new Error();
    const session = receiptIdentifier(row.session);
    const coverage = row.coverage === null ? null : object(row.coverage);
    if (
      coverage &&
      (receiptIdentifier(coverage.challenger) === session || coverage.omissionsClosed !== true)
    )
      throw new Error();
    const result: ReviewReceipt = {
      repository: string(row.repository),
      PR: integer(row.PR),
      lane: row.lane,
      session,
      attempt: receiptIdentifier(row.attempt),
      H: receiptHash(row.H, 40),
      B: receiptHash(row.B, 40),
      contractDigest: receiptHash(row.contractDigest, 64),
      status: row.status,
      localVerdict: row.localVerdict,
      evidence: row.evidence.map((value: unknown) => {
        const evidence = object(value);
        if (evidence.status !== "passed" && evidence.status !== "failed") throw new Error();
        return { status: evidence.status, evidence: string(evidence.evidence) };
      }),
      coverage: coverage
        ? {
            challenger: receiptIdentifier(coverage.challenger),
            output: string(coverage.output),
            omissionsClosed: true,
          }
        : null,
      reviewId: row.reviewId === null ? null : integer(row.reviewId),
      reason: row.reason,
      inputDigest: row.inputDigest === null ? null : receiptHash(row.inputDigest, 64),
      appId: integer(row.appId),
      reviewBlocked: row.reviewBlocked,
      mutationStarted: row.mutationStarted,
      supersededAttempts: row.supersededAttempts.map(receiptIdentifier),
    };
    if (
      new Set(result.supersededAttempts).size !== result.supersededAttempts.length ||
      result.supersededAttempts.includes(result.attempt) ||
      (result.mutationStarted && result.inputDigest === null) ||
      (result.reviewId !== null && !result.mutationStarted) ||
      (result.reviewBlocked && result.status !== "BLOCKED") ||
      (result.status === "APPROVED" &&
        result.evidence.some((entry) => entry.status !== "passed")) ||
      (["APPROVED", "CHANGES_REQUESTED"].includes(result.status) &&
        (result.inputDigest === null ||
          result.reviewId === null ||
          result.localVerdict !== result.status ||
          result.coverage === null ||
          result.evidence.length === 0))
    )
      throw new Error();
    return result;
  } catch {
    throw new ReviewAppError("receipt-state-invalid");
  }
}
export const expandReceiptPath = (path: string): string =>
  resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
export async function canonicalReceipt(root: string, request: ReviewAttempt): Promise<string> {
  try {
    await mkdir(expandReceiptPath(root), { recursive: true, mode: 0o700 });
    const canonical = join(
      await realpath(expandReceiptPath(root)),
      request.repo.toLowerCase(),
      String(request.pr),
      `${request.lane}.json`,
    );
    await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
    const requested = join(
      await realpath(dirname(expandReceiptPath(request.receipt))),
      request.receipt.split("/").at(-1) ?? "",
    );
    if (requested !== canonical) throw new Error();
    return canonical;
  } catch {
    throw new ReviewAppError("receipt-path-mismatch");
  }
}
export async function readReviewReceipt(path: string): Promise<ReviewReceipt> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ReviewAppError("receipt-state-invalid");
  }
  return parseReviewReceipt(value);
}
export async function lockReviewReceipt(path: string): Promise<() => Promise<void>> {
  let handle;
  try {
    handle = await open(`${path}.lock`, "wx", 0o600);
  } catch {
    throw new ReviewAppError("attempt-locked");
  }
  return async () => {
    try {
      await handle.close();
      await rm(`${path}.lock`);
    } catch {
      throw new ReviewAppError("receipt-lock-cleanup");
    }
  };
}
export async function atomicReceiptWrite(path: string, value: unknown): Promise<void> {
  const stage = `${path}.${randomUUID()}.stage`;
  try {
    await writeFile(stage, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    await rename(stage, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(stage, { force: true });
  }
}
export interface ReviewTransitionIntent extends ReviewAttempt {
  id: string;
  appId: number;
  status: "PENDING" | "BLOCKED";
}
export async function admitReviewTransition(
  path: string,
  intent: ReviewTransitionIntent,
): Promise<void> {
  const root = `${path}.intents`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, `${receiptIdentifier(intent.id)}.json`);
  const stage = join(root, `.${randomUUID()}.stage`);
  try {
    await writeFile(stage, JSON.stringify(intent), { mode: 0o600, flag: "wx", flush: true });
    await link(stage, target);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
      throw error;
    if ((await readFile(target, "utf8")) !== JSON.stringify(intent))
      throw new ReviewAppError("transition-conflict");
  } finally {
    await rm(stage, { force: true });
  }
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function unresolvedReviewTransitions(path: string): Promise<boolean> {
  try {
    return (await readdir(`${path}.intents`)).some((name) => !name.endsWith(".stage"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw new ReviewAppError("transition-state-invalid");
  }
}
export async function closeReviewTransition(
  path: string,
  intent: ReviewTransitionIntent,
): Promise<void> {
  const target = join(`${path}.intents`, `${receiptIdentifier(intent.id)}.json`);
  if ((await readFile(target, "utf8")) !== JSON.stringify(intent))
    throw new ReviewAppError("transition-conflict");
  await rm(target);
  const directory = await open(dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
