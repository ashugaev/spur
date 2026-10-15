import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { integer, object, ReviewAppError, string } from "./github-app.js";
import { digest } from "./review-interface.js";
import {
  atomicReceiptWrite,
  expandReceiptPath,
  receiptHash,
  receiptIdentifier,
} from "./review-receipt.js";
import { parseContinuationOutcomes, type ContinuationFence } from "./release-continuation-state.js";
import {
  captureReleaseTaskIdentity,
  type ReleaseCompletionGuard,
  type ReleaseCompletionResult,
  type ReleaseTaskIdentity,
} from "./session-service.js";
import { sessionArtifactsDir } from "./session-artifacts.js";
import { sendTelegramMessageOnce } from "./telegram-source-state.js";
import type { SessionRecord } from "./types.js";

export interface ReleasePostMember {
  sessionId: string;
  role: "worker" | "reviewer" | "child";
  project: string;
  workspaceId: string;
  branch: string;
  taskDigest: string;
}
export interface ReleasePostPolicy {
  repository: string;
  pr: number;
  generation: number;
  archiveRoot: string;
  members: ReleasePostMember[];
  evidence: string[];
  change: string;
  flow: string;
  telegram: { recipient: number; targetProof: { file: string; digest: string } };
}
export function parseReleasePostPolicy(value: unknown): ReleasePostPolicy {
  const row = object(value),
    telegram = object(row.telegram),
    proof = object(telegram.targetProof);
  if (!Array.isArray(row.members) || !row.members.length || !Array.isArray(row.evidence))
    throw new ReviewAppError("release-post-policy-invalid");
  const members = row.members.map((value: unknown): ReleasePostMember => {
    const member = object(value);
    if (member.role !== "worker" && member.role !== "reviewer" && member.role !== "child")
      throw new ReviewAppError("release-post-policy-invalid");
    return {
      sessionId: receiptIdentifier(member.sessionId),
      role: member.role,
      project: receiptIdentifier(member.project),
      workspaceId: receiptIdentifier(member.workspaceId),
      branch: string(member.branch),
      taskDigest: receiptHash(member.taskDigest, 64),
    };
  });
  if (
    new Set(members.map((member) => member.sessionId)).size !== members.length ||
    members.filter((member) => member.role === "worker").length !== 1
  )
    throw new ReviewAppError("release-post-members-invalid");
  return {
    repository: string(row.repository),
    pr: integer(row.pr),
    generation: integer(row.generation),
    archiveRoot: string(row.archiveRoot),
    members,
    evidence: row.evidence.map(string),
    change: string(row.change),
    flow: string(row.flow),
    telegram: {
      recipient: integer(telegram.recipient),
      targetProof: { file: string(proof.file), digest: receiptHash(proof.digest, 64) },
    },
  };
}
export interface VerifiedRelease {
  repository: string;
  pr: number;
  mergeSha: string;
  version: string;
  gitHead: string;
  integrity: string;
  deploymentDigest: string;
}
function parseVerifiedRelease(value: unknown): VerifiedRelease {
  const release = object(value);
  return {
    repository: string(release.repository),
    pr: integer(release.pr),
    mergeSha: receiptHash(release.mergeSha, 40),
    version: string(release.version),
    gitHead: receiptHash(release.gitHead, 40),
    integrity: string(release.integrity),
    deploymentDigest: receiptHash(release.deploymentDigest, 64),
  };
}
type StepState = "pending" | "intent" | "confirmed" | "blocked" | "uncertain";
interface CleanupStep {
  sessionId: string;
  role: ReleasePostMember["role"];
  state: StepState;
  reason: string;
}
interface ReleaseJournal {
  version: 1;
  key: string;
  release: VerifiedRelease;
  policyDigest: string;
  flowOutcomes: string[];
  archive: { state: StepState; path: string | null; digest: string | null };
  cleanup: CleanupStep[];
  notification: {
    state: StepState;
    text: string | null;
    digest: string | null;
    messageId: number | null;
    chatId: number | null;
    retryAt: number;
    reason: string;
  };
}
export interface ReleasePostDependencies {
  root: string;
  dataDir: string;
  receiptRoot: string;
  flowOutcomes?: string[];
  fence: ContinuationFence;
  session(id: string): SessionRecord | null;
  complete(id: string, guard: ReleaseCompletionGuard): Promise<ReleaseCompletionResult>;
  readTargetProof(binding: ReleasePostPolicy["telegram"]["targetProof"]): Promise<unknown>;
}
function json(bytes: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new ReviewAppError("release-journal-invalid");
  }
}
function parseJournal(value: unknown): ReleaseJournal {
  const row = object(value),
    release = object(row.release),
    archive = object(row.archive),
    notification = object(row.notification);
  const state = (value: unknown): StepState => {
    if (
      value !== "pending" &&
      value !== "intent" &&
      value !== "confirmed" &&
      value !== "blocked" &&
      value !== "uncertain"
    )
      throw new ReviewAppError("release-journal-invalid");
    return value;
  };
  if (
    row.version !== 1 ||
    !Array.isArray(row.cleanup) ||
    typeof notification.retryAt !== "number" ||
    !Number.isFinite(notification.retryAt) ||
    notification.retryAt < 0
  )
    throw new ReviewAppError("release-journal-invalid");
  return {
    version: 1,
    key: receiptHash(row.key, 64),
    policyDigest: receiptHash(row.policyDigest, 64),
    flowOutcomes: parseContinuationOutcomes(row.flowOutcomes),
    release: parseVerifiedRelease(release),
    archive: {
      state: state(archive.state),
      path: archive.path === null ? null : string(archive.path),
      digest: archive.digest === null ? null : receiptHash(archive.digest, 64),
    },
    cleanup: row.cleanup.map((value: unknown): CleanupStep => {
      const step = object(value);
      if (
        (step.role !== "worker" && step.role !== "reviewer" && step.role !== "child") ||
        typeof step.reason !== "string"
      )
        throw new ReviewAppError("release-journal-invalid");
      return {
        sessionId: receiptIdentifier(step.sessionId),
        role: step.role,
        state: state(step.state),
        reason: step.reason,
      };
    }),
    notification: {
      state: state(notification.state),
      text: notification.text === null ? null : string(notification.text),
      digest: notification.digest === null ? null : receiptHash(notification.digest, 64),
      messageId: notification.messageId === null ? null : integer(notification.messageId),
      chatId: notification.chatId === null ? null : integer(notification.chatId),
      retryAt: notification.retryAt,
      reason:
        typeof notification.reason === "string"
          ? notification.reason
          : (() => {
              throw new ReviewAppError("release-journal-invalid");
            })(),
    },
  };
}
function isWithin(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
interface ArchiveFile {
  path: string;
  digest: string;
}
type ArchivedIdentity = Omit<ReleaseTaskIdentity, "updatedAt">;
interface EvidenceArchive {
  version: 1;
  key: string;
  release: VerifiedRelease;
  members: { identity: ArchivedIdentity }[];
  files: ArchiveFile[];
}
async function collectFiles(
  root: string,
  prefix = "",
): Promise<{ relative: string; bytes: Buffer }[]> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new ReviewAppError("release-archive-symlink");
  if (info.isFile()) return [{ relative: prefix || "file", bytes: await readFile(root) }];
  if (!info.isDirectory()) throw new ReviewAppError("release-archive-source-invalid");
  const files: { relative: string; bytes: Buffer }[] = [];
  for (const name of (await readdir(root)).sort())
    files.push(...(await collectFiles(join(root, name), join(prefix, name))));
  return files;
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function verifyArchive(path: string, expected: string): Promise<EvidenceArchive> {
  const bytes = await readFile(path, "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new ReviewAppError("release-archive-changed");
  const row = object(json(bytes));
  if (row.version !== 1 || !Array.isArray(row.members) || !Array.isArray(row.files))
    throw new ReviewAppError("release-archive-invalid");
  for (const value of row.files) {
    const file = object(value),
      relativePath = string(file.path);
    const target = join(dirname(path), relativePath);
    if (!isWithin(dirname(path), target) || isAbsolute(relativePath))
      throw new ReviewAppError("release-archive-invalid");
    if (
      createHash("sha256")
        .update(await readFile(target))
        .digest("hex") !== receiptHash(file.digest, 64)
    )
      throw new ReviewAppError("release-archive-changed");
  }
  const members = row.members.map((value: unknown) => {
    const identity = object(object(value).identity);
    return {
      identity: {
        sessionId: receiptIdentifier(identity.sessionId),
        project: receiptIdentifier(identity.project),
        workspaceId: receiptIdentifier(identity.workspaceId),
        worktreePath: string(identity.worktreePath),
        branch: string(identity.branch),
        repository: string(identity.repository),
        pr: integer(identity.pr),
        taskDigest: receiptHash(identity.taskDigest, 64),
        launchDigest: receiptHash(identity.launchDigest, 64),
      },
    };
  });
  return {
    version: 1,
    key: receiptHash(row.key, 64),
    release: parseVerifiedRelease(row.release),
    members,
    files: row.files.map((value: unknown) => {
      const file = object(value);
      return { path: string(file.path), digest: receiptHash(file.digest, 64) };
    }),
  };
}
function identityFor(
  member: ReleasePostMember,
  policy: ReleasePostPolicy,
  record: SessionRecord,
): ReleaseTaskIdentity {
  const identity = captureReleaseTaskIdentity(record);
  if (
    identity.sessionId !== member.sessionId ||
    identity.project !== member.project ||
    identity.workspaceId !== member.workspaceId ||
    identity.branch !== member.branch ||
    identity.repository === null ||
    identity.repository.toLowerCase() !== policy.repository.toLowerCase() ||
    identity.pr !== policy.pr ||
    identity.taskDigest !== member.taskDigest
  )
    throw new ReviewAppError("release-task-changed");
  return identity;
}
async function archiveEvidence(
  policy: ReleasePostPolicy,
  journal: ReleaseJournal,
  deps: ReleasePostDependencies,
): Promise<{ path: string; digest: string }> {
  const root = expandReceiptPath(policy.archiveRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const target = join(canonical, journal.key),
    existingPath = join(target, "manifest.json");
  try {
    const bytes = await readFile(existingPath, "utf8"),
      hash = createHash("sha256").update(bytes).digest("hex");
    const existing = await verifyArchive(existingPath, hash);
    if (existing.key !== journal.key || digest(existing.release) !== digest(journal.release))
      throw new ReviewAppError("release-archive-conflict");
    return { path: existingPath, digest: hash };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
  const identities = policy.members.flatMap((member) => {
    const session = deps.session(member.sessionId);
    if (!session) {
      const step = journal.cleanup.find((step) => step.sessionId === member.sessionId);
      if (step) {
        step.state = "blocked";
        step.reason = "release-member-missing-before-archive";
      }
      return [];
    }
    let identity: ReleaseTaskIdentity;
    try {
      identity = identityFor(member, policy, session);
    } catch (error) {
      if (!(error instanceof ReviewAppError)) throw error;
      const step = journal.cleanup.find((step) => step.sessionId === member.sessionId);
      if (step) {
        step.state = "blocked";
        step.reason = error.category;
      }
      return [];
    }
    if (isWithin(identity.worktreePath, canonical))
      throw new ReviewAppError("release-archive-in-worktree");
    return [identity];
  });
  if (isWithin(join(deps.dataDir, "session-artifacts"), canonical))
    throw new ReviewAppError("release-archive-in-artifacts");
  const sources = [
    ...new Set([
      join(expandReceiptPath(deps.receiptRoot), policy.repository.toLowerCase(), String(policy.pr)),
      ...identities.map((identity) => sessionArtifactsDir(deps.dataDir, identity.workspaceId)),
      ...policy.evidence,
    ]),
  ];
  const stage = join(canonical, `.${randomUUID()}.stage`);
  await mkdir(stage, { mode: 0o700 });
  const files: ArchiveFile[] = [];
  try {
    for (const [index, source] of sources.entries()) {
      const sourcePath = await realpath(expandReceiptPath(source));
      if (isWithin(sourcePath, canonical)) throw new ReviewAppError("release-archive-recursive");
      for (const file of await collectFiles(sourcePath)) {
        const path = join(String(index), file.relative),
          destination = join(stage, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.bytes, { mode: 0o600, flag: "wx", flush: true });
        await syncDirectory(dirname(destination));
        files.push({ path, digest: createHash("sha256").update(file.bytes).digest("hex") });
      }
    }
    const archive: EvidenceArchive = {
      version: 1,
      key: journal.key,
      release: journal.release,
      members: identities.map(({ updatedAt: _updatedAt, ...identity }) => ({ identity })),
      files,
    };
    const bytes = JSON.stringify(archive);
    await writeFile(join(stage, "manifest.json"), bytes, { mode: 0o600, flag: "wx", flush: true });
    await syncDirectory(stage);
    await deps.fence.assertCurrent();
    await rename(stage, target);
    await syncDirectory(canonical);
    const path = join(target, "manifest.json"),
      hash = createHash("sha256").update(bytes).digest("hex");
    await verifyArchive(path, hash);
    return { path, digest: hash };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
function reportText(policy: ReleasePostPolicy, journal: ReleaseJournal): string {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ");
  const done = journal.cleanup.filter((step) => step.state === "confirmed").length;
  const blocked = journal.cleanup
    .filter((step) => step.state !== "confirmed")
    .map((step) => `${step.role}: ${step.reason || step.state}`);
  return [
    `#${policy.pr}: ${oneLine(policy.change)} https://github.com/${policy.repository}/pull/${policy.pr}`,
    `Версия ${journal.release.version}: https://github.com/${policy.repository}/releases/tag/v${journal.release.version}; развёртывание проверено`,
    `Поток: ${oneLine(policy.flow)}; последние состояния: ${journal.flowOutcomes.length ? journal.flowOutcomes.join(" → ") : "нет сохранённых исходов"}`,
    `Очистка работников/ревьюеров: ${done}/${journal.cleanup.length}; ${blocked.length ? oneLine(blocked.join("; ")) : "ресурсы освобождены"}`,
  ].join("\n");
}
export async function continueReleasePost(
  policy: ReleasePostPolicy,
  policyDigest: string,
  release: VerifiedRelease | null,
  deps: ReleasePostDependencies,
): Promise<{ complete: boolean; reason: string }> {
  if (
    release &&
    (release.repository.toLowerCase() !== policy.repository.toLowerCase() ||
      release.pr !== policy.pr)
  )
    throw new ReviewAppError("release-post-task-mismatch");
  await mkdir(deps.root, { recursive: true, mode: 0o700 });
  const indexPath = join(
    deps.root,
    `task-${digest({ repository: policy.repository.toLowerCase(), pr: policy.pr })}.json`,
  );
  let key: string;
  let pinnedRelease: VerifiedRelease;
  try {
    const index = object(json(await readFile(indexPath, "utf8")));
    if (
      index.repository !== policy.repository.toLowerCase() ||
      index.pr !== policy.pr ||
      index.generation !== policy.generation
    )
      throw new ReviewAppError("release-task-index-conflict");
    key = receiptHash(index.key, 64);
    pinnedRelease = parseVerifiedRelease(index.release);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
    if (!release) throw new ReviewAppError("release-verified-journal-missing");
    pinnedRelease = release;
    key = digest({
      repository: release.repository.toLowerCase(),
      pr: release.pr,
      mergeSha: release.mergeSha,
      version: release.version,
    });
    const stage = join(deps.root, `.${randomUUID()}.stage`);
    try {
      await writeFile(
        stage,
        JSON.stringify({
          repository: release.repository.toLowerCase(),
          pr: release.pr,
          generation: policy.generation,
          key,
          release,
        }),
        { mode: 0o600, flag: "wx", flush: true },
      );
      await deps.fence.assertCurrent();
      await link(stage, indexPath);
      await syncDirectory(deps.root);
    } finally {
      await rm(stage, { force: true });
    }
  }
  const path = join(deps.root, `${key}.json`);
  let journal: ReleaseJournal;
  try {
    journal = parseJournal(json(await readFile(path, "utf8")));
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
    journal = {
      version: 1,
      key,
      release: pinnedRelease,
      policyDigest,
      flowOutcomes: deps.flowOutcomes ?? [],
      archive: { state: "pending", path: null, digest: null },
      cleanup: policy.members.map((member) => ({
        sessionId: member.sessionId,
        role: member.role,
        state: "pending",
        reason: "",
      })),
      notification: {
        state: "pending",
        text: null,
        digest: null,
        messageId: null,
        chatId: null,
        retryAt: 0,
        reason: "",
      },
    };
  }
  if (
    journal.key !== key ||
    journal.policyDigest !== policyDigest ||
    digest(journal.release) !== digest(pinnedRelease) ||
    (release && release.mergeSha !== pinnedRelease.mergeSha)
  )
    throw new ReviewAppError("release-journal-conflict");
  const save = async () => {
    await deps.fence.assertCurrent();
    await atomicReceiptWrite(path, journal);
  };
  await save();
  let archive: EvidenceArchive | null = null;
  try {
    if (journal.archive.state !== "confirmed") {
      journal.archive.state = "intent";
      await save();
      journal.archive = { state: "confirmed", ...(await archiveEvidence(policy, journal, deps)) };
      await save();
    }
    if (!journal.archive.path || !journal.archive.digest)
      throw new ReviewAppError("release-archive-invalid");
    archive = await verifyArchive(journal.archive.path, journal.archive.digest);
  } catch {
    journal.archive.state = "blocked";
    for (const step of journal.cleanup.filter((step) => step.state !== "confirmed")) {
      step.state = "blocked";
      step.reason = "release-archive-unverified";
    }
    await save();
  }
  for (const role of ["child", "reviewer", "worker"] as const)
    for (const step of journal.cleanup.filter((step) => step.role === role)) {
      if (step.state === "confirmed") continue;
      if (!archive || !journal.archive.path || !journal.archive.digest) continue;
      const member = policy.members.find((member) => member.sessionId === step.sessionId);
      const archived = archive.members.find(
        (member) => member.identity.sessionId === step.sessionId,
      )?.identity;
      if (!member) throw new ReviewAppError("release-member-archive-invalid");
      if (!archived) {
        step.state = "blocked";
        step.reason = step.reason || "release-member-archive-unavailable";
        await save();
        continue;
      }
      try {
        const record = deps.session(step.sessionId);
        if (record) {
          const identity = identityFor(member, policy, record);
          const expectedMembers = policy.members.flatMap((member) => {
            const current = deps.session(member.sessionId);
            if (!current) return [];
            try {
              return [identityFor(member, policy, current)];
            } catch (error) {
              if (!(error instanceof ReviewAppError)) throw error;
              return [];
            }
          });
          step.state = "intent";
          await save();
          await deps.fence.assertCurrent();
          const result = await deps.complete(step.sessionId, {
            identity,
            members: expectedMembers,
            archive: { path: journal.archive.path, digest: journal.archive.digest },
          });
          step.state = result.status === "verified" ? "confirmed" : "blocked";
          step.reason = result.reason ?? "";
        } else {
          step.state = "blocked";
          step.reason = "member-absence-unproved";
        }
      } catch (error) {
        step.state = "blocked";
        step.reason = error instanceof ReviewAppError ? error.category : "lifecycle-blocked";
      }
      await save();
    }
  if (journal.notification.state === "intent") {
    journal.notification.state = "uncertain";
    journal.notification.reason = "telegram-dispatch-unreconciled";
    await save();
  }
  if (
    journal.notification.state !== "confirmed" &&
    journal.notification.state !== "uncertain" &&
    Date.now() >= journal.notification.retryAt
  ) {
    const target = object(await deps.readTargetProof(policy.telegram.targetProof));
    if (
      target.status !== "OK" ||
      target.type !== "private" ||
      target.chatId !== policy.telegram.recipient
    )
      throw new ReviewAppError("release-report-target-unverified");
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) {
      journal.notification.state = "blocked";
      journal.notification.reason = "primary-bot-token-missing";
      await save();
    } else {
      const text = journal.notification.text ?? reportText(policy, journal);
      if (Buffer.byteLength(text, "utf8") > 4000)
        throw new ReviewAppError("release-report-too-long");
      journal.notification = {
        ...journal.notification,
        state: "intent",
        text,
        digest: digest(text),
        reason: "",
      };
      await save();
      await deps.fence.assertCurrent();
      const outcome = await sendTelegramMessageOnce({ token }, policy.telegram.recipient, text);
      if (outcome.status === "accepted")
        journal.notification = {
          ...journal.notification,
          state: "confirmed",
          messageId: outcome.messageId,
          chatId: outcome.chatId,
        };
      else if (outcome.status === "uncertain")
        journal.notification = {
          ...journal.notification,
          state: "uncertain",
          reason: "telegram-dispatch-uncertain",
        };
      else
        journal.notification = {
          ...journal.notification,
          state: "blocked",
          reason: `telegram-rejected-${outcome.errorCode}`,
          retryAt: Date.now() + (outcome.retryAfterMs ?? 60_000),
        };
      await save();
    }
  }
  const complete =
    journal.cleanup.every((step) => step.state === "confirmed") &&
    journal.notification.state === "confirmed";
  return {
    complete,
    reason: complete
      ? "released-cleaned-reported"
      : journal.notification.state === "uncertain"
        ? "telegram-dispatch-uncertain"
        : "release-post-incomplete",
  };
}
