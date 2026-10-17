import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";

export const STAGES = Object.freeze({
  quality: { workflow: "ci.yml", seconds: 150, predecessor: null },
  playwright: { workflow: "ci.yml", seconds: 150, predecessor: "Quality" },
  "runtime-integration": { workflow: "ci.yml", seconds: 150, predecessor: "Playwright E2E" },
  "real-agent-smoke": { workflow: "ci.yml", seconds: 150, predecessor: "Runtime Integration" },
  gitleaks: { workflow: "security.yml", seconds: 300, predecessor: null },
  "npm-audit": { workflow: "security.yml", seconds: 300, predecessor: null },
  "onboarding-test": { workflow: "onboarding-test.yml", seconds: 600, predecessor: null },
});
export const REQUIRED_CONTEXTS = [
  "Quality",
  "Playwright E2E",
  "Runtime Integration",
  "Real-Agent Smoke",
];
const HASH = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const STATE = "Spur review state v1\n";
const CONSENT = "Spur interface consent v1\n";
const RESERVED = /(?:^|\n)(?:<!--[ \t]*)?Spur (?:review state|interface consent) v/g;

function insist(condition, reason) {
  if (!condition) throw new Error(reason);
}
function record(value) {
  insist(value !== null && typeof value === "object" && !Array.isArray(value), "invalid-object");
  return value;
}
function text(value) {
  insist(typeof value === "string" && value.length > 0, "invalid-string");
  return value;
}
function positive(value) {
  insist(Number.isSafeInteger(value) && value > 0, "invalid-integer");
  return value;
}
function timestamp(value) {
  insist(typeof value === "string" && TIMESTAMP.test(value), "invalid-timestamp");
  const result = Date.parse(value);
  insist(Number.isFinite(result), "invalid-timestamp");
  return result;
}
export function parsePolicy(value, repository) {
  const policy = record(value);
  insist(policy.version === 1 && policy.repository === repository, "policy-repository-mismatch");
  insist(/^[\w.-]+\/[\w.-]+$/.test(repository), "invalid-repository");
  positive(policy.codeAppId);
  positive(policy.browserAppId);
  insist(policy.codeAppId !== policy.browserAppId, "duplicate-apps");
  insist(DIGEST.test(text(policy.contractDigest)), "invalid-contract-policy");
  return {
    version: 1,
    repository,
    codeAppId: policy.codeAppId,
    browserAppId: policy.browserAppId,
    contractDigest: policy.contractDigest,
  };
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function clauses(value) {
  insist(Array.isArray(value), "invalid-manifest-clauses");
  const rows = value.map((entry) => text(entry).trim());
  insist(rows.every(Boolean), "invalid-manifest-clauses");
  return [...new Set(rows)].sort();
}
export function canonicalAssessment(value) {
  const assessment = record(value);
  insist(["required", "N/A", "unknown"].includes(assessment.status), "invalid-assessment");
  const input = record(assessment.manifest);
  insist(input.version === 1 && Array.isArray(input.surfaces), "invalid-manifest");
  const surfaces = input.surfaces
    .map((value) => {
      const row = record(value);
      insist(
        ["UI", "CLI", "config", "API", "prompt", "workflow"].includes(row.kind),
        "invalid-surface",
      );
      return {
        kind: row.kind,
        id: text(row.id),
        before: clauses(row.before),
        after: clauses(row.after),
        constraints: clauses(row.constraints),
      };
    })
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  insist(
    new Set(surfaces.map((row) => `${row.kind}:${row.id}`)).size === surfaces.length,
    "duplicate-surface",
  );
  const manifest = {
    version: 1,
    repository: text(input.repository),
    baseBranch: text(input.baseBranch),
    surfaces,
  };
  insist(/^[\w.-]+\/[\w.-]+$/.test(manifest.repository), "invalid-manifest-repository");
  insist(Array.isArray(assessment.dispositions), "invalid-dispositions");
  const dispositions = assessment.dispositions.map((value) => {
    const row = record(value);
    const result = {
      path: text(row.path),
      callers: clauses(row.callers),
      surfaceIds: clauses(row.surfaceIds),
      evidence: clauses(row.evidence),
    };
    insist(
      result.evidence.length > 0 &&
        result.surfaceIds.every((id) => surfaces.some((s) => s.id === id)),
      "invalid-disposition",
    );
    return result;
  });
  insist(
    new Set(dispositions.map((row) => row.path)).size === dispositions.length,
    "duplicate-disposition",
  );
  const changed = surfaces.some((row) => JSON.stringify(row.before) !== JSON.stringify(row.after));
  insist(
    !(assessment.status === "N/A" && changed) && !(assessment.status === "required" && !changed),
    "assessment-class-mismatch",
  );
  const baseline = {
    ...manifest,
    surfaces: surfaces.map(({ after: _after, ...row }) => row),
  };
  return {
    status: assessment.status,
    manifest,
    dispositions,
    manifestDigest: digest(manifest),
    baselineDigest: digest(baseline),
  };
}

function recognizes(body, marker) {
  const prefix = marker.slice(0, marker.indexOf("v1")) + "v";
  return (
    body.startsWith(prefix) || new RegExp(`(?:^|\\n)[\\t ]*<!--[\\t\\r\\n ]*${prefix}`).test(body)
  );
}
export function envelopePayload(body, marker) {
  insist(
    Buffer.byteLength(body, "utf8") <= 256 * 1024 && [...body.matchAll(RESERVED)].length === 1,
    "invalid-state-envelope",
  );
  let json;
  if (body.startsWith(marker)) {
    const [payload, ...tail] = body.slice(marker.length).split("\n");
    insist(
      tail.length === 0 || /^\nWritten by Spur · [^\r\n]+$/.test(tail.join("\n")),
      "invalid-state-envelope",
    );
    json = payload;
  } else {
    const start = body.indexOf(`\n\n<!-- ${marker}`);
    const ending = "\n-->\n\nWritten by Spur · ";
    const end = body.indexOf(ending);
    const footer = body.slice(end + ending.length);
    insist(
      start > 0 &&
        !body.slice(0, start).includes("\n") &&
        !/<!--|-->/.test(body.slice(0, start)) &&
        end >= start &&
        footer &&
        !/[\r\n]|<!--|-->/.test(footer),
      "invalid-state-envelope",
    );
    json = body.slice(start + `\n\n<!-- ${marker}`.length, end);
    insist(!/[\r\n<>&]/.test(json), "invalid-state-envelope");
  }
  try {
    return record(JSON.parse(json));
  } catch {
    throw new Error("invalid-state-envelope");
  }
}
function laneState(value) {
  const state = record(value);
  insist(state.version === 1 && ["code", "browser"].includes(state.lane), "invalid-lane-state");
  insist(
    ["PENDING", "BLOCKED", "APPROVED", "CHANGES_REQUESTED"].includes(state.status),
    "invalid-lane-state",
  );
  insist(
    HASH.test(text(state.H)) && HASH.test(text(state.B)) && DIGEST.test(text(state.evidenceDigest)),
    "invalid-lane-state",
  );
  text(state.repo);
  positive(state.pr);
  text(state.session);
  text(state.attempt);
  if (state.reviewId !== null) positive(state.reviewId);
  const assessment = state.assessment === null ? null : canonicalAssessment(state.assessment);
  insist(
    !["APPROVED", "CHANGES_REQUESTED"].includes(state.status) ||
      (state.reviewId !== null && assessment !== null),
    "invalid-lane-state",
  );
  return { ...state, assessment };
}
function consentState(value) {
  const state = record(value);
  insist(
    state.version === 1 && ["approved", "rejected", "revoked"].includes(state.decision),
    "invalid-consent-state",
  );
  insist(
    DIGEST.test(text(state.manifestDigest)) && DIGEST.test(text(state.baselineDigest)),
    "invalid-consent-state",
  );
  text(state.repo);
  positive(state.pr);
  text(state.task);
  text(state.branch);
  text(state.baseBranch);
  text(state.challenge);
  positive(state.generation);
  return state;
}
export function effectiveReview(reviews, actor) {
  const rows = reviews
    .filter((value) => {
      const row = record(value);
      const user = record(row.user);
      positive(user.id);
      if (user.id !== actor) return false;
      positive(row.id);
      if (["COMMENTED", "PENDING"].includes(row.state)) return false;
      insist(
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(row.state) &&
          typeof row.body === "string" &&
          HASH.test(text(row.commit_id)),
        "invalid-review-history",
      );
      timestamp(row.submitted_at);
      return true;
    })
    .sort((a, b) => timestamp(b.submitted_at) - timestamp(a.submitted_at));
  insist(
    rows.length < 2 || timestamp(rows[0].submitted_at) !== timestamp(rows[1].submitted_at),
    "ambiguous-review-history",
  );
  return rows[0];
}
function nativeBodyMatches(vote, state, contract) {
  const marker = `Spur review attempt: ${state.attempt}\n`;
  const start = vote.body.lastIndexOf(`\n\n${marker}`);
  if (start < 0) return false;
  const tail = vote.body.slice(start + 2).split("\n");
  const line = (prefix, value) =>
    tail.filter((entry) => entry.startsWith(prefix)).length === 1 &&
    tail.includes(`${prefix}${value}`);
  return (
    line("Lane: ", state.lane) &&
    line("H: ", state.H) &&
    line("B: ", state.B) &&
    line("ContractDigest: ", contract) &&
    line("Status: ", "APPROVED") &&
    tail.at(-1) === `Written by Spur · ${state.session}`
  );
}

// Scheduling classification only. Protected aggregate/thread/CI evaluation is unchanged.
export function reviewReadiness(policy, actors, snapshot) {
  const pr = record(snapshot.pr),
    head = record(pr.head),
    base = record(pr.base);
  const no = (reason) => ({ ready: false, reason });
  if (
    pr.state !== "open" ||
    pr.draft === true ||
    record(base.repo).full_name !== policy.repository ||
    base.ref !== snapshot.defaultBranch ||
    !HASH.test(text(head.sha)) ||
    !HASH.test(text(base.sha))
  )
    return no("pr-not-ready");
  positive(actors.code);
  positive(actors.browser);
  insist(actors.code !== actors.browser, "duplicate-actors");
  const effective = new Map();
  for (const actor of new Set(snapshot.reviews.map((row) => positive(record(row.user).id))))
    effective.set(actor, effectiveReview(snapshot.reviews, actor));
  if ([...effective.values()].some((row) => row?.state === "CHANGES_REQUESTED"))
    return no("changes-requested");
  const assessments = [],
    states = [],
    logins = [];
  for (const lane of ["code", "browser"]) {
    const actor = actors[lane],
      vote = effective.get(actor);
    if (
      !vote ||
      vote.state !== "APPROVED" ||
      vote.commit_id !== head.sha ||
      record(vote.user).type !== "Bot" ||
      record(pr.user).id === actor
    )
      return no("native-approval-missing");
    const binding = record(snapshot.apps[lane]);
    if (
      binding.id !== (lane === "code" ? policy.codeAppId : policy.browserAppId) ||
      `${binding.slug}[bot]` !== vote.user.login ||
      binding.actorId !== actor
    )
      return no("app-binding-unavailable");
    logins.push(text(vote.user.login));
    const rows = snapshot.comments
      .filter(
        (row) =>
          record(row.user).id === actor &&
          typeof row.body === "string" &&
          recognizes(row.body, STATE),
      )
      .sort((a, b) => positive(b.id) - positive(a.id));
    if (
      !rows.length ||
      record(rows[0].user).type !== "Bot" ||
      rows[0].user.login !== vote.user.login ||
      (rows[0].performed_via_github_app &&
        record(rows[0].performed_via_github_app).id !== binding.id)
    )
      return no("lane-state-missing");
    const state = laneState(envelopePayload(rows[0].body, STATE));
    if (
      state.repo !== policy.repository ||
      state.pr !== pr.number ||
      state.lane !== lane ||
      state.H !== head.sha ||
      state.B !== base.sha ||
      state.status !== "APPROVED" ||
      state.reviewId !== vote.id ||
      !state.assessment ||
      !nativeBodyMatches(vote, state, policy.contractDigest)
    )
      return no("lane-state-or-contract-mismatch");
    const assessment = state.assessment;
    if (
      assessment.status === "unknown" ||
      assessment.manifest.repository !== policy.repository ||
      assessment.manifest.baseBranch !== base.ref
    )
      return no("interface-unknown");
    const paths = snapshot.files.map((row) => text(row.filename)).sort();
    if (
      JSON.stringify(paths) !==
      JSON.stringify(assessment.dispositions.map((row) => row.path).sort())
    )
      return no("incomplete-file-coverage");
    assessments.push(assessment);
    states.push(state);
  }
  if (logins[0] === logins[1]) return no("duplicate-lane-login");
  const [first, second] = assessments;
  if (
    first.status !== second.status ||
    first.manifestDigest !== second.manifestDigest ||
    first.baselineDigest !== second.baselineDigest
  )
    return no("interface-disagreement");
  if (first.status === "required") {
    const sameScope = (value) =>
      value.repo === policy.repository &&
      value.pr === pr.number &&
      value.branch === head.ref &&
      value.baseBranch === base.ref &&
      value.manifestDigest === first.manifestDigest &&
      value.baselineDigest === first.baselineDigest;
    const history = snapshot.comments
      .filter(
        (row) =>
          record(row.user).id === actors.code &&
          typeof row.body === "string" &&
          recognizes(row.body, CONSENT),
      )
      .map((row) => ({ row, state: consentState(envelopePayload(row.body, CONSENT)) }))
      .filter((entry) => sameScope(entry.state));
    if (!history.length) return no("consent-missing");
    const latestRow = [...history].sort((a, b) => positive(b.row.id) - positive(a.row.id))[0];
    if (
      record(latestRow.row.user).type !== "Bot" ||
      latestRow.row.user.login !== logins[0] ||
      (latestRow.row.performed_via_github_app &&
        record(latestRow.row.performed_via_github_app).id !== policy.codeAppId)
    )
      return no("consent-author-mismatch");
    const task = history[0].state.task;
    if (history.some((entry) => entry.state.task !== task)) return no("consent-task-conflict");
    const generation = Math.max(...history.map((entry) => entry.state.generation));
    const current = history
      .filter((entry) => entry.state.generation === generation)
      .map((entry) => entry.state);
    if (
      current.some(
        (entry) =>
          entry.challenge !== current[0].challenge || entry.decision !== current[0].decision,
      ) ||
      current[0].decision !== "approved"
    )
      return no("consent-not-approved");
  }
  return {
    ready: true,
    reason: "designated-current-native-approvals",
    H: head.sha,
    B: base.sha,
    reviewIds: states.map((state) => state.reviewId),
  };
}

export function stageDeadline(stage, run, jobs, wallNow, monotonicNow, remainingMs) {
  const mapping = STAGES[stage];
  insist(mapping, "unknown-stage");
  let anchor = timestamp(run.created_at);
  if (mapping.predecessor) {
    const rows = jobs.filter((job) => job.name === mapping.predecessor);
    insist(
      rows.length === 1 &&
        rows[0].run_attempt === run.run_attempt &&
        rows[0].status === "completed" &&
        rows[0].conclusion === "success",
      "predecessor-unavailable",
    );
    anchor = timestamp(rows[0].completed_at);
  }
  return Math.min(
    monotonicNow + Math.max(0, Math.min(remainingMs, mapping.seconds * 1000)),
    monotonicNow + anchor + mapping.seconds * 1000 - wallNow,
  );
}

class ReadOnlyGitHub {
  constructor(options, deadline) {
    this.options = options;
    this.deadline = deadline;
    this.requests = options.setupRequests ?? 0;
  }
  remaining() {
    return Math.max(0, this.deadline - this.options.now());
  }
  async request(path) {
    insist(
      path.startsWith(`/repos/${this.options.repository}/`) ||
        /^\/apps\/[\w-]+$/.test(path) ||
        /^\/users\/[\w%.-]+$/.test(path),
      "untrusted-api-path",
    );
    insist(this.requests < 96 && this.remaining() > 0, "admission-budget-exhausted");
    this.requests++;
    this.options.signal?.throwIfAborted();
    const controller = new globalThis.AbortController();
    const abort = () => controller.abort();
    this.options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(10_000, this.remaining()));
    try {
      const response = await this.options.fetch(`https://api.github.com${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: controller.signal,
      });
      insist(response.ok, `github-read-${response.status}`);
      const body = await response.text();
      insist(Buffer.byteLength(body, "utf8") <= 4 * 1024 * 1024, "response-too-large");
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("invalid-api-json");
      }
      insist(this.remaining() > 0, "admission-budget-exhausted");
      return { data, next: /;\s*rel="next"/.test(response.headers.get("link") ?? "") };
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener("abort", abort);
    }
  }
  async get(path) {
    return (await this.request(path)).data;
  }
  async pages(path, key) {
    const rows = [];
    for (let page = 1; page <= 8; page++) {
      const response = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const values = key ? record(response.data)[key] : response.data;
      insist(Array.isArray(values), "invalid-api-collection");
      rows.push(...values.map(record));
      const total = key ? record(response.data).total_count : undefined;
      if (!response.next && (total === undefined || total === rows.length)) return rows;
    }
    throw new Error("pagination-budget-exhausted");
  }
}

async function readReadiness(api, policy, actors, pr, defaultBranch, sourceSha) {
  const prefix = `/repos/${policy.repository}`;
  const reviews = await api.pages(`${prefix}/pulls/${positive(pr.number)}/reviews`);
  for (const actor of new Set(reviews.map((row) => positive(record(row.user).id))))
    if (effectiveReview(reviews, actor)?.state === "CHANGES_REQUESTED")
      return { ready: false, reason: "changes-requested" };
  const apps = {};
  for (const lane of ["code", "browser"]) {
    const vote = effectiveReview(reviews, actors[lane]);
    if (
      !vote ||
      vote.state !== "APPROVED" ||
      vote.commit_id !== record(pr.head).sha ||
      record(vote.user).type !== "Bot"
    )
      return { ready: false, reason: "native-approval-missing" };
    const login = text(vote.user.login);
    insist(/^[\w-]+\[bot\]$/.test(login), "unobservable-app-binding");
    const app = record(await api.get(`/apps/${login.slice(0, -5)}`));
    const actor = record(await api.get(`/users/${encodeURIComponent(login)}`));
    insist(
      actor.id === actors[lane] && actor.login === login && actor.type === "Bot",
      "app-actor-mismatch",
    );
    apps[lane] = { id: app.id, slug: app.slug, actorId: actor.id };
  }
  const comments = await api.pages(`${prefix}/issues/${pr.number}/comments`);
  const files = await api.pages(`${prefix}/pulls/${pr.number}/files`);
  const decision = reviewReadiness(policy, actors, {
    pr,
    reviews,
    comments,
    files,
    apps,
    defaultBranch,
  });
  if (!decision.ready) return decision;
  const target = record(await api.get(`${prefix}/commits/${encodeURIComponent(defaultBranch)}`));
  const current = record(await api.get(`${prefix}/pulls/${pr.number}`));
  if (
    target.sha !== sourceSha ||
    record(current.head).sha !== record(pr.head).sha ||
    record(current.base).sha !== record(pr.base).sha ||
    current.state !== "open" ||
    current.draft === true
  )
    return { ready: false, reason: "review-or-trusted-target-moved" };
  return { ...decision, liveTarget: target.sha };
}
function workflowPath(value) {
  return text(value).split("@")[0];
}
function associatedRun(run, pr, repository) {
  if (
    record(run.repository).full_name !== repository ||
    positive(run.repository.id) !== positive(record(record(pr.base).repo).id) ||
    record(run.head_repository).full_name !== record(record(pr.head).repo).full_name ||
    positive(run.head_repository.id) !== positive(pr.head.repo.id) ||
    run.event !== "pull_request" ||
    run.head_sha !== record(pr.head).sha ||
    run.head_branch !== pr.head.ref
  )
    return false;
  return (
    Array.isArray(run.pull_requests) &&
    run.pull_requests.some((value) => {
      const row = record(value);
      return (
        row.number === pr.number &&
        record(row.head).sha === pr.head.sha &&
        record(row.base).sha === record(pr.base).sha
      );
    })
  );
}
async function unfinishedCi(api, policy, pr) {
  const prefix = `/repos/${policy.repository}`;
  const workflow = record(await api.get(`${prefix}/actions/workflows/ci.yml`));
  insist(workflow.path === ".github/workflows/ci.yml", "ci-workflow-mismatch");
  const runs = await api.pages(
    `${prefix}/actions/workflows/${positive(workflow.id)}/runs?event=pull_request&head_sha=${pr.head.sha}`,
    "workflow_runs",
  );
  const candidates = runs
    .filter(
      (run) =>
        run.workflow_id === workflow.id &&
        workflowPath(run.path) === workflow.path &&
        run.head_sha === pr.head.sha &&
        run.head_branch === pr.head.ref,
    )
    .sort(
      (a, b) =>
        timestamp(b.created_at) - timestamp(a.created_at) || positive(b.id) - positive(a.id),
    );
  if (!candidates.length) return false;
  const run = record(await api.get(`${prefix}/actions/runs/${positive(candidates[0].id)}`));
  if (!associatedRun(run, pr, policy.repository)) return false;
  const attempt = record(
    await api.get(`${prefix}/actions/runs/${run.id}/attempts/${positive(run.run_attempt)}`),
  );
  insist(
    ["id", "run_attempt", "head_sha", "head_branch", "status", "conclusion", "path"].every(
      (key) => attempt[key] === run[key],
    ),
    "ci-attempt-mismatch",
  );
  insist(associatedRun(attempt, pr, policy.repository), "ci-attempt-repository-mismatch");
  if (["completed"].includes(run.status)) return false;
  if (!["queued", "in_progress", "waiting", "requested", "pending"].includes(run.status))
    return false;
  const jobs = await api.pages(
    `${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    "jobs",
  );
  const required = jobs.filter((job) => REQUIRED_CONTEXTS.includes(job.name));
  if (
    REQUIRED_CONTEXTS.every(
      (name) =>
        required.filter(
          (job) => job.name === name && job.conclusion === "success" && job.status === "completed",
        ).length === 1,
    )
  )
    return false;
  const admissionNames = Object.entries(STAGES)
    .filter(([, stage]) => stage.workflow === "ci.yml")
    .map(([stage]) => `${stage}-admission / Admission`);
  const admissions = jobs.filter((job) => admissionNames.includes(job.name));
  // Hosted admission is unfinished CI, including before the first real job exists.
  // An unrelated optional job cannot create demand after all four real jobs finish.
  if (!required.length && !admissions.length) return run.status === "queued" && jobs.length === 0;
  if (required.some((job) => job.status === "completed" && job.conclusion !== "success"))
    return false;
  for (const job of [...required, ...admissions]) {
    insist(
      job.run_attempt === run.run_attempt && job.head_sha === pr.head.sha,
      "ci-job-provenance-mismatch",
    );
    const match = /^https:\/\/api\.github\.com(\/repos\/[^/]+\/[^/]+\/check-runs\/\d+)$/.exec(
      text(job.check_run_url),
    );
    insist(match, "ci-check-provenance-unavailable");
    const check = record(await api.get(match[1]));
    insist(
      record(check.app).id === 15368 && check.name === job.name && check.head_sha === pr.head.sha,
      "ci-check-provenance-mismatch",
    );
  }
  return [...required, ...admissions].some((job) =>
    ["queued", "in_progress", "waiting", "pending"].includes(job.status),
  );
}

export async function runAdmission(input) {
  const now = input.now ?? (() => performance.now());
  const wallNow = input.wallNow ?? (() => Date.now());
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const start = now();
  let api;
  const result = (classification, reason, extra = {}) => ({
    admitted: true,
    classification,
    reason,
    stage: input.stage,
    runId: input.runId,
    attempt: input.attempt,
    sourceSha: input.sourceSha,
    policyDigest: input.policy ? digest(input.policy) : null,
    waitMs: Math.max(0, now() - start),
    requests: api?.requests ?? input.setupRequests ?? 0,
    ...extra,
  });
  if (input.eventName !== "pull_request") return result("bypass", "non-pull-request");
  try {
    const mapping = STAGES[input.stage];
    insist(mapping, "unknown-stage");
    const policy = parsePolicy(input.policy, input.repository);
    insist(HASH.test(text(input.sourceSha)), "invalid-trusted-source");
    const actors = { code: positive(input.codeActor), browser: positive(input.browserActor) };
    insist(actors.code !== actors.browser, "duplicate-actors");
    const options = { ...input, fetch: input.fetch ?? globalThis.fetch, now };
    api = new ReadOnlyGitHub(
      options,
      start + Math.max(0, Math.min(input.remainingMs, mapping.seconds * 1000)),
    );
    const prefix = `/repos/${policy.repository}`;
    const run = record(await api.get(`${prefix}/actions/runs/${positive(input.runId)}`));
    insist(
      run.id === input.runId &&
        run.run_attempt === positive(input.attempt) &&
        run.event === "pull_request" &&
        workflowPath(run.path) === `.github/workflows/${mapping.workflow}`,
      "caller-run-mismatch",
    );
    const attempt = record(
      await api.get(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}`),
    );
    insist(
      ["id", "head_sha", "head_branch", "run_attempt", "path", "event"].every(
        (key) => run[key] === attempt[key],
      ),
      "caller-attempt-mismatch",
    );
    const eventPr = record(record(input.event).pull_request);
    const number = positive(eventPr.number);
    const initial = record(await api.get(`${prefix}/pulls/${number}`));
    insist(
      associatedRun(run, initial, policy.repository) &&
        associatedRun(attempt, initial, policy.repository) &&
        record(eventPr.head).sha === record(initial.head).sha &&
        record(eventPr.base).sha === record(initial.base).sha &&
        record(record(eventPr.head).repo).full_name ===
          record(record(initial.head).repo).full_name &&
        positive(eventPr.head.repo.id) === positive(initial.head.repo.id) &&
        record(record(eventPr.base).repo).full_name === policy.repository &&
        positive(eventPr.base.repo.id) === positive(initial.base.repo.id),
      "caller-pr-mismatch",
    );
    const jobs = mapping.predecessor
      ? await api.pages(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs")
      : [];
    api.deadline = stageDeadline(input.stage, run, jobs, wallNow(), now(), api.remaining());
    const defaultBranch = text(input.defaultBranch);
    let polls = 0;
    while (api.remaining() > 0) {
      input.signal?.throwIfAborted();
      const own = polls++ === 0 ? initial : record(await api.get(`${prefix}/pulls/${number}`));
      if (
        own.state !== "open" ||
        own.head.sha !== initial.head.sha ||
        own.base.sha !== initial.base.sha
      )
        return result("ordinary", "caller-revision-changed");
      const ownReadiness = await readReadiness(
        api,
        policy,
        actors,
        own,
        defaultBranch,
        input.sourceSha,
      );
      if (ownReadiness.ready)
        return result("ready", ownReadiness.reason, { H: own.head.sha, B: own.base.sha });
      const listing = await api.request(
        `${prefix}/pulls?state=open&sort=updated&direction=desc&per_page=20&page=1`,
      );
      insist(Array.isArray(listing.data) && listing.data.length <= 20, "invalid-candidate-window");
      let demanding;
      const inspected = [];
      for (const summary of listing.data) {
        const candidateNumber = positive(record(summary).number);
        if (candidateNumber === number) continue;
        const pr = record(await api.get(`${prefix}/pulls/${candidateNumber}`));
        inspected.push(candidateNumber);
        if (pr.state !== "open" || pr.draft === true) continue;
        const ready = await readReadiness(api, policy, actors, pr, defaultBranch, input.sourceSha);
        if (ready.ready && (await unfinishedCi(api, policy, pr))) {
          demanding = candidateNumber;
          break;
        }
      }
      if (!demanding)
        return result(
          "ordinary",
          listing.next ? "bounded-candidate-window-no-demand" : "no-verified-ready-demand",
          { inspected, boundedCandidates: 20 },
        );
      const remaining = api.remaining();
      if (remaining <= 0) break;
      await wait(Math.min(30_000, remaining));
      input.signal?.throwIfAborted();
    }
    return result("ordinary", "admission-allocation-expired");
  } catch (error) {
    input.signal?.throwIfAborted();
    return result("ordinary", "degraded-evidence-or-budget", {
      detail: error instanceof Error ? error.message : "unknown-error",
    });
  }
}
