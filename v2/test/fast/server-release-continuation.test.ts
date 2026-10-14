import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { EventBus } from "../../src/event-bus.js";
import {
  startReleaseContinuations,
  type ReleaseContinuationController,
} from "../../src/release-continuation.js";
import { digest } from "../../src/review-interface.js";
import {
  lockReviewReceipt,
  readReviewReceipt,
  unresolvedReviewTransitions,
  type ReviewReceipt,
} from "../../src/review-receipt.js";
import type { SessionRecord, SessionView } from "../../src/types.js";
import { captureReleaseTaskIdentity } from "../../src/session-service.js";
import { object } from "../../src/github-app.js";
import type * as GateModule from "../../src/review-gate.js";
import type * as AppModule from "../../src/github-app.js";
import { stateBody } from "../../src/review-state.js";
import { createTempDir } from "../helpers/common.js";

const H = "a".repeat(40),
  B = "b".repeat(40);
const fixture = vi.hoisted(() => ({ reason: "all-gates-pass", merged: false }));
vi.mock("../../src/review-gate.js", async (original) => {
  const actual = await original<typeof GateModule>();
  return {
    ...actual,
    readGateSnapshot: async () => gateSnapshot(),
  };
});
const requiredJobs = [
  "Quality",
  "Playwright E2E",
  "Runtime Integration",
  "Real-Agent Smoke",
  "Spur Strict CI",
];
const publicEvidenceDigest = digest({
  rows: [{ status: "passed", evidence: "proof" }],
  coverage: { challenger: "challenge", output: "proof", omissionsClosed: true },
});
function gateSnapshot(): GateModule.GateSnapshot {
  const M = "d".repeat(40);
  const assessment = {
    status: "N/A" as const,
    manifest: { version: 1 as const, repository: "owner/repo", baseBranch: "main", surfaces: [] },
    dispositions: [
      {
        path: "internal.ts",
        callers: ["main"],
        surfaceIds: [],
        evidence: ["internal contract unchanged"],
      },
    ],
  };
  const snapshot: GateModule.GateSnapshot = {
    pr: {
      state: "open",
      draft: false,
      merged: fixture.merged,
      merge_commit_sha: "e".repeat(40),
      user: { id: 9 },
      head: { sha: H, ref: "feature/task", repo: { full_name: "owner/repo" } },
      base: { sha: B, ref: "main", repo: { full_name: "owner/repo" } },
    },
    reviews: [1, 2].map((id) => ({
      id: id * 11,
      user: { id, type: "Bot" },
      state: "APPROVED",
      commit_id: H,
      body: "approval",
      submitted_at: "2026-10-14T00:00:00Z",
    })),
    comments: [1, 2].map((id) => ({
      id,
      user: { id, type: "Bot" },
      body: stateBody({
        version: 1,
        repo: "owner/repo",
        pr: 4,
        lane: id === 1 ? "code" : "browser",
        session: id === 1 ? "code-session" : "browser-session",
        attempt: "attempt",
        H,
        B,
        evidenceDigest: publicEvidenceDigest,
        status: "APPROVED",
        reviewId: id * 11,
        assessment,
      }),
    })),
    files: [{ filename: "internal.ts" }],
    unresolved: 0,
    runs: [
      {
        id: 1,
        workflow_id: 30,
        path: ".github/workflows/ci.yml@refs/pull/4/merge",
        repository: { full_name: "owner/repo" },
        event: "pull_request",
        pull_requests: [{ number: 4, head: { sha: H }, base: { sha: B } }],
        head_sha: H,
        head_branch: "feature/task",
        display_title: `Spur CI v1 REF=refs/pull/4/merge M=${M}`,
        run_started_at: "2026-10-14T00:00:00Z",
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
      },
    ],
    jobs: requiredJobs.map((name, index) => ({
      id: index + 1,
      name,
      run_id: 1,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    })),
    ciAnchors: [{ runId: 1, merge: M, parents: [B, H] }],
  };
  const mode = fixture.reason;
  if (mode === "native-approval-missing") snapshot.reviews.pop();
  if (mode === "same-voter")
    snapshot.reviews[1] = { ...snapshot.reviews[1], user: { id: 1, type: "Bot" } };
  if (mode === "unresolved-threads") snapshot.unresolved = 1;
  if (mode === "ci-not-success") snapshot.runs[0] = { ...snapshot.runs[0], conclusion: "failure" };
  if (mode === "missing-ci") snapshot.jobs.pop();
  if (["failed-ci", "skipped-ci", "pending-ci"].includes(mode))
    snapshot.jobs[0] = {
      ...snapshot.jobs[0],
      status: mode === "pending-ci" ? "in_progress" : "completed",
      conclusion: mode === "failed-ci" ? "failure" : mode === "skipped-ci" ? "skipped" : null,
    };
  if (mode === "consent-missing")
    snapshot.comments = [1, 2].map((id) => ({
      id,
      user: { id, type: "Bot" },
      body: stateBody({
        version: 1,
        repo: "owner/repo",
        pr: 4,
        lane: id === 1 ? "code" : "browser",
        session: id === 1 ? "code-session" : "browser-session",
        attempt: "attempt",
        H,
        B,
        evidenceDigest: publicEvidenceDigest,
        status: "APPROVED",
        reviewId: id * 11,
        assessment: {
          ...assessment,
          status: "required",
          manifest: {
            ...assessment.manifest,
            surfaces: [
              {
                kind: "config",
                id: "setting",
                before: ["absent"],
                after: ["enabled"],
                constraints: [],
              },
            ],
          },
        },
      }),
    }));
  return snapshot;
}
vi.mock("../../src/github-app.js", async (original) => {
  const actual = await original<typeof AppModule>();
  return {
    ...actual,
    GitHubApp: class {
      constructor(private readonly credentials: { appId: number }) {}
      async authenticate() {
        return { actor: `review-bot-${this.credentials.appId}` };
      }
      async request() {
        return {
          head: { sha: "a".repeat(40) },
          base: { sha: "b".repeat(40) },
          state: "open",
          user: { login: "author" },
        };
      }
      async history() {
        return [
          {
            id: this.credentials.appId === 10 ? 11 : 22,
            user: { login: `review-bot-${this.credentials.appId}` },
            state: "APPROVED",
            commit_id: "a".repeat(40),
            body: "approval",
            submitted_at: "2026-10-14T00:00:00Z",
          },
        ];
      }
    },
  };
});
const roots: string[] = [],
  controllers: ReleaseContinuationController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  fixture.reason = "all-gates-pass";
  fixture.merged = false;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function setup(recovery?: unknown) {
  const root = await createTempDir("release-controller-");
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const pin = async (name: string, value: unknown) => {
    const file = join(root, name),
      bytes = typeof value === "string" ? value : JSON.stringify(value);
    await writeFile(file, bytes);
    return { file, digest: createHash("sha256").update(bytes).digest("hex") };
  };
  const contract = await pin("contract", "caller contract");
  const appKey = await pin("app-key", "fixture-key");
  const receiptRoot = join(root, "receipts"),
    receiptDir = join(receiptRoot, "owner", "repo", "4");
  await mkdir(receiptDir, { recursive: true });
  const baseReceipt: ReviewReceipt = {
    repository: "owner/repo",
    PR: 4,
    lane: "code",
    session: "code-session",
    attempt: "attempt",
    H,
    B,
    contractDigest: contract.digest,
    status: "APPROVED",
    localVerdict: "APPROVED",
    evidence: [{ status: "passed", evidence: "proof" }],
    coverage: { challenger: "challenge", output: "proof", omissionsClosed: true },
    reviewId: 11,
    reason: "",
    inputDigest: "c".repeat(64),
    appId: 10,
    reviewBlocked: false,
    mutationStarted: true,
    supersededAttempts: [],
  };
  await writeFile(join(receiptDir, "code.json"), JSON.stringify(baseReceipt));
  await writeFile(
    join(receiptDir, "browser.json"),
    JSON.stringify({
      ...baseReceipt,
      lane: "browser",
      session: "browser-session",
      appId: 20,
      reviewId: 22,
    }),
  );
  const token = join(root, "token");
  await writeFile(token, "token");
  const policy = await pin("policy", {
    gate: await pin("gate", {
      repository: "owner/repo",
      baseBranch: "main",
      codeActor: 1,
      browserActor: 2,
      ciWorkflowId: 30,
      ciJobs: requiredJobs,
    }),
    apps: await pin("apps", {
      repositories: ["owner/repo"],
      receiptRoot,
      code: { appId: 10, keyPath: appKey.file },
      browser: { appId: 20, keyPath: appKey.file },
    }),
    contract,
    protocol: await pin("protocol", "caller protocol"),
    tool: await pin("tool", "caller tool"),
    tokenFile: token,
    activation: null,
    registrations: [
      {
        pr: 4,
        generation: 1,
        active: true,
        scopeDigest: "d".repeat(64),
        owner: "owner-session",
        successor: null,
        restore: false,
        code: "code-session",
        browser: "browser-session",
        deployment: null,
        reviewerRecovery: recovery,
      },
    ],
  });
  const configFile = join(root, "spur.yaml");
  await writeFile(
    configFile,
    `dataDir: ${join(root, "data")}\nprojects:\n  sandbox:\n    path: ${checkout}\n    releaseContinuation:\n      policyFile: ${policy.file}\n      policyDigest: ${policy.digest}\n      intervalSeconds: 60\n`,
  );
  const config = loadConfig(configFile);
  const sessions = new Map<string, SessionRecord>();
  for (const id of ["owner-session", "code-session", "browser-session"])
    sessions.set(id, {
      id,
      project: "sandbox",
      agent: "codex",
      prompt: "task",
      branch: "feature/task",
      pr: { repo: "owner/repo", number: 4, url: "https://github.com/owner/repo/pull/4" },
      worktree: true,
      worktreePath: checkout,
      tmuxSession: id,
      launchCommand: "agent",
      agentLaunchId: `${id}-capability`,
      status: "running",
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
    });
  const send = vi.fn<(id: string, message: string) => Promise<void>>(async () => undefined),
    warn = vi.fn(),
    bus = new EventBus();
  const deps = {
    config,
    bus,
    session: (id: string) => sessions.get(id) ?? null,
    view: vi.fn(async (id: string): Promise<SessionView> => {
      const session = sessions.get(id);
      if (!session) throw new Error("missingfixture");
      return {
        ...session,
        lifecycle: { instanceId: "fixture", revision: 0, operation: null },
        runtimeAlive: true,
        workspaceExists: true,
        state: session.status === "running" ? "waiting" : "stopped",
        lastActivityAt: session.updatedAt,
        artifacts: [],
        services: [],
        sidecars: [],
      } satisfies SessionView;
    }),
    send,
    restore: vi.fn(),
    complete: vi.fn(),
    reviewerEvidence: vi.fn(
      async (): Promise<{
        nativeAgentAlive: boolean | null;
        historyAvailable: boolean;
        initialAcknowledged: boolean | null;
      }> => ({
        nativeAgentAlive: true,
        historyAvailable: true,
        initialAcknowledged: true,
      }),
    ),
    warn,
    transport: vi.fn(async () => Response.json({ parents: [{ sha: B }] })),
  };
  const start = async () => {
    const controller = await startReleaseContinuations(deps);
    controllers.push(controller);
    await controller.settled();
    return controller;
  };
  const readState = async () =>
    JSON.parse(
      await readFile(join(config.dataDir, "release-continuation", "sandbox", "4.json"), "utf8"),
    ) as {
      invocation: string;
      affirmations: { code: { challenge: string; accepted: boolean } };
      reason: string;
      outcomes: string[];
    };
  return {
    root,
    config,
    start,
    readState,
    receiptDir,
    receipt: baseReceipt,
    sessions,
    send,
    warn,
    bus,
    deps,
    policy,
    pin,
  };
}

