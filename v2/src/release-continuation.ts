import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, realpath, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { EventBus } from "./event-bus.js";
import {
  GitHubApp,
  effectiveNativeReview,
  integer,
  object,
  ReviewAppError,
  string,
} from "./github-app.js";
import { parseConfig, parseAttempt, type Config } from "./review-app.js";
import {
  evaluateSnapshot,
  GateGitHub,
  parseGatePolicy,
  readGateSnapshot,
  type GatePolicy,
  type GateSnapshot,
} from "./review-gate.js";
import { digest } from "./review-interface.js";
import { isStateBody, readStateBody } from "./review-state.js";
import {
  admitReviewTransition,
  atomicReceiptWrite,
  canonicalReceipt,
  expandReceiptPath,
  lockReviewReceipt,
  readReviewReceipt,
  receiptHash,
  receiptIdentifier,
  unresolvedReviewTransitions,
  type ReviewAttempt,
  type ReviewLane,
  type ReviewReceipt,
  type ReviewTransitionIntent,
} from "./review-receipt.js";
import {
  claimContinuation,
  parseContinuationRecord,
  saveContinuationRecord,
  readReviewerRecovery,
  type ContinuationAction,
  type ContinuationFence,
  type ContinuationRecord,
} from "./release-continuation-state.js";
import {
  continueReleasePost,
  parseReleasePostPolicy,
  type VerifiedRelease,
} from "./release-post.js";
import {
  captureReleaseTaskIdentity,
  type ReleaseCompletionGuard,
  type ReleaseCompletionResult,
} from "./session-service.js";
import type { AppConfig, SessionRecord, SessionView } from "./types.js";
import {
  callerSourceMatches,
  parseCallerSourceSnapshot,
  type CallerPin,
  type CallerReadback,
  type CallerSourceSnapshot,
  type ConfiguredCallerBootstrap,
} from "./release-caller.js";

