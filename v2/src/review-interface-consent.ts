import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJson, object, integer, GitHubApp, effectiveNativeReview } from "./github-app.js";
import {
  parseManifest,
  manifestDigest,
  baselineDigest,
  type InterfaceManifest,
} from "./review-interface.js";
import { parseConfig } from "./review-app.js";
import { readInterfaceConsent, writeInterfaceConsent, readSession } from "./metadata.js";
import { readStateBody, isStateBody, publishConsentState } from "./review-state.js";
import { resolveWorkspaceState } from "./workspace-store.js";
import { workspaceIdOf } from "./session-desk.js";

export type ConsentDecision = "approved" | "rejected" | "revoked";
export interface InterfaceConsent {
  version: 1;
  session: string;
  authority: string;
  repository: string;
  branch: string;
  baseBranch: string;
  projectId: string;
  sourceId: string;
  chatId: number;
  approverUserId: number;
  manifest: InterfaceManifest;
  manifestDigest: string;
  baselineDigest: string;
  challenge: string;
  generation: number;
  expiresAt: string;
  decision: "pending" | ConsentDecision;
  delivery: "pending" | "sent" | "failed";
  decidedAt?: string;
  outbox: "pending" | "published";
  boundPr?: { number: number; headRepository: string };
}

export async function consentPolicy(
  allowedUsers: number[] | undefined,
): Promise<{ repositories: string[]; approverUserId: number }> {
  const path = process.env.SPUR_REVIEW_APP_CONFIG;
  if (!path) throw new Error("Interface approval requires SPUR_REVIEW_APP_CONFIG");
  const config = object(await readJson(path));
  const approverUserId = integer(object(config.consent).approverUserId);
  if (!allowedUsers?.includes(approverUserId))
    throw new Error("Designated interface approver is not allowed by this source");
  if (
    !Array.isArray(config.repositories) ||
    !config.repositories.every((repo): repo is string => typeof repo === "string")
  )
    throw new Error("Invalid review repository policy");
  return { repositories: config.repositories, approverUserId };
}

export async function repositoryOf(worktree: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["remote", "get-url", "origin"], {
    cwd: worktree,
  });
  const match = stdout
    .trim()
    .match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error("Interface approval requires a GitHub repository origin");
  return match[1];
}

export function proposeConsent(
  input: Omit<
    InterfaceConsent,
    | "version"
    | "manifestDigest"
    | "baselineDigest"
    | "challenge"
    | "generation"
    | "expiresAt"
    | "decision"
    | "delivery"
    | "outbox"
    | "authority"
  > & { authority?: string },
  previous: InterfaceConsent | null,
  now = Date.now(),
): InterfaceConsent {
  const manifest = parseManifest(input.manifest);
  if (manifest.repository !== input.repository || manifest.baseBranch !== input.baseBranch)
    throw new Error("Interface proposal repository/base mismatch");
  const authority = input.authority ?? input.session;
  if (
    previous &&
    (previous.authority !== authority ||
      previous.repository !== input.repository ||
      previous.projectId !== input.projectId)
  )
    throw new Error("Interface proposal task binding changed");
  const { boundPr: _boundPr, ...proposal } = input;
  const sameBranch = previous?.branch === input.branch && previous.baseBranch === input.baseBranch;
  return {
    ...proposal,
    authority,
    ...(sameBranch && previous.boundPr ? { boundPr: previous.boundPr } : {}),
    manifest,
    version: 1,
    manifestDigest: manifestDigest(manifest),
    baselineDigest: baselineDigest(manifest),
    challenge: randomUUID(),
    generation: (previous?.generation ?? 0) + 1,
    expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    decision: "pending",
    delivery: "pending",
    outbox: "pending",
  };
}

export function decideConsent(
  record: InterfaceConsent,
  input: {
    session: string;
    sourceId: string;
    projectId: string;
    chatId: number;
    actor: number;
    challenge: string;
    decision: ConsentDecision;
  },
  now = Date.now(),
): InterfaceConsent {
  if (
    record.delivery !== "sent" ||
    record.decision !== "pending" ||
    Date.parse(record.expiresAt) <= now ||
    input.session !== record.session ||
    input.sourceId !== record.sourceId ||
    input.projectId !== record.projectId ||
    input.chatId !== record.chatId ||
    input.actor !== record.approverUserId ||
    input.challenge !== record.challenge
  )
    throw new Error("Interface approval challenge is inactive or belongs to another actor/source");
  return {
    ...record,
    decision: input.decision,
    decidedAt: new Date(now).toISOString(),
    outbox: "pending",
  };
}