const recoveryBounds = () => ({
  maxAttempts: 2,
  cooldownSeconds: 60,
  taskDigests: {
    code: digest({ prompt: "task", originalTaskPrompt: null }),
    browser: digest({ prompt: "task", originalTaskPrompt: null }),
  },
  environmentRepair: { owner: "owner-session", evidence: null },
});
async function revisePolicy(
  f: Awaited<ReturnType<typeof setup>>,
  revise: (policy: ReturnType<typeof object>) => void,
) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(f.policy.file, "utf8")) as unknown;
  } catch {
    throw new Error("invalidfixturepolicy");
  }
  revise(object(value));
  const bytes = JSON.stringify(value);
  await writeFile(f.policy.file, bytes);
  const binding = f.config.projects["sandbox"]?.releaseContinuation;
  if (!binding) throw new Error("missingbinding");
  binding.policyDigest = createHash("sha256").update(bytes).digest("hex");
}
test("a ..caller child remains inside a protected checkout", async () => {
  const f = await setup();
  const directory = join(f.root, "checkout", "..caller");
  await mkdir(directory);
  const contract = await f.pin("unsafe-contract", "caller contract");
  await writeFile(join(directory, "contract"), "caller contract");
  await revisePolicy(f, (policy) => {
    policy.contract = { ...contract, file: join(directory, "contract") };
  });
  await f.start();
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("continuation-policy-in-checkout"));
  expect(f.send).not.toHaveBeenCalled();
});
const proofModes = ["restart", "post-policy", "deployment", "target-proof"];
test.each(proofModes)("proof recovery %s preserves original release", async (mode) => {
  const f = await setup();
  const first = await f.start();
  await first.stop();
  controllers.splice(controllers.indexOf(first), 1);
  const statePath = join(f.config.dataDir, "release-continuation", "sandbox", "4.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  } catch {
    throw new Error("invalidfixturestate");
  }
  const state = object(value);
  const deployment = await f.pin("verified-deployment", {
    repository: "owner/repo",
    mergeSha: "e".repeat(40),
    version: "1.2.3",
    installedVersion: "1.2.3",
    webStatus: 200,
    gitHead: "f".repeat(40),
    integrity: "sha512-proof",
    packageSha256: "d".repeat(64),
  });
  const targetProof = await f.pin("target-proof", { status: "OK", type: "private", chatId: 77 });
  const postRelease = await f.pin("post-policy", {
    repository: "owner/repo",
    pr: 4,
    generation: 1,
    archiveRoot: join(f.root, "archive"),
    members: [...f.sessions.values()].map((session) => {
      const identity = captureReleaseTaskIdentity(session);
      return {
        sessionId: session.id,
        role: session.id === "owner-session" ? "worker" : "reviewer",
        project: session.project,
        workspaceId: identity.workspaceId,
        branch: session.branch,
        taskDigest: identity.taskDigest,
      };
    }),
    evidence: [],
    change: "Восстановление",
    flow: "Проверки сохранены",
    telegram: { recipient: 77, targetProof },
  });
  await revisePolicy(f, (policy) => {
    if (!Array.isArray(policy.registrations)) throw new Error("invalidfixture");
    object(policy.registrations[0]).deployment = deployment;
    policy.postRelease = postRelease;
  });
  if (mode !== "restart") {
    const reviewer = f.sessions.get("browser-session");
    if (!reviewer) throw new Error("missingreviewer");
    reviewer.worktreePath = join(f.root, "external-reviewer");
    await mkdir(reviewer.worktreePath);
    const source =
      mode === "post-policy" ? postRelease : mode === "deployment" ? deployment : targetProof;
    const file = join(reviewer.worktreePath, "authority");
    await writeFile(file, await readFile(source.file));
    if (mode === "target-proof") {
      let post: unknown;
      try {
        post = JSON.parse(await readFile(postRelease.file, "utf8")) as unknown;
      } catch {
        throw new Error("invalidfixturepostpolicy");
      }
      object(object(post).telegram).targetProof = { ...targetProof, file };
      const bytes = JSON.stringify(post);
      await writeFile(postRelease.file, bytes);
      postRelease.digest = createHash("sha256").update(bytes).digest("hex");
    }
    await revisePolicy(f, (policy) => {
      if (!Array.isArray(policy.registrations)) throw new Error("invalidfixture");
      if (mode === "deployment")
        object(policy.registrations[0]).deployment = { ...deployment, file };
      else policy.postRelease = mode === "post-policy" ? { ...postRelease, file } : postRelease;
    });
  }
  state.mergeSha = "e".repeat(40);
  state.publishedProofDigest = deployment.digest;
  await writeFile(statePath, JSON.stringify(state));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-primary-token");
  const send = vi.fn(async () =>
    Response.json({ ok: true, result: { message_id: 41, chat: { id: 77 } } }),
  );
  vi.stubGlobal("fetch", send);
  const second = await f.start();
  if (mode !== "restart") {
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("continuation-policy-in-checkout"));
    expect(send).not.toHaveBeenCalled();
    return;
  }
  const postRoot = join(f.config.dataDir, "release-continuation", "post-release");
  const names = await readdir(postRoot);
  const indexName = names.find((name) => name.startsWith("task-"));
  if (!indexName) throw new Error("indexmissing");
  let index: unknown;
  try {
    index = JSON.parse(await readFile(join(postRoot, indexName), "utf8")) as unknown;
  } catch {
    throw new Error("invalidfixtureindex");
  }
  expect(object(object(index).release).version).toBe("1.2.3");
  expect(send).toHaveBeenCalledTimes(1);
  await second.stop();
  controllers.splice(controllers.indexOf(second), 1);
  await rm(deployment.file);
  await f.start();
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.warn).not.toHaveBeenCalled();
});
test("QA evidence cannot be authority from a designated external reviewer checkout", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  const reviewer = f.sessions.get("browser-session");
  if (!reviewer) throw new Error("missingreviewer");
  reviewer.worktreePath = join(f.root, "external-reviewer");
  await mkdir(reviewer.worktreePath);
  f.deps.reviewerEvidence.mockResolvedValue({
    nativeAgentAlive: false,
    historyAvailable: false,
    initialAcknowledged: false,
  });
  const evidence = await f.pin("unsafe-qa", {});
  await writeFile(join(reviewer.worktreePath, "evidence"), "{}");
  await revisePolicy(f, (policy) => {
    if (!Array.isArray(policy.registrations)) throw new Error("invalidfixture");
    object(object(object(policy.registrations[0]).reviewerRecovery).environmentRepair).evidence = {
      ...evidence,
      file: join(reviewer.worktreePath, "evidence"),
    };
  });
  await f.start();
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("continuation-policy-in-checkout"));
  expect(f.deps.restore).not.toHaveBeenCalled();
});
const activationPins = ["activation", "nativeProof", "orderingAssessment"];
test.each(activationPins)("rejects %s in reviewer checkout", async (mode) => {
  const f = await setup();
  const reviewer = f.sessions.get("browser-session");
  if (!reviewer) throw new Error("missingreviewer");
  reviewer.worktreePath = join(f.root, "external-reviewer");
  await mkdir(reviewer.worktreePath);
  const nativeProof = await f.pin("native", {});
  const orderingAssessment = await f.pin("assessment", {});
  const file = join(reviewer.worktreePath, "authority");
  if (mode !== "activation") await writeFile(file, "{}");
  const activation = await f.pin("activation", {
    nativeProof: mode === "nativeProof" ? { ...nativeProof, file } : nativeProof,
    orderingAssessment:
      mode === "orderingAssessment" ? { ...orderingAssessment, file } : orderingAssessment,
  });
  if (mode === "activation") await writeFile(file, await readFile(activation.file));
  await revisePolicy(f, (policy) => {
    policy.activation = mode === "activation" ? { ...activation, file } : activation;
  });
  const controller = await f.start();
  for (const lane of ["code", "browser"] as const) {
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(join(f.config.dataDir, "release-continuation", "sandbox", "4.json"), "utf8"),
      ) as unknown;
    } catch {
      throw new Error("invalidfixturestate");
    }
    const state = object(value);
    const receiptPath = join(f.receiptDir, `${lane}.json`);
    const receipt = await readReviewReceipt(receiptPath);
    await controller.ingress(
      {
        repo: "owner/repo",
        pr: 4,
        lane,
        session: `${lane}-session`,
        attempt: "attempt",
        H,
        B,
        contractDigest: receipt.contractDigest,
        receipt: receiptPath,
        invocation: state.invocation,
        appId: lane === "code" ? 10 : 20,
        receiptDigest: digest(receipt),
        id: `affirm-${lane}`,
        challenge: object(object(state.affirmations)[lane]).challenge,
        status: "APPROVED",
      },
      `${lane}-session-capability`,
      true,
    );
    await controller.settled();
  }
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("continuation-policy-in-checkout"));
  expect((await f.readState()).reason).not.toBe("owner-gated-continuation");
});
async function acceptedQaEvidence(f: Awaited<ReturnType<typeof setup>>, delta: string) {
  const browser = f.sessions.get("browser-session");
  if (!browser) throw new Error("missingbrowser");
  const evidence = await f.pin(`qa-${delta}`, {
    acceptedOwnedWorkspaceTrust: true,
    owner: "owner-session",
    repository: "owner/repo",
    pr: 4,
    session: browser.id,
    lane: "browser",
    H,
    B,
    generation: 1,
    launchDigest: captureReleaseTaskIdentity(browser).launchDigest,
    changedPrerequisite: delta,
  });
  let value: unknown;
  try {
    value = JSON.parse(await readFile(f.policy.file, "utf8")) as unknown;
  } catch {
    throw new Error("invalidfixturepolicy");
  }
  const policy = object(value);
  if (!Array.isArray(policy.registrations)) throw new Error("invalidfixture");
  object(object(object(policy.registrations[0]).reviewerRecovery).environmentRepair).evidence =
    evidence;
  const bytes = JSON.stringify(policy);
  await writeFile(f.policy.file, bytes);
  const binding = f.config.projects["sandbox"]?.releaseContinuation;
  if (!binding) throw new Error("missingbinding");
  binding.policyDigest = createHash("sha256").update(bytes).digest("hex");
}
test("shell-only trust-blocked browser names QA owner; code approval retained; restart does not repeat repair", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  f.deps.reviewerEvidence.mockResolvedValue({
    nativeAgentAlive: false,
    historyAvailable: false,
    initialAcknowledged: false,
  });
  const controller = await f.start();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.deps.restore).not.toHaveBeenCalled();
  expect(f.deps.reviewerEvidence).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls.some((call) => String(call).includes("QAENVIRONMENTOWNER"))).toBe(true);
  expect(await readFile(join(f.receiptDir, "code.json"), "utf8")).toContain('"status":"APPROVED"');
  await controller.stop();
  controllers.splice(controllers.indexOf(controller), 1);
  await f.start();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.deps.restore).not.toHaveBeenCalled();
});
test("claimed trust DELTA cannot authorize restore; prior budget survives launch rotation and restart", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  const browser = f.sessions.get("browser-session");
  if (!browser) throw new Error("missingbrowser");
  browser.status = "stopped";
  f.deps.reviewerEvidence.mockResolvedValue({
    nativeAgentAlive: false,
    historyAvailable: false,
    initialAcknowledged: false,
  });
  f.deps.restore.mockImplementation(async () => {
    browser.agentLaunchId = `launch-${Date.now()}`;
  });
  await acceptedQaEvidence(f, "trust-accepted");
  const controller = await f.start();
  expect(f.deps.restore).not.toHaveBeenCalled();
  await controller.stop();
  controllers.splice(controllers.indexOf(controller), 1);
  const names = await readdir(join(f.config.dataDir, "release-continuation", "sandbox"));
  const path = join(
    f.config.dataDir,
    "release-continuation",
    "sandbox",
    names.find((name) => name.startsWith("reviewer-")) ?? "missing",
  );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("invalidfixturerecovery");
  }
  const prior = object(value);
  prior.attempts = 2;
  prior.attemptedAt = Date.now();
  prior.prerequisite = "reserved-prerequisite";
  await writeFile(path, JSON.stringify(prior));
  browser.agentLaunchId = "externally-rotated-launch";
  await acceptedQaEvidence(f, "claimed-new-delta");
  await f.start();
  expect(f.deps.restore).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toContain('"attempts": 2');
  expect(await readFile(path, "utf8")).toContain('"prerequisite": "reserved-prerequisite"');
  expect((await f.readState()).reason).toBe("reviewer-fixture-challenge-source-unavailable");
  expect(f.send.mock.calls.some((call) => call[0] === "browser-session")).toBe(false);
});
test("manual pause and new task never restore; current completed code approval retained", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  const browser = f.sessions.get("browser-session"),
    code = f.sessions.get("code-session");
  if (!browser || !code) throw new Error("missingfixture");
  browser.status = "paused";
  code.status = "completed";
  await f.start();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.deps.restore).not.toHaveBeenCalled();
  expect(f.deps.reviewerEvidence).not.toHaveBeenCalled();
});
test("changed reviewer task cannot inherit recovery authority", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  const browser = f.sessions.get("browser-session");
  if (!browser) throw new Error("missingbrowser");
  browser.prompt = "different task";
  await f.start();
  await vi.waitFor(async () => expect((await f.readState()).reason).toBe("reviewer-task-mismatch"));
  expect(f.deps.restore).not.toHaveBeenCalled();
  expect(f.deps.reviewerEvidence).not.toHaveBeenCalled();
});
test.each(["current", "task", "head", "base", "launch", "tool", "checkout"])(
  "caller %s claim never authorizes current-version recovery",
  async (mode) => {
    const f = await setup(recoveryBounds());
    await rm(join(f.receiptDir, "browser.json"));
    const browser = f.sessions.get("browser-session");
    if (!browser) throw new Error("missingbrowser");
    const identity = captureReleaseTaskIdentity(browser);
    const source = await f.pin("claimed-authority", { accepted: true, actor: "claimed-caller" });
    const claim = await f.pin("caller-current", {
      repository: "owner/repo",
      pr: 4,
      lane: "browser",
      session: browser.id,
      H: mode === "head" ? "f".repeat(40) : H,
      B: mode === "base" ? "f".repeat(40) : B,
      generation: 1,
      taskDigest: mode === "task" ? "f".repeat(64) : identity.taskDigest,
      launchDigest: mode === "launch" ? "f".repeat(64) : identity.launchDigest,
      version: "1.2.3",
      source,
      toolDigest:
        mode === "tool" ? "f".repeat(64) : createHash("sha256").update("caller tool").digest("hex"),
      contractDigest: f.receipt.contractDigest,
      protocolDigest: createHash("sha256").update("caller protocol").digest("hex"),
    });
    if (mode === "checkout") {
      const path = join(f.root, "checkout", "caller-evidence");
      await writeFile(path, await readFile(claim.file));
      claim.file = path;
    }
    await revisePolicy(f, (policy) => {
      if (!Array.isArray(policy.registrations)) throw new Error("invalidfixture");
      object(object(policy.registrations[0]).reviewerRecovery).callerCurrent = claim;
    });
    await f.start();
    if (mode === "checkout")
      expect(f.warn).toHaveBeenCalledWith(
        expect.stringContaining("continuation-policy-in-checkout"),
      );
    else
      expect((await f.readState()).reason).toBe(
        mode === "current"
          ? "reviewer-caller-current-source-unavailable"
          : "reviewer-caller-claim-mismatch",
      );
    expect(f.deps.restore).not.toHaveBeenCalled();
    expect(f.send.mock.calls.some((call) => call[0] === "browser-session")).toBe(false);
  },
);
test("live BLOCKED fixture requests named diagnosis once and cannot spend attempts or replace code approval", async () => {
  const f = await setup(recoveryBounds());
  const path = join(f.receiptDir, "browser.json");
  const receipt = await readReviewReceipt(path);
  await writeFile(
    path,
    JSON.stringify({
      ...receipt,
      status: "BLOCKED",
      reason: "owned queue/cancel fixture unavailable",
    }),
  );
  const code = await readFile(join(f.receiptDir, "code.json"), "utf8");
  const controller = await f.start();
  expect((await f.readState()).reason).toBe("reviewer-fixture-challenge-source-unavailable");
  expect(
    f.send.mock.calls.filter((call) => String(call).includes("QAENVIRONMENTOWNER")),
  ).toHaveLength(1);
  expect(f.deps.restore).not.toHaveBeenCalled();
  await controller.stop();
  controllers.splice(controllers.indexOf(controller), 1);
  await f.start();
  expect(
    f.send.mock.calls.filter((call) => String(call).includes("QAENVIRONMENTOWNER")),
  ).toHaveLength(1);
  expect(await readFile(join(f.receiptDir, "code.json"), "utf8")).toBe(code);
});
test("provider monthly cap blocks before QA diagnosis or restore", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  f.deps.view.mockImplementation(async (id) => {
    const session = f.sessions.get(id);
    if (!session) throw new Error("missingfixture");
    return {
      ...session,
      lifecycle: { instanceId: "fixture", revision: 0, operation: null },
      runtimeAlive: true,
      workspaceExists: true,
      state: "rate_limited",
      lastActivityAt: session.updatedAt,
      artifacts: [],
      services: [],
      sidecars: [],
    };
  });
  await f.start();
  expect((await f.readState()).reason).toBe("reviewer-rate-or-budget-limited");
  expect(f.deps.restore).not.toHaveBeenCalled();
  expect(f.send.mock.calls.some((call) => String(call).includes("QAENVIRONMENTOWNER"))).toBe(false);
});
test.each(["claimed", "self", "unchanged", "stale"])(
  "fixture %s evidence cannot mint independent challenge authority",
  async (mode) => {
    const f = await setup(recoveryBounds());
    const browser = f.sessions.get("browser-session");
    if (!browser) throw new Error("missingbrowser");
    const receiptPath = join(f.receiptDir, "browser.json");
    const receipt = await readReviewReceipt(receiptPath);
    await writeFile(receiptPath, JSON.stringify({ ...receipt, status: "BLOCKED" }));
    const identity = captureReleaseTaskIdentity(browser);
    const before = await f.pin("before", "missing working fixture");
    const after = await f.pin(
      "after",
      mode === "unchanged" ? "missing working fixture" : "claimed repair",
    );
    const challenge = await f.pin("challenge", { accepted: true, actor: "claimed-challenger" });
    const evidence = await f.pin("fixture-claim", {
      kind: "owned-review-fixture",
      owner: "owner-session",
      repository: "owner/repo",
      pr: 4,
      lane: "browser",
      session: browser.id,
      H,
      B,
      generation: 1,
      taskDigest: identity.taskDigest,
      launchDigest: mode === "stale" ? "f".repeat(64) : identity.launchDigest,
      previousPrerequisite: before,
      changedPrerequisite: after,
      challenge,
    });
    await revisePolicy(f, (policy) => {
      if (!Array.isArray(policy.registrations)) throw new Error("invalidfixture");
      const repair = object(
        object(object(policy.registrations[0]).reviewerRecovery).environmentRepair,
      );
      repair.evidence = evidence;
      repair.challenger = mode === "self" ? browser.id : "independent-session";
    });
    await f.start();
    const expected =
      mode === "stale"
        ? "reviewer-repair-claim-mismatch"
        : mode === "claimed"
          ? "reviewer-fixture-challenge-source-unavailable"
          : "reviewer-repair-claim-invalid";
    expect((await f.readState()).reason).toBe(expected);
    expect(f.deps.restore).not.toHaveBeenCalled();
    expect(f.send.mock.calls.some((call) => call[0] === "browser-session")).toBe(false);
  },
);
test("unknown current-launch acknowledgement cannot be replaced by old healthy native history", async () => {
  const f = await setup(recoveryBounds());
  await rm(join(f.receiptDir, "browser.json"));
  f.deps.reviewerEvidence.mockResolvedValue({
    nativeAgentAlive: true,
    historyAvailable: true,
    initialAcknowledged: null,
  });
  await f.start();
  expect((await f.readState()).reason).toBe("reviewer-current-launch-ack-unavailable");
  expect(f.deps.restore).not.toHaveBeenCalled();
  expect(f.send.mock.calls.some((call) => call[0] === "browser-session")).toBe(false);
});
test("startup recovers existing approvals once and restart does not resend", async () => {
  const f = await setup(),
    controller = await f.start();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
  expect((await f.readState()).reason).toBe("lane-affirmation-pending");
  await controller.stop();
  controllers.splice(controllers.indexOf(controller), 1);
  await f.start();
  await vi.waitFor(() => expect(f.warn).not.toHaveBeenCalled());
  expect(f.send).toHaveBeenCalledTimes(3);
});