export interface ReleaseContinuationConfig {
  policyFile: string;
  policyDigest: string;
  intervalSeconds: number;
}
interface Pin {
  file: string;
  digest: string;
}
interface Registration {
  pr: number;
  generation: number;
  active: boolean;
  scopeDigest: string;
  owner: string;
  successor: string | null;
  restore: boolean;
  code: string;
  browser: string;
  deployment: Pin | null;
  reviewerRecovery: {
    maxAttempts: number;
    cooldownSeconds: number;
    taskDigests: Record<ReviewLane, string>;
    callerCurrent: Pin | null;
    environmentRepair: { owner: string; challenger: string | null; evidence: Pin | null } | null;
  } | null;
}
interface ContinuationPolicy {
  gate: Pin;
  apps: Pin;
  contract: Pin;
  protocol: Pin;
  tool: Pin;
  tokenFile: string;
  activation: Pin | null;
  postRelease: Pin | null;
  registrations: Registration[];
}
interface LoadedPolicy {
  policy: ContinuationPolicy;
  gate: GatePolicy;
  apps: Config;
  token: string;
  checkouts: string[];
}
interface Dependencies {
  config: AppConfig;
  bus: EventBus;
  session(id: string): SessionRecord | null;
  view(id: string): Promise<SessionView>;
  send(id: string, message: string): Promise<unknown>;
  restore(id: string): Promise<unknown>;
  complete(id: string, guard: ReleaseCompletionGuard): Promise<ReleaseCompletionResult>;
  reviewerEvidence(id: string): Promise<{
    nativeAgentAlive: boolean | null;
    historyAvailable: boolean;
    initialAcknowledged: boolean | null;
    configuredCaller?: ConfiguredCallerBootstrap;
  }>;
  callerReadback?: (
    snapshot: CallerSourceSnapshot,
    tool: CallerPin,
    apps: CallerPin,
    repository: string,
    verify: (pin: CallerPin) => Promise<unknown>,
  ) => Promise<CallerReadback>;
  warn(message: string): void;
  transport?: typeof fetch;
}
export interface ContinuationIngress extends ReviewAttempt {
  invocation: string;
  appId: number;
  receiptDigest: string;
  id: string;
  challenge: string | null;
  status: "APPROVED" | "PENDING" | "BLOCKED";
}
export function parseContinuationIngress(value: unknown): ContinuationIngress {
  const row = object(value);
  if (row.status !== "APPROVED" && row.status !== "PENDING" && row.status !== "BLOCKED")
    throw new ReviewAppError("continuation-request-invalid");
  return {
    ...parseAttempt(value),
    invocation: receiptHash(row.invocation, 64),
    appId: integer(row.appId),
    receiptDigest: receiptHash(row.receiptDigest, 64),
    id: receiptIdentifier(row.id),
    challenge: row.challenge === null ? null : string(row.challenge),
    status: row.status,
  };
}
function pin(value: unknown): Pin {
  const row = object(value);
  return { file: string(row.file), digest: receiptHash(row.digest, 64) };
}
function parsePolicy(value: unknown): ContinuationPolicy {
  const row = object(value);
  if (!Array.isArray(row.registrations)) throw new ReviewAppError("continuation-policy-invalid");
  const registrations = row.registrations.map((value: unknown): Registration => {
    const item = object(value);
    if (typeof item.active !== "boolean" || typeof item.restore !== "boolean")
      throw new ReviewAppError("continuation-policy-invalid");
    const result = {
      pr: integer(item.pr),
      generation: integer(item.generation),
      active: item.active,
      scopeDigest: receiptHash(item.scopeDigest, 64),
      owner: receiptIdentifier(item.owner),
      successor: item.successor === null ? null : receiptIdentifier(item.successor),
      restore: item.restore,
      code: receiptIdentifier(item.code),
      browser: receiptIdentifier(item.browser),
      deployment: item.deployment === null ? null : pin(item.deployment),
      reviewerRecovery:
        item.reviewerRecovery === undefined || item.reviewerRecovery === null
          ? null
          : (() => {
              const recovery = object(item.reviewerRecovery),
                maxAttempts = integer(recovery.maxAttempts),
                cooldownSeconds = integer(recovery.cooldownSeconds);
              if (maxAttempts > 3 || cooldownSeconds < 60)
                throw new ReviewAppError("reviewer-recovery-bounds-invalid");
              const tasks = object(recovery.taskDigests),
                repair =
                  recovery.environmentRepair === undefined || recovery.environmentRepair === null
                    ? null
                    : object(recovery.environmentRepair);
              return {
                maxAttempts,
                cooldownSeconds,
                taskDigests: {
                  code: receiptHash(tasks.code, 64),
                  browser: receiptHash(tasks.browser, 64),
                },
                callerCurrent:
                  recovery.callerCurrent === undefined || recovery.callerCurrent === null
                    ? null
                    : pin(recovery.callerCurrent),
                environmentRepair: repair
                  ? {
                      owner: receiptIdentifier(repair.owner),
                      challenger:
                        repair.challenger === undefined || repair.challenger === null
                          ? null
                          : receiptIdentifier(repair.challenger),
                      evidence: repair.evidence === null ? null : pin(repair.evidence),
                    }
                  : null,
              };
            })(),
    };
    if (
      result.code === result.browser ||
      [result.code, result.browser].includes(result.owner) ||
      (result.successor && [result.code, result.browser].includes(result.successor))
    )
      throw new ReviewAppError("continuation-designations-invalid");
    return result;
  });
  if (new Set(registrations.map((item) => item.pr)).size !== registrations.length)
    throw new ReviewAppError("continuation-policy-invalid");
  return {
    gate: pin(row.gate),
    apps: pin(row.apps),
    contract: pin(row.contract),
    protocol: pin(row.protocol),
    tool: pin(row.tool),
    tokenFile: string(row.tokenFile),
    activation: row.activation === null ? null : pin(row.activation),
    postRelease:
      row.postRelease === undefined || row.postRelease === null ? null : pin(row.postRelease),
    registrations,
  };
}
async function privateFile(path: string, checkouts: string[]): Promise<string> {
  const canonical = await realpath(expandReceiptPath(path));
  for (const checkout of checkouts) {
    let root: string;
    try {
      root = await realpath(checkout);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
      root = resolve(checkout);
    }
    const rel = relative(root, canonical);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
      throw new ReviewAppError("continuation-policy-in-checkout");
  }
  return canonical;
}
async function pinnedBytes(binding: Pin, checkouts: string[]): Promise<string> {
  const bytes = await readFile(await privateFile(binding.file, checkouts));
  // Pins bind bytes, not parsed JSON or normalized whitespace.
  if (createHash("sha256").update(bytes).digest("hex") !== binding.digest)
    throw new ReviewAppError("continuation-pin-changed");
  return bytes.toString("utf8");
}
function parseJson(bytes: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new ReviewAppError("continuation-json-invalid");
  }
}
async function loadPolicy(
  binding: ReleaseContinuationConfig,
  checkouts: string[],
): Promise<LoadedPolicy> {
  const policy = parsePolicy(
    parseJson(
      await pinnedBytes({ file: binding.policyFile, digest: binding.policyDigest }, checkouts),
    ),
  );
  const gate = parseGatePolicy(parseJson(await pinnedBytes(policy.gate, checkouts)));
  const apps = parseConfig(parseJson(await pinnedBytes(policy.apps, checkouts)));
  await pinnedBytes(policy.contract, checkouts);
  await pinnedBytes(policy.protocol, checkouts);
  await pinnedBytes(policy.tool, checkouts);
  const token = (await readFile(await privateFile(policy.tokenFile, checkouts), "utf8")).trim();
  if (!token || !apps.repositories.includes(gate.repository))
    throw new ReviewAppError("continuation-policy-invalid");
  return { policy, gate, apps, token, checkouts };
}
function sameCapability(actual: string | undefined, claimed: string): boolean {
  if (!actual || !claimed) return false;
  const left = Buffer.from(actual),
    right = Buffer.from(claimed);
  return left.length === right.length && timingSafeEqual(left, right);
}
function attemptFrom(receipt: ReviewReceipt, path: string): ReviewAttempt {
  return {
    repo: receipt.repository,
    pr: receipt.PR,
    lane: receipt.lane,
    session: receipt.session,
    attempt: receipt.attempt,
    H: receipt.H,
    B: receipt.B,
    contractDigest: receipt.contractDigest,
    receipt: path,
  };
}
function validatesReceipt(
  receipt: ReviewReceipt,
  lane: ReviewLane,
  registration: Registration,
  loaded: LoadedPolicy,
  H: string,
  B: string,
  snapshot: GateSnapshot,
): boolean {
  const review = effectiveNativeReview(snapshot.reviews, {
    id: lane === "code" ? loaded.gate.codeActor : loaded.gate.browserActor,
  });
  const actor = lane === "code" ? loaded.gate.codeActor : loaded.gate.browserActor;
  const latest = snapshot.comments
    .filter(
      (row) =>
        object(row.user).id === actor && typeof row.body === "string" && isStateBody(row.body),
    )
    .sort((a, b) => integer(b.id) - integer(a.id))[0];
  const state = latest ? readStateBody(string(latest.body)) : null;
  return (
    state?.session === receipt.session &&
    state.attempt === receipt.attempt &&
    state.evidenceDigest === digest({ rows: receipt.evidence, coverage: receipt.coverage }) &&
    receipt.repository === loaded.gate.repository &&
    receipt.PR === registration.pr &&
    receipt.lane === lane &&
    receipt.session === registration[lane] &&
    receipt.H === H &&
    receipt.B === B &&
    receipt.contractDigest === loaded.policy.contract.digest &&
    receipt.appId === loaded.apps[lane].appId &&
    receipt.status === "APPROVED" &&
    !receipt.reviewBlocked &&
    receipt.reviewId === review?.id &&
    review.commit_id === H &&
    review.state === "APPROVED"
  );
}
function actionObserved(record: SessionRecord, action: ContinuationAction): boolean {
  if (action.kind === "restore")
    return (
      record.status === "running" &&
      Boolean(record.agentLaunchId) &&
      digest(record.agentLaunchId) !== action.launch
    );
  return (
    record.queuedMessages?.messages.includes(action.message) === true ||
    record.queuedMessageTyped?.message === action.message ||
    record.submitFailedMessage?.message === action.message
  );
}