export function presentConsent(record: InterfaceConsent): string {
  return [
    `Interface approval · ${record.repository} · ${record.branch} → ${record.baseBranch}`,
    ...record.manifest.surfaces.flatMap((surface) => [
      `${surface.kind}: ${surface.id}`,
      `Before: ${surface.before.join("; ") || "none"}`,
      `After: ${surface.after.join("; ") || "none"}`,
      `Constraints: ${surface.constraints.join("; ") || "none"}`,
    ]),
  ].join("\n");
}

export function parseConsent(value: unknown): InterfaceConsent {
  const data = object(value);
  const manifest = parseManifest(data.manifest);
  for (const field of [
    "session",
    "authority",
    "repository",
    "branch",
    "baseBranch",
    "projectId",
    "sourceId",
    "challenge",
    "expiresAt",
  ] as const)
    if (typeof data[field] !== "string" || !data[field])
      throw new Error("Invalid interface consent record");
  if (
    data.version !== 1 ||
    !Number.isSafeInteger(data.chatId) ||
    !Number.isSafeInteger(data.approverUserId) ||
    Number(data.approverUserId) <= 0 ||
    !Number.isSafeInteger(data.generation) ||
    Number(data.generation) < 1 ||
    !["pending", "approved", "rejected", "revoked"].includes(String(data.decision)) ||
    !["pending", "sent", "failed"].includes(String(data.delivery)) ||
    !["pending", "published"].includes(String(data.outbox)) ||
    !Number.isFinite(Date.parse(String(data.expiresAt))) ||
    data.manifestDigest !== manifestDigest(manifest) ||
    data.baselineDigest !== baselineDigest(manifest) ||
    data.repository !== manifest.repository ||
    data.baseBranch !== manifest.baseBranch ||
    (data.decision !== "pending" &&
      (typeof data.decidedAt !== "string" || !Number.isFinite(Date.parse(data.decidedAt)))) ||
    (data.decision === "pending" && data.outbox === "published")
  )
    throw new Error("Invalid interface consent record");
  if (data.boundPr !== undefined) {
    const binding = object(data.boundPr);
    integer(binding.number);
    if (
      typeof binding.headRepository !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(binding.headRepository)
    )
      throw new Error("Invalid interface consent PR binding");
  }
  return data as unknown as InterfaceConsent;
}