test.each([true, false])(
  "postmerge read failure retains only completed owner authority (both lanes=%s)",
  async (bothAccepted) => {
    const f = await setup();
    const controller = await f.start();
    await controller.stop();
    controllers.splice(controllers.indexOf(controller), 1);
    const path = join(f.config.dataDir, "release-continuation", "sandbox", "4.json");
    const state = await f.readState();
    // Model the durable boundary after accepted owner gating, before its merge read.
    const persisted = object(state);
    persisted.reason = "owner-gated-continuation";
    object(object(persisted.affirmations).code).accepted = true;
    object(object(persisted.affirmations).browser).accepted = bothAccepted;
    await writeFile(path, JSON.stringify(persisted));
    fixture.merged = true;
    f.deps.transport.mockRejectedValueOnce(new Error("private upstream detail"));
    f.deps.transport.mockImplementation(async () =>
      Response.json({ parents: [{ sha: B }], commit: { tree: { sha: H } } }),
    );
    const failed = await f.start();
    const afterFailure = await f.readState();
    expect(afterFailure.reason).toBe(
      bothAccepted ? "owner-gated-continuation" : "blocked:continuation-external-merge-unverified",
    );
    expect(afterFailure.outcomes).toContain(
      bothAccepted ? "blocked:gate-network" : "blocked:continuation-external-merge-unverified",
    );
    expect(f.warn.mock.calls.flat().join(" ")).not.toContain("private upstream detail");
    await failed.stop();
    controllers.splice(controllers.indexOf(failed), 1);
    await f.start();
    expect((await f.readState()).reason).toBe(
      bothAccepted
        ? "published-deployment-pending"
        : "blocked:continuation-external-merge-unverified",
    );
  },
);