class ProjectContinuation {
  private stopped = false;
  private sweepQueued = false;
  private publicBackoffUntil = 0;
  private serial: Promise<void> = Promise.resolve();
  private fence: ContinuationFence | null = null;
  private readonly postFences = new Map<string, ContinuationFence>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly root: string;
  constructor(
    private readonly projectId: string,
    private readonly binding: ReleaseContinuationConfig,
    private readonly deps: Dependencies,
  ) {
    this.root = join(deps.config.dataDir, "release-continuation", projectId);
  }
  async start(): Promise<void> {
    this.fence = await claimContinuation(join(this.root, "owners"));
    this.unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.projectId === this.projectId) this.wake();
    });
    this.timer = setInterval(() => this.wake(), this.binding.intervalSeconds * 1000);
    this.wake();
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => undefined);
    return next;
  }
  wake(): void {
    if (this.stopped || this.sweepQueued) return;
    this.sweepQueued = true;
    void this.enqueue(async () => {
      try {
        if (!this.stopped) await this.sweep();
      } finally {
        this.sweepQueued = false;
      }
    }).catch((error: unknown) =>
      this.deps.warn(
        `release-continuation:${this.projectId}:${error instanceof ReviewAppError ? error.category : "blocked"}`,
      ),
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.serial;
    for (const fence of this.postFences.values()) await fence.retire();
    this.postFences.clear();
    await this.fence?.retire();
    this.fence = null;
  }
  async settled(): Promise<void> {
    await this.serial;
  }
  private checkouts(): string[] {
    return Object.values(this.deps.config.projects).map((project) => project.path);
  }
  private async loaded(): Promise<LoadedPolicy> {
    const loaded = await loadPolicy(this.binding, this.checkouts());
    const roots = [...this.checkouts()];
    for (const registration of loaded.policy.registrations)
      for (const id of [
        registration.owner,
        registration.successor,
        registration.code,
        registration.browser,
      ]) {
        const session = id ? this.deps.session(id) : null;
        if (session) roots.push(session.worktreePath);
      }
    // Every pin remains caller-owned, including review worktrees outside the project root.
    const validated = await loadPolicy(this.binding, roots);
    await privateFile(validated.apps.receiptRoot, roots);
    for (const lane of ["code", "browser"] as const)
      await privateFile(validated.apps[lane].keyPath, roots);
    return validated;
  }
  private async callerSnapshot(
    loaded: LoadedPolicy,
    registration: Registration,
  ): Promise<{
    snapshot: CallerSourceSnapshot;
    digest: string;
  } | null> {
    const claim = registration.reviewerRecovery?.callerCurrent;
    if (!claim) return null;
    const envelope = object(parseJson(await pinnedBytes(claim, loaded.checkouts)));
    if (envelope.source === undefined) return null;
    const source = pin(envelope.source);
    const value = object(parseJson(await pinnedBytes(source, loaded.checkouts)));
    if (value.kind !== "configured-source") return null;
    const snapshot = parseCallerSourceSnapshot(value);
    if (
      snapshot.generation !== registration.generation ||
      !callerSourceMatches(this.deps.config, snapshot)
    )
      return null;
    await pinnedBytes(snapshot.config, loaded.checkouts);
    return { snapshot, digest: source.digest };
  }
  async designates(request: ContinuationIngress): Promise<boolean> {
    const loaded = await this.loaded();
    return (
      loaded.gate.repository === request.repo &&
      loaded.policy.registrations.some(
        (item) => item.active && item.pr === request.pr && item[request.lane] === request.session,
      )
    );
  }
  private statePath(pr: number): string {
    return join(this.root, `${pr}.json`);
  }
  private async previous(pr: number): Promise<ContinuationRecord | null> {
    try {
      return parseContinuationRecord(parseJson(await readFile(this.statePath(pr), "utf8")));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  private async save(
    pr: number,
    record: ContinuationRecord,
    outcome = record.reason,
  ): Promise<void> {
    if (!this.fence || this.stopped) throw new ReviewAppError("continuation-fenced");
    const outcomes = record.outcomes ?? [];
    if (outcomes.at(-1) !== outcome) outcomes.push(outcome);
    record.outcomes = outcomes.slice(-16);
    await saveContinuationRecord(this.statePath(pr), record, this.fence);
  }
  private async deliver(
    pr: number,
    record: ContinuationRecord,
    key: string,
    id: string,
    message: string,
  ): Promise<void> {
    return this.dispatch(record.actions, key, id, message, () => this.save(pr, record));
  }
  private async dispatch(
    actions: ContinuationAction[],
    key: string,
    id: string,
    message: string,
    save: () => Promise<void>,
  ): Promise<void> {
    const session = this.deps.session(id);
    if (!session?.agentLaunchId || session.status !== "running")
      throw new ReviewAppError("continuation-owner-unavailable");
    const existing = actions.find((action) => action.key === key);
    if (existing) {
      if (existing.state === "confirmed") return;
      if (existing.session === id && actionObserved(session, existing)) {
        existing.state = "confirmed";
        await save();
        return;
      }
      throw new ReviewAppError("continuation-delivery-uncertain");
    }
    const action: ContinuationAction = {
      kind: "send",
      key,
      session: id,
      message,
      state: "intent",
      launch: digest(session.agentLaunchId),
    };
    actions.push(action);
    await save();
    await this.fence?.assertCurrent();
    await this.deps.send(id, message);
    action.state = "confirmed";
    await save();
  }
  private async recoverReviewer(
    loaded: LoadedPolicy,
    registration: Registration,
    lane: ReviewLane,
    H: string,
    B: string,
    snapshot: GateSnapshot,
  ): Promise<string | null> {
    const bounds = registration.reviewerRecovery;
    if (!bounds) return null;
    let blocked: ReviewReceipt | null = null;
    let currentAttempt: string | null = null;
    const receiptPath = join(
      expandReceiptPath(loaded.apps.receiptRoot),
      loaded.gate.repository.toLowerCase(),
      String(registration.pr),
      `${lane}.json`,
    );
    try {
      const receipt = await readReviewReceipt(receiptPath);
      if (
        receipt.repository === loaded.gate.repository &&
        receipt.PR === registration.pr &&
        receipt.session === registration[lane] &&
        receipt.lane === lane &&
        receipt.H === H &&
        receipt.B === B &&
        receipt.contractDigest === loaded.policy.contract.digest &&
        receipt.appId === loaded.apps[lane].appId
      )
        currentAttempt = receipt.attempt;
      if (
        receipt.status === "BLOCKED" &&
        receipt.repository === loaded.gate.repository &&
        receipt.PR === registration.pr &&
        receipt.session === registration[lane] &&
        receipt.lane === lane &&
        receipt.H === H &&
        receipt.B === B &&
        receipt.contractDigest === loaded.policy.contract.digest
      )
        blocked = receipt;
      if (
        validatesReceipt(receipt, lane, registration, loaded, H, B, snapshot) &&
        !(await unresolvedReviewTransitions(receiptPath))
      )
        return null;
    } catch {
      /* Unreadable required evidence stays blocked by the gate; recovery never supplies approval. */
    }
    const session = this.deps.session(registration[lane]);
    if (!session?.agentLaunchId) return "reviewer-generation-unavailable";
    const identity = captureReleaseTaskIdentity(session);
    if (
      identity.repository?.toLowerCase() !== loaded.gate.repository.toLowerCase() ||
      identity.pr !== registration.pr ||
      identity.taskDigest !== bounds.taskDigests[lane]
    )
      return "reviewer-task-mismatch";
    if (
      session.status === "paused" ||
      session.stopReason ||
      session.status === "budget_limited" ||
      session.status === "completed" ||
      session.status === "killed"
    )
      return "reviewer-recovery-not-authorized";
    const key = digest({
      repository: loaded.gate.repository.toLowerCase(),
      pr: registration.pr,
      H,
      B,
      lane,
      generation: registration.generation,
      session: session.id,
      task: identity.taskDigest,
    });
    const path = join(this.root, `reviewer-${key}.json`);
    const prior = await readReviewerRecovery(path, key);
    const recovery = prior ?? {
      key,
      attempts: 0,
      attemptedAt: 0,
      launch: identity.launchDigest ?? "unknown",
      state: "blocked" as const,
      reason: "",
      source: "",
      actions: [],
      prerequisite: null,
    };
    const save = async () => {
      if (!this.fence || this.stopped) throw new ReviewAppError("continuation-fenced");
      await this.fence.assertCurrent();
      await atomicReceiptWrite(path, recovery);
    };
    const view = await this.deps.view(session.id);
    if (view.state === "rate_limited") return "reviewer-rate-or-budget-limited";
    const native = await this.deps.reviewerEvidence(session.id);
    if (native.nativeAgentAlive === null) return "reviewer-native-evidence-unknown";
    if (recovery.state === "intent") {
      if (recovery.launch === identity.launchDigest) return "reviewer-restore-uncertain";
      recovery.state = "confirmed";
      recovery.launch = identity.launchDigest ?? "unknown";
      recovery.reason = "restored-generation";
      await save();
    }
    const hold = async (reason: string, source: string): Promise<string> => {
      recovery.reason = reason;
      recovery.source = source;
      recovery.state = "blocked";
      await save();
      return reason;
    };
    const matchesClaim = (value: unknown): boolean => {
      const claim = object(value);
      return (
        claim.repository === loaded.gate.repository &&
        claim.pr === registration.pr &&
        claim.session === session.id &&
        claim.lane === lane &&
        claim.H === H &&
        claim.B === B &&
        claim.generation === registration.generation &&
        claim.taskDigest === identity.taskDigest &&
        claim.launchDigest === identity.launchDigest
      );
    };
    const source = await this.callerSnapshot(loaded, registration);
    const bootstrap = native.configuredCaller;
    const authenticated =
      source !== null &&
      bootstrap !== undefined &&
      isDeepStrictEqual(bootstrap.config, source.snapshot.config) &&
      bootstrap.projectId === source.snapshot.projectId &&
      bootstrap.sourceId === source.snapshot.sourceId &&
      bootstrap.triggerId === source.snapshot.triggerId &&
      bootstrap.effectiveDigest === source.snapshot.effectiveDigest &&
      bootstrap.blockIndex === source.snapshot.blocks[lane] &&
      bootstrap.repository === loaded.gate.repository &&
      bootstrap.pr === registration.pr &&
      bootstrap.promptDigest === createHash("sha256").update(session.prompt).digest("hex");
    if (bounds.callerCurrent && !authenticated) {
      const claim = object(parseJson(await pinnedBytes(bounds.callerCurrent, loaded.checkouts)));
      if (
        !matchesClaim(claim) ||
        typeof claim.version !== "string" ||
        !claim.version ||
        claim.toolDigest !== loaded.policy.tool.digest ||
        claim.contractDigest !== loaded.policy.contract.digest ||
        claim.protocolDigest !== loaded.policy.protocol.digest
      )
        return hold(
          "reviewer-caller-claim-mismatch",
          "caller claim is not current task/launch evidence",
        );
      await pinnedBytes(pin(claim.source), loaded.checkouts);
    }
    const repair = bounds.environmentRepair;
    if (repair?.evidence) {
      const claim = object(parseJson(await pinnedBytes(repair.evidence, loaded.checkouts)));
      if (
        claim.kind !== undefined &&
        claim.kind !== "owned-workspace-trust" &&
        claim.kind !== "owned-review-fixture"
      )
        return hold("reviewer-repair-claim-invalid", "unsupported claimed repair kind");
      if (claim.kind !== undefined && (!matchesClaim(claim) || claim.owner !== repair.owner))
        return hold(
          "reviewer-repair-claim-mismatch",
          "repair claim is not current task/launch evidence",
        );
      if (claim.kind === "owned-review-fixture") {
        const before = pin(claim.previousPrerequisite),
          after = pin(claim.changedPrerequisite);
        await pinnedBytes(before, loaded.checkouts);
        await pinnedBytes(after, loaded.checkouts);
        await pinnedBytes(pin(claim.challenge), loaded.checkouts);
        if (
          before.digest === after.digest ||
          !repair.challenger ||
          [repair.owner, session.id, registration.owner].includes(repair.challenger)
        )
          return hold(
            "reviewer-repair-claim-invalid",
            "unchanged prerequisite or nonindependent challenger",
          );
      }
    }
    if (blocked || (!native.historyAvailable && !native.initialAcknowledged)) {
      const reason = "reviewer-fixture-challenge-source-unavailable";
      await hold(reason, "authenticated owner repair and independent challenge producers absent");
      if (repair) {
        const recipient = this.deps.session(repair.owner);
        if (!recipient?.agentLaunchId || recipient.status !== "running")
          return hold(reason, "QA diagnosis deferred: designated recipient unavailable");
        await this.dispatch(
          recovery.actions,
          `qa:${key}:source-unavailable`,
          repair.owner,
          `QAENVIRONMENTOWNER=${repair.owner}: diagnose only owned ${lane} fixture for ${loaded.gate.repository}#${registration.pr} H=${H} B=${B}. ${blocked ? `Current BLOCKED attempt=${blocked.attempt}; reason=${blocked.reason}.` : "Current native history/acknowledgement is unavailable."} Workspace trust or shell/process health does not prove queue/cancel fixture readiness. Authenticated owner repair, independent challenge, changed prerequisite and current-launch acceptance producers are unavailable. Preserve current code App approval; do not rerun, restore, request protected consent or repair pilot source.`,
          save,
        );
      }
      return reason;
    }
    if (native.initialAcknowledged !== true)
      return hold(
        "reviewer-current-launch-ack-unavailable",
        "retained native identity/history cannot prove current acceptance",
      );
    if (authenticated && currentAttempt && this.deps.callerReadback) {
      const prerequisite = digest({
        key,
        launch: identity.launchDigest,
        source: source.digest,
        attempt: currentAttempt,
        tool: loaded.policy.tool.digest,
        apps: loaded.policy.apps.digest,
        contract: loaded.policy.contract.digest,
        protocol: loaded.policy.protocol.digest,
      });
      for (const binding of [source.snapshot.runtime, ...source.snapshot.modules])
        await pinnedBytes(binding, loaded.checkouts);
      if (recovery.prerequisite === prerequisite && recovery.reason === "configured-caller-current")
        return null;
      const readback = await this.deps.callerReadback(
        source.snapshot,
        loaded.policy.tool,
        loaded.policy.apps,
        loaded.gate.repository,
        (binding) => pinnedBytes(binding, loaded.checkouts),
      );
      const current = this.deps.session(session.id);
      if (!current || !isDeepStrictEqual(captureReleaseTaskIdentity(current), identity))
        return hold("reviewer-task-mismatch", "task changed during owned caller readback");
      const after = await this.deps.reviewerEvidence(session.id);
      const receipt = await readReviewReceipt(receiptPath);
      if (
        after.initialAcknowledged !== true ||
        after.nativeAgentAlive !== true ||
        !isDeepStrictEqual(after.configuredCaller, bootstrap) ||
        receipt.attempt !== currentAttempt ||
        receipt.H !== H ||
        receipt.B !== B ||
        receipt.session !== session.id ||
        receipt.lane !== lane
      )
        return hold(
          "reviewer-caller-current-source-unavailable",
          "caller inputs changed during readback",
        );
      const latestSource = await this.callerSnapshot(loaded, registration);
      if (!latestSource || latestSource.digest !== source.digest)
        return hold("reviewer-caller-current-source-unavailable", "source changed during readback");
      recovery.prerequisite = prerequisite;
      recovery.source = JSON.stringify(readback);
      recovery.reason = "configured-caller-current";
      await save();
      return null;
    }
    return hold(
      "reviewer-caller-current-source-unavailable",
      "policy.tool has no invocation/readback contract",
    );
  }
  private async sweep(): Promise<void> {
    if (Date.now() < this.publicBackoffUntil) return;
    const loaded = await this.loaded();
    const api = new GateGitHub(
      loaded.token,
      async (input, init) => {
        if (Date.now() < this.publicBackoffUntil)
          throw new ReviewAppError("continuation-rate-limited");
        const response = await (this.deps.transport ?? fetch)(input, init);
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        if (
          response.headers.get("x-ratelimit-remaining") === "0" &&
          Number.isFinite(reset) &&
          reset > 0
        )
          this.publicBackoffUntil = Math.max(this.publicBackoffUntil, reset * 1000);
        const retry = response.headers.get("retry-after");
        if (retry !== null && /^\d+$/.test(retry))
          this.publicBackoffUntil = Math.max(
            this.publicBackoffUntil,
            Date.now() + Number(retry) * 1000,
          );
        return response;
      },
      AbortSignal.timeout(45_000),
    );
    for (const registration of loaded.policy.registrations) {
      if (this.stopped) return;
      if (!registration.active) continue;
      try {
        const prior = await this.previous(registration.pr);
        if (prior?.mergeSha && prior.publishedProofDigest && loaded.policy.postRelease) {
          try {
            await this.postRelease(loaded, registration, prior, null);
          } catch (error) {
            if (
              !(error instanceof ReviewAppError) ||
              error.category !== "release-verified-journal-missing"
            )
              throw error;
            if (registration.deployment?.digest !== prior.publishedProofDigest)
              throw new ReviewAppError("continuation-deployment-pin-conflict");
            await this.postRelease(
              loaded,
              registration,
              prior,
              await this.publishedRelease(loaded, registration, prior.mergeSha),
            );
          }
          continue;
        }
        await this.observe(loaded, api, registration);
      } catch (error) {
        const category =
          error instanceof ReviewAppError ? error.category : "external-operation-failed";
        const failed = await this.previous(registration.pr);
        if (failed && failed.authorityGeneration === registration.generation) {
          const outcome = `blocked:${category}`;
          if (
            failed.reason !== "owner-gated-continuation" ||
            failed.affirmations.code?.accepted !== true ||
            failed.affirmations.browser?.accepted !== true
          )
            failed.reason = outcome;
          await this.save(registration.pr, failed, outcome);
        }
        this.deps.warn(
          `release-continuation:${this.projectId}:${registration.pr}:${error instanceof ReviewAppError ? error.category : "blocked"}`,
        );
      }
    }
  }
  private async publishedRelease(
    loaded: LoadedPolicy,
    registration: Registration,
    mergeSha: string,
  ): Promise<VerifiedRelease> {
    const binding = registration.deployment;
    if (!binding) throw new ReviewAppError("continuation-deployment-missing");
    const proof = object(parseJson(await pinnedBytes(binding, loaded.checkouts)));
    if (
      proof.repository !== loaded.gate.repository ||
      proof.mergeSha !== mergeSha ||
      proof.installedVersion !== proof.version ||
      proof.webStatus !== 200 ||
      typeof proof.gitHead !== "string" ||
      typeof proof.integrity !== "string" ||
      typeof proof.packageSha256 !== "string"
    )
      throw new ReviewAppError("continuation-deployment-invalid");
    return {
      repository: loaded.gate.repository,
      pr: registration.pr,
      mergeSha,
      version: string(proof.version),
      gitHead: receiptHash(proof.gitHead, 40),
      integrity: string(proof.integrity),
      deploymentDigest: binding.digest,
    };
  }
  private async postRelease(
    loaded: LoadedPolicy,
    registration: Registration,
    record: ContinuationRecord,
    release: VerifiedRelease | null,
  ): Promise<void> {
    const binding = loaded.policy.postRelease;
    if (!binding || !this.fence) throw new ReviewAppError("post-release-policy-missing");
    const policy = parseReleasePostPolicy(parseJson(await pinnedBytes(binding, loaded.checkouts)));
    const members = new Set(policy.members.map((member) => member.sessionId));
    const worker = policy.members.find((member) => member.role === "worker");
    if (
      policy.repository.toLowerCase() !== loaded.gate.repository.toLowerCase() ||
      policy.pr !== registration.pr ||
      policy.generation !== registration.generation ||
      !worker ||
      (worker.sessionId !== registration.owner && worker.sessionId !== registration.successor) ||
      !members.has(registration.code) ||
      !members.has(registration.browser)
    )
      throw new ReviewAppError("post-release-membership-invalid");
    const root = join(this.deps.config.dataDir, "release-continuation", "post-release"),
      task = digest({ repository: policy.repository.toLowerCase(), pr: policy.pr });
    let fence = this.postFences.get(task);
    if (!fence) {
      fence = await claimContinuation(join(root, "owners", task));
      this.postFences.set(task, fence);
    }
    const taskFence = fence,
      projectFence = this.fence;
    const outcome = await continueReleasePost(policy, binding.digest, release, {
      root,
      dataDir: this.deps.config.dataDir,
      receiptRoot: loaded.apps.receiptRoot,
      flowOutcomes: record.outcomes ?? [],
      fence: {
        ...taskFence,
        assertCurrent: async () => {
          await projectFence.assertCurrent();
          await taskFence.assertCurrent();
        },
      },
      session: this.deps.session,
      complete: this.deps.complete,
      readTargetProof: async (binding) => parseJson(await pinnedBytes(binding, loaded.checkouts)),
    });
    record.reason = outcome.reason;
    await this.save(registration.pr, record);
  }
  private async observe(
    loaded: LoadedPolicy,
    api: GateGitHub,
    registration: Registration,
  ): Promise<void> {
    const snapshot = await readGateSnapshot(api, loaded.gate, registration.pr);
    const H = receiptHash(object(snapshot.pr.head).sha, 40),
      B = receiptHash(object(snapshot.pr.base).sha, 40);
    const gate = evaluateSnapshot(loaded.gate, registration.pr, snapshot);
    let reason = gate.reason;
    let recoveryReason: string | null = null;
    if (snapshot.pr.merged !== true)
      for (const lane of ["code", "browser"] as const) {
        const recovery = await this.recoverReviewer(loaded, registration, lane, H, B, snapshot);
        if (recovery) {
          reason = recovery;
          recoveryReason = recovery;
        }
      }
    const paths = {} as Record<ReviewLane, string>;
    const receipts: Partial<Record<ReviewLane, ReviewReceipt>> = {};
    for (const lane of ["code", "browser"] as const) {
      paths[lane] = join(
        expandReceiptPath(loaded.apps.receiptRoot),
        loaded.gate.repository.toLowerCase(),
        String(registration.pr),
        `${lane}.json`,
      );
      try {
        const unlock = await lockReviewReceipt(paths[lane]);
        let receipt: ReviewReceipt;
        try {
          receipt = await readReviewReceipt(paths[lane]);
        } finally {
          await unlock();
        }
        await canonicalReceipt(loaded.apps.receiptRoot, attemptFrom(receipt, paths[lane]));
        receipts[lane] = receipt;
        if (
          reason === "all-gates-pass" &&
          !validatesReceipt(receipt, lane, registration, loaded, H, B, snapshot)
        )
          reason = "caller-receipt-not-current";
        if (await unresolvedReviewTransitions(paths[lane])) reason = "review-transition-pending";
      } catch {
        reason = "caller-receipt-unavailable";
      }
    }
    if (recoveryReason) reason = recoveryReason;
    const invocation = digest({
      repository: loaded.gate.repository,
      pr: registration.pr,
      H,
      B,
      evidence: gate,
      policy: this.binding.policyDigest,
      generation: registration.generation,
      receipts: ["code", "browser"].map((lane) => receipts[lane as ReviewLane] ?? null),
      launches: [registration.code, registration.browser].map((id) =>
        digest(this.deps.session(id)?.agentLaunchId ?? "absent"),
      ),
    });
    const prior = await this.previous(registration.pr);
    if (prior) {
      for (const action of prior.actions) {
        const session = this.deps.session(action.session);
        if (action.state === "intent" && session && actionObserved(session, action)) {
          action.state = "confirmed";
          await this.save(registration.pr, prior);
        }
      }
    }
    // Ambiguous intents survive revision changes; a new invocation never authorizes a repeat send.
    if (
      prior?.actions.some((action) => action.state === "intent") &&
      prior.invocation !== invocation
    )
      throw new ReviewAppError("continuation-delivery-uncertain");
    const record: ContinuationRecord =
      prior && (prior.invocation === invocation || snapshot.pr.merged === true)
        ? prior
        : {
            version: 1,
            authorityGeneration: registration.generation,
            invocation,
            H,
            B,
            reason,
            outcomes: prior?.outcomes ?? [],
            affirmations: {},
            actions: [],
            mergeSha: null,
            publishedProofDigest: null,
          };
    if (snapshot.pr.merged === true) {
      const mergeSha = receiptHash(snapshot.pr.merge_commit_sha, 40);
      if (
        !prior ||
        prior.H !== H ||
        prior.authorityGeneration !== registration.generation ||
        (!prior.mergeSha &&
          (prior.reason !== "owner-gated-continuation" ||
            prior.affirmations.code?.accepted !== true ||
            prior.affirmations.browser?.accepted !== true))
      )
        throw new ReviewAppError("continuation-external-merge-unverified");
      const mergedCommit = object(
        await api.request(`/repos/${loaded.gate.repository}/commits/${mergeSha}`),
      );
      const reviewedCommit = object(
        await api.request(`/repos/${loaded.gate.repository}/commits/${H}`),
      );
      if (
        !Array.isArray(mergedCommit.parents) ||
        mergedCommit.parents.length !== 1 ||
        object(mergedCommit.parents[0]).sha !== prior.B ||
        string(object(object(mergedCommit.commit).tree).sha) !==
          string(object(object(reviewedCommit.commit).tree).sha)
      )
        throw new ReviewAppError("continuation-merge-lineage-conflict");
      if (record.mergeSha && record.mergeSha !== mergeSha)
        throw new ReviewAppError("continuation-merge-conflict");
      record.mergeSha = mergeSha;
      reason = "published-deployment-pending";
      if (registration.deployment) {
        const release = await this.publishedRelease(loaded, registration, mergeSha);
        record.publishedProofDigest = registration.deployment.digest;
        reason = "published-deployment-verified";
        record.reason = reason;
        await this.save(registration.pr, record);
        if (loaded.policy.postRelease) {
          await this.postRelease(loaded, registration, record, release);
          return;
        }
      }
    } else if (reason === "all-gates-pass") {
      const commit = object(await api.request(`/repos/${loaded.gate.repository}/commits/${H}`));
      if (
        !Array.isArray(commit.parents) ||
        commit.parents.length !== 1 ||
        object(commit.parents[0]).sha !== B
      )
        reason = "head-not-direct-parent-base";
      else {
        for (const lane of ["code", "browser"] as const) {
          const receipt = receipts[lane];
          const session = this.deps.session(registration[lane]);
          if (!receipt || !session?.agentLaunchId || session.status !== "running") {
            reason = "designated-lane-unavailable";
            break;
          }
          const current = record.affirmations[lane];
          if (!current)
            record.affirmations[lane] = {
              challenge: randomUUID(),
              launch: digest(session.agentLaunchId),
              receiptDigest: digest(receipt),
              accepted: false,
            };
          const challenge = record.affirmations[lane];
          if (!challenge) throw new ReviewAppError("continuation-state-invalid");
          await this.save(registration.pr, record);
          await this.deliver(
            registration.pr,
            record,
            `affirm:${lane}:${invocation}`,
            registration[lane],
            `Release continuation affirmation requested. Invoke review-app affirm with current App config and structured request: ${JSON.stringify({ ...attemptFrom(receipt, paths[lane]), invocation, appId: receipt.appId, receiptDigest: challenge.receiptDigest, id: randomUUID(), challenge: challenge.challenge, status: "APPROVED" })}. Read current caller contract and receipts first; reject changed evidence.`,
          );
          if (!challenge.accepted) reason = "lane-affirmation-pending";
        }
      }
    }
    if (reason === "all-gates-pass") {
      if (!loaded.policy.activation) reason = "native-activation-proof-required";
      else {
        const activation = object(
          parseJson(await pinnedBytes(loaded.policy.activation, loaded.checkouts)),
        );
        const nativePin = pin(activation.nativeProof),
          assessmentPin = pin(activation.orderingAssessment);
        const native = object(parseJson(await pinnedBytes(nativePin, loaded.checkouts)));
        const assessment = object(parseJson(await pinnedBytes(assessmentPin, loaded.checkouts)));
        const rules = await api.request(
          `/repos/${loaded.gate.repository}/rules/branches/${encodeURIComponent(loaded.gate.baseBranch)}`,
        );
        if (
          native.native !== true ||
          native.status !==
            "sampled-native-results-only-requires-independent-ordering-assessment" ||
          assessment.accepted !== true ||
          assessment.nativeProofDigest !== nativePin.digest ||
          assessment.sourceDigest !== native.sourceDigest ||
          activation.repository !== loaded.gate.repository ||
          activation.baseBranch !== loaded.gate.baseBranch ||
          activation.scopeDigest !== registration.scopeDigest ||
          activation.gateDigest !== loaded.policy.gate.digest ||
          activation.contractDigest !== loaded.policy.contract.digest ||
          activation.protocolDigest !== loaded.policy.protocol.digest ||
          activation.toolDigest !== loaded.policy.tool.digest ||
          activation.rulesDigest !== digest(rules)
        )
          throw new ReviewAppError("continuation-activation-invalid");
        reason = "owner-gated-continuation";
      }
    }
    // Owner receives recovery work, never a controller-produced merge approval.
    const evidence = digest({
      invocation,
      reason,
      merge: record.mergeSha,
      deployed: record.publishedProofDigest,
    });
    record.reason = reason;
    await this.save(registration.pr, record);
    let ownerId = registration.owner;
    const owner = this.deps.session(ownerId);
    if (!owner || owner.status === "completed" || owner.status === "killed")
      ownerId = registration.successor ?? ownerId;
    const selected = this.deps.session(ownerId);
    if (selected && selected.status === "stopped" && !selected.stopReason && registration.restore) {
      const view = await this.deps.view(ownerId);
      if (view.workspaceExists && view.state === "stopped") {
        if (!selected.agentLaunchId) throw new ReviewAppError("continuation-owner-unavailable");
        const key = `restore:${ownerId}:${digest(selected.agentLaunchId)}`;
        const existing = record.actions.find((action) => action.key === key);
        if (existing?.state === "intent")
          throw new ReviewAppError("continuation-restore-uncertain");
        if (existing) throw new ReviewAppError("continuation-owner-unavailable");
        const action: ContinuationAction = {
          kind: "restore",
          key,
          session: ownerId,
          message: "restore",
          state: "intent",
          launch: digest(selected.agentLaunchId),
        };
        record.actions.push(action);
        await this.save(registration.pr, record);
        await this.fence?.assertCurrent();
        await this.deps.restore(ownerId);
        action.state = "confirmed";
        await this.save(registration.pr, record);
      }
    }
    await this.deliver(
      registration.pr,
      record,
      `owner:${evidence}:${ownerId}`,
      ownerId,
      `Release continuation for ${loaded.gate.repository}#${registration.pr}. H=${H} B=${B}. State=${reason}. Authority generation=${registration.generation}; scope=${registration.scopeDigest}. Resume registered review/CI/receipt repairs and release verification under existing authority. Read caller policy, current lane receipts and this durable invocation ${invocation}. Use existing github skill only after your fresh full gate read and independently accepted native protection proof; this notification supplies no approval. Preserve designated nonauthor code/browser Apps, independent coverage, both-lane interface attestation/consent, strict required CI and zero blocking threads. Retain ownership through confirmed squash, published package and verified isolated deployment; Shepherd sends no continuation prompt.`,
    );
  }
  async ingress(value: unknown, capability: string, affirmation: boolean): Promise<void> {
    await this.enqueue(async () => {
      if (this.stopped) throw new ReviewAppError("continuation-fenced");
      const request = parseContinuationIngress(value),
        loaded = await this.loaded();
      const registration = loaded.policy.registrations.find((item) => item.pr === request.pr);
      if (
        !registration?.active ||
        request.repo !== loaded.gate.repository ||
        request.session !== registration[request.lane]
      )
        throw new ReviewAppError("continuation-designation-mismatch");
      const session = this.deps.session(request.session);
      if (session?.status !== "running" || !sameCapability(session.agentLaunchId, capability))
        throw new ReviewAppError("continuation-launch-mismatch");
      if (
        request.appId !== loaded.apps[request.lane].appId ||
        request.contractDigest !== loaded.policy.contract.digest
      )
        throw new ReviewAppError("continuation-app-mismatch");
      const app = new GitHubApp(loaded.apps[request.lane], request.repo, this.deps.transport);
      const access = await app.authenticate();
      const pr = object(await app.request(`/repos/${request.repo}/pulls/${request.pr}`));
      if (
        object(pr.head).sha !== request.H ||
        object(pr.base).sha !== request.B ||
        pr.state !== "open" ||
        object(pr.user).login === access.actor
      )
        throw new ReviewAppError("revision-changed");
      const record = await this.previous(request.pr);
      if (
        !record ||
        record.authorityGeneration !== registration.generation ||
        record.invocation !== request.invocation ||
        record.H !== request.H ||
        record.B !== request.B
      )
        throw new ReviewAppError("continuation-invocation-stale");
      const canonical = await canonicalReceipt(loaded.apps.receiptRoot, request);
      const receipt = await readReviewReceipt(canonical);
      if (
        receipt.attempt !== request.attempt ||
        receipt.session !== request.session ||
        receipt.H !== request.H ||
        receipt.B !== request.B ||
        receipt.contractDigest !== request.contractDigest ||
        receipt.appId !== request.appId ||
        digest(receipt) !== request.receiptDigest
      )
        throw new ReviewAppError("continuation-receipt-changed");
      if (!affirmation) {
        if (request.status === "APPROVED")
          throw new ReviewAppError("continuation-transition-invalid");
        const intent: ReviewTransitionIntent = {
          ...request,
          id: request.id,
          appId: request.appId,
          status: request.status,
        };
        await this.fence?.assertCurrent();
        await admitReviewTransition(canonical, intent);
        record.reason = "review-transition-pending";
        await this.save(request.pr, record);
        return;
      }
      const challenge = record.affirmations[request.lane];
      if (
        request.status !== "APPROVED" ||
        !challenge ||
        challenge.accepted ||
        request.challenge !== challenge.challenge ||
        challenge.launch !== digest(session.agentLaunchId) ||
        challenge.receiptDigest !== request.receiptDigest ||
        (await unresolvedReviewTransitions(canonical))
      )
        throw new ReviewAppError("continuation-challenge-invalid");
      const release = await lockReviewReceipt(canonical);
      try {
        if (
          digest(await readReviewReceipt(canonical)) !== request.receiptDigest ||
          (await unresolvedReviewTransitions(canonical))
        )
          throw new ReviewAppError("continuation-receipt-changed");
        const reviews = await app.history(`/repos/${request.repo}/pulls/${request.pr}/reviews`);
        const native = effectiveNativeReview(reviews, { login: access.actor });
        if (
          receipt.status !== "APPROVED" ||
          receipt.reviewBlocked ||
          native?.id !== receipt.reviewId ||
          native.commit_id !== request.H ||
          native.state !== "APPROVED"
        )
          throw new ReviewAppError("native-approval-missing");
        challenge.accepted = true;
        await this.save(request.pr, record);
      } finally {
        await release();
      }
    });
    this.wake();
  }
}

export interface ReleaseContinuationController {
  stop(): Promise<void>;
  settled(): Promise<void>;
  ingress(value: unknown, capability: string, affirmation: boolean): Promise<void>;
}
export async function startReleaseContinuations(
  deps: Dependencies,
): Promise<ReleaseContinuationController> {
  const controllers: ProjectContinuation[] = [];
  try {
    for (const [id, project] of Object.entries(deps.config.projects)) {
      if (!project.releaseContinuation) continue;
      await mkdir(join(deps.config.dataDir, "release-continuation", id), {
        recursive: true,
        mode: 0o700,
      });
      const controller = new ProjectContinuation(id, project.releaseContinuation, deps);
      await controller.start();
      controllers.push(controller);
    }
  } catch (error) {
    for (const controller of controllers.reverse()) await controller.stop();
    throw error;
  }
  return {
    settled: async () => {
      await Promise.all(controllers.map((controller) => controller.settled()));
    },
    stop: async () => {
      for (const controller of controllers.reverse()) await controller.stop();
    },
    ingress: async (value, capability, affirmation) => {
      const request = parseContinuationIngress(value);
      const matches: ProjectContinuation[] = [];
      for (const controller of controllers)
        if (await controller.designates(request)) matches.push(controller);
      if (matches.length !== 1) throw new ReviewAppError("continuation-unregistered");
      const controller = matches[0];
      if (!controller) throw new ReviewAppError("continuation-unregistered");
      await controller.ingress(value, capability, affirmation);
    },
  };
}