/** Public proof is created only from a daemon-owned task binding and fresh App evidence. */
export async function reconcileInterfaceConsent(dataDir: string, sessionId: string): Promise<void> {
  const record = readInterfaceConsent(dataDir, sessionId);
  const storedSession = readSession(dataDir, sessionId);
  const session = storedSession
    ? { ...storedSession, pr: resolveWorkspaceState(dataDir, storedSession).pr }
    : null;
  if (
    !record ||
    record.session !== sessionId ||
    record.decision === "pending" ||
    record.outbox === "published" ||
    !session?.pr
  )
    return;
  if (
    record.authority !== workspaceIdOf(session) ||
    record.projectId !== session.project ||
    record.repository !== session.pr.repo ||
    record.branch !== session.branch
  )
    throw new Error("Interface consent PR/task mismatch");
  const configPath = process.env.SPUR_REVIEW_APP_CONFIG;
  if (!configPath) throw new Error("Interface consent publication requires App config");
  const raw = await readJson(configPath);
  if (integer(object(object(raw).consent).approverUserId) !== record.approverUserId)
    throw new Error("Interface approver policy changed");
  const config = parseConfig(raw);
  if (!config.repositories.includes(record.repository))
    throw new Error("Interface repository is not allowed");
  const code = new GitHubApp(config.code, record.repository);
  const browser = new GitHubApp(config.browser, record.repository);
  const identities = [await code.authenticate()];
  if (record.decision === "approved") {
    identities.push(await browser.authenticate());
    if (identities[0]?.actor === identities[1]?.actor)
      throw new Error("Interface review Apps must be distinct");
  }
  const pullPath = `/repos/${record.repository}/pulls/${session.pr.number}`;
  const pull = object(await code.request(pullPath));
  const head = object(pull.head);
  const base = object(pull.base);
  const headRepository = object(head.repo).full_name;
  if (
    pull.state !== "open" ||
    head.ref !== record.branch ||
    base.ref !== record.baseBranch ||
    object(base.repo).full_name !== record.repository ||
    typeof headRepository !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(headRepository)
  )
    throw new Error("Interface consent PR branch/repository mismatch");
  if (
    record.boundPr &&
    (record.boundPr.number !== session.pr.number ||
      record.boundPr.headRepository !== headRepository)
  )
    throw new Error("Interface consent is already bound to another PR");
  if (!record.boundPr) {
    const unbound = readInterfaceConsent(dataDir, sessionId);
    if (
      !unbound ||
      unbound.challenge !== record.challenge ||
      unbound.generation !== record.generation ||
      unbound.decision !== record.decision
    )
      throw new Error("Interface consent superseded before binding");
    writeInterfaceConsent(dataDir, {
      ...unbound,
      boundPr: { number: session.pr.number, headRepository },
    });
  }
  const comments =
    record.decision === "approved"
      ? (
          await code.history(`/repos/${record.repository}/issues/${session.pr.number}/comments`)
        ).map(object)
      : [];
  const reviews =
    record.decision === "approved" ? (await code.history(`${pullPath}/reviews`)).map(object) : [];
  for (const [index, lane] of (record.decision === "approved"
    ? ["code", "browser"]
    : []
  ).entries()) {
    const actor = identities[index]?.actor;
    const comment = comments
      .filter(
        (row) =>
          object(row.user).login === actor && typeof row.body === "string" && isStateBody(row.body),
      )
      .sort((a, b) => integer(b.id) - integer(a.id))[0];
    if (!comment || typeof comment.body !== "string")
      throw new Error("Interface lane attestation missing");
    const state = readStateBody(comment.body);
    if (!actor) throw new Error("Interface lane identity missing");
    const review = effectiveNativeReview(reviews, { login: actor });
    if (
      state.lane !== lane ||
      state.repo !== record.repository ||
      state.pr !== session.pr.number ||
      state.H !== head.sha ||
      state.B !== base.sha ||
      state.status !== "APPROVED" ||
      !state.assessment ||
      manifestDigest(state.assessment.manifest) !== record.manifestDigest ||
      baselineDigest(state.assessment.manifest) !== record.baselineDigest ||
      state.assessment.status !== "required" ||
      !review ||
      review.id !== state.reviewId ||
      review.state !== "APPROVED" ||
      review.commit_id !== head.sha
    )
      throw new Error("Interface current native/semantic attestation mismatch");
  }
  const current = readInterfaceConsent(dataDir, sessionId);
  if (
    !current ||
    current.challenge !== record.challenge ||
    current.generation !== record.generation ||
    current.decision !== record.decision
  )
    throw new Error("Interface consent superseded");
  const fresh = object(await code.request(pullPath));
  if (object(fresh.head).sha !== head.sha || object(fresh.base).sha !== base.sha)
    throw new Error("Interface PR moved");
  await publishConsentState(
    code,
    {
      version: 1,
      repo: record.repository,
      pr: session.pr.number,
      task: record.authority,
      branch: record.branch,
      baseBranch: record.baseBranch,
      manifestDigest: record.manifestDigest,
      baselineDigest: record.baselineDigest,
      challenge: record.challenge,
      decision: record.decision,
      generation: record.generation,
    },
    record.session,
  );
  const settled = readInterfaceConsent(dataDir, sessionId);
  if (
    !settled ||
    settled.challenge !== record.challenge ||
    settled.generation !== record.generation ||
    settled.decision !== record.decision
  )
    throw new Error("Interface consent superseded during publication");
  writeInterfaceConsent(dataDir, { ...settled, outbox: "published" });
}