test.each(["stopped", "paused", "independent"])(
  "unavailable QA diagnosis preserves authorized owner lifecycle (%s)",
  async (mode) => {
    const bounds = recoveryBounds();
    if (mode === "independent") bounds.environmentRepair.owner = "code-session";
    const f = await setup(bounds);
    await rm(join(f.receiptDir, "browser.json"));
    await revisePolicy(f, (policy) => {
      object((policy.registrations as unknown[])[0]).restore = true;
    });
    const owner = f.sessions.get("owner-session");
    const qa = f.sessions.get(bounds.environmentRepair.owner);
    if (!owner || !qa) throw new Error("missing fixture owner");
    owner.status = mode === "paused" ? "paused" : "stopped";
    qa.status = mode === "paused" ? "paused" : "stopped";
    f.deps.reviewerEvidence.mockResolvedValue({
      nativeAgentAlive: false,
      historyAvailable: false,
      initialAcknowledged: null,
    });
    f.deps.restore.mockImplementation(async () => {
      owner.status = "running";
      owner.agentLaunchId = "restored-owner-launch";
    });
    const controller = await f.start();
    expect(f.deps.restore).toHaveBeenCalledTimes(mode === "paused" ? 0 : 1);
    expect(f.send.mock.calls.some(([, message]) => message.startsWith("QAENVIRONMENTOWNER="))).toBe(
      false,
    );
    const files = await readdir(join(f.config.dataDir, "release-continuation", "sandbox"));
    const recoveryFile = files.find((file) => file.startsWith("reviewer-"));
    if (!recoveryFile) throw new Error("missing recovery");
    expect(
      await readFile(
        join(f.config.dataDir, "release-continuation", "sandbox", recoveryFile),
        "utf8",
      ),
    ).toContain("QA diagnosis deferred: designated recipient unavailable");
    await controller.stop();
    controllers.splice(controllers.indexOf(controller), 1);
    const restarted = await f.start();
    expect(f.deps.restore).toHaveBeenCalledTimes(mode === "paused" ? 0 : 1);
    const qaSends = f.send.mock.calls.filter(([, message]) =>
      message.startsWith("QAENVIRONMENTOWNER="),
    );
    expect(qaSends).toHaveLength(mode === "stopped" ? 1 : 0);
    await restarted.stop();
    controllers.splice(controllers.indexOf(restarted), 1);
    await f.start();
    expect(
      f.send.mock.calls.filter(([, message]) => message.startsWith("QAENVIRONMENTOWNER=")),
    ).toHaveLength(mode === "stopped" ? 1 : 0);
    expect(f.deps.restore).toHaveBeenCalledTimes(mode === "paused" ? 0 : 1);
  },
);

test("external merge without completed current owner gate is never publication proof", async () => {
  const f = await setup();
  await f.start();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
  fixture.merged = true;
  f.bus.emit({
    name: "github:merged",
    occurrenceId: "external",
    projectId: "sandbox",
    sourceId: "github",
  });
  await vi.waitFor(() =>
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("external-merge-unverified")),
  );
  expect((await f.readState()).reason).toBe("blocked:continuation-external-merge-unverified");
  expect((await f.readState()).outcomes).toContain(
    "blocked:continuation-external-merge-unverified",
  );
});
test("launch spoof, consumed affirmation and post-affirm BLOCKED under held lock", async () => {
  const f = await setup(),
    controller = await f.start();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
  const state = await f.readState();
  const request = {
    repo: "owner/repo",
    pr: 4,
    lane: "code",
    session: "code-session",
    attempt: "attempt",
    H,
    B,
    contractDigest: f.receipt.contractDigest,
    receipt: join(f.receiptDir, "code.json"),
    invocation: state.invocation,
    appId: 10,
    receiptDigest: digest(f.receipt),
    id: "affirm",
    challenge: state.affirmations.code.challenge,
    status: "APPROVED",
  };
  await expect(controller.ingress(request, "browser-session-capability", true)).rejects.toThrow(
    "launch-mismatch",
  );
  await controller.ingress(request, "code-session-capability", true);
  expect((await f.readState()).affirmations.code.accepted).toBe(true);
  await expect(controller.ingress(request, "code-session-capability", true)).rejects.toThrow(
    "challenge-invalid",
  );
  const release = await lockReviewReceipt(request.receipt);
  try {
    await controller.ingress(
      { ...request, id: "block", status: "BLOCKED", challenge: null },
      "code-session-capability",
      false,
    );
    expect(await unresolvedReviewTransitions(request.receipt)).toBe(true);
    expect((await f.readState()).reason).toBe("review-transition-pending");
  } finally {
    await release();
  }
});
test.each(["ci-not-success", "native-approval-missing", "unresolved-threads", "consent-missing"])(
  "blocked %s sends owner repair work only",
  async (reason) => {
    fixture.reason = reason;
    const f = await setup();
    await f.start();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect((await f.readState()).reason).toBe(reason);
    expect(f.send.mock.calls[0]).toBeDefined();
  },
);

test.each(["same-voter", "missing-ci", "failed-ci", "skipped-ci", "pending-ci"])(
  "actual public gate %s blocks owner action",
  async (reason) => {
    fixture.reason = reason;
    const f = await setup();
    await f.start();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect((await f.readState()).reason).not.toBe("lane-affirmation-pending");
    expect((await f.readState()).reason).not.toBe("owner-gated-continuation");
  },
);

test.each(["PENDING", "BLOCKED", "stale-head", "stale-base", "wrong-session", "missing"])(
  "caller receipt %s cannot request affirmation",
  async (mode) => {
    const f = await setup();
    const path = join(f.receiptDir, "code.json");
    if (mode === "missing") await rm(path);
    else
      await writeFile(
        path,
        JSON.stringify({
          ...f.receipt,
          ...(mode === "PENDING" || mode === "BLOCKED" ? { status: mode } : {}),
          ...(mode === "stale-head" ? { H: "f".repeat(40) } : {}),
          ...(mode === "stale-base" ? { B: "f".repeat(40) } : {}),
          ...(mode === "wrong-session" ? { session: "other-session" } : {}),
        }),
      );
    await f.start();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect((await f.readState()).reason).not.toBe("lane-affirmation-pending");
  },
);

test("launch rotation invalidates prior affirmation and no caller header substitutes", async () => {
  const f = await setup(),
    controller = await f.start();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
  const state = await f.readState();
  const session = f.sessions.get("code-session");
  if (!session) throw new Error("fixture absent");
  session.agentLaunchId = "rotated-capability";
  const request = {
    repo: "owner/repo",
    pr: 4,
    lane: "code",
    session: "code-session",
    attempt: "attempt",
    H,
    B,
    contractDigest: f.receipt.contractDigest,
    receipt: join(f.receiptDir, "code.json"),
    invocation: state.invocation,
    appId: 10,
    receiptDigest: digest(f.receipt),
    id: "affirm",
    challenge: state.affirmations.code.challenge,
    status: "APPROVED",
  };
  await expect(controller.ingress(request, "code-session-capability", true)).rejects.toThrow(
    "launch-mismatch",
  );
  await expect(controller.ingress(request, "rotated-capability", true)).rejects.toThrow(
    "challenge-invalid",
  );
});
