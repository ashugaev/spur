import type { Command } from "commander";
import {
  object,
  integer,
  string,
  readJson,
  effectiveNativeReview,
  ReviewAppError,
} from "./github-app.js";
import { baselineDigest, digest, manifestDigest } from "./review-interface.js";
import {
  consentMarker,
  parseConsentState,
  readStateBody,
  stateMarker,
  sameConsentScope,
} from "./review-state.js";

export interface GatePolicy {
  repository: string;
  baseBranch: string;
  codeActor: number;
  browserActor: number;
  ciWorkflowId: number;
  ciJobs: string[];
}
export function parseGatePolicy(value: unknown): GatePolicy {
  const data = object(value);
  if (!Array.isArray(data.ciJobs) || !data.ciJobs.length)
    throw new ReviewAppError("invalid-gate-policy");
  const result = {
    repository: string(data.repository),
    baseBranch: string(data.baseBranch),
    codeActor: integer(data.codeActor),
    browserActor: integer(data.browserActor),
    ciWorkflowId: integer(data.ciWorkflowId),
    ciJobs: data.ciJobs.map(string),
  };
  if (
    result.codeActor === result.browserActor ||
    new Set(result.ciJobs).size !== result.ciJobs.length ||
    !/^[\w.-]+\/[\w.-]+$/.test(result.repository)
  )
    throw new ReviewAppError("invalid-gate-policy");
  return result;
}
export function workflowPath(value: unknown): string {
  const path = string(value),
    separator = path.indexOf("@");
  return separator < 0 ? path : path.slice(0, separator);
}
export class GateGitHub {
  constructor(
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (!token) throw new ReviewAppError("missing-actions-token");
  }
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ReviewAppError("gate-network");
    }
    if (!response.ok) throw new ReviewAppError(`gate-http-${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new ReviewAppError("gate-response");
    }
  }
  async pages(path: string, key?: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    for (let page = 1; page <= 1000; page++) {
      const value = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const rows = key ? object(value)[key] : value;
      if (!Array.isArray(rows)) throw new ReviewAppError("gate-response");
      result.push(...rows.map(object));
      if (rows.length < 100) return result;
    }
    throw new ReviewAppError("gate-pagination-limit");
  }
}
export interface GateSnapshot {
  pr: Record<string, unknown>;
  reviews: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  files: Record<string, unknown>[];
  unresolved: number;
  runs: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  ciAnchors: { runId: number; merge: string; parents: string[] }[];
}
function ciRef(run: Record<string, unknown>) {
  if (typeof run.display_title !== "string") return null;
  const match = /^Spur CI v1 REF=refs\/pull\/([1-9]\d*)\/merge M=([a-f0-9]{40})$/.exec(
    run.display_title,
  );
  return match ? { number: integer(Number(match[1])), merge: string(match[2]) } : null;
}
function ciIdentity(policy: GatePolicy, run: Record<string, unknown>) {
  return (
    run.workflow_id === policy.ciWorkflowId &&
    workflowPath(run.path) === ".github/workflows/ci.yml" &&
    object(run.repository).full_name === policy.repository &&
    run.event === "pull_request"
  );
}
function ciCandidate(number: number, snapshot: GateSnapshot, run: Record<string, unknown>) {
  const head = object(snapshot.pr.head);
  if (run.head_sha === head.sha) return true;
  const anchor = snapshot.ciAnchors.find((value) => value.runId === run.id);
  if (
    anchor?.parents.length === 2 &&
    anchor.parents.every((sha) => /^[a-f0-9]{40}$/.test(sha)) &&
    (run.head_sha === anchor.merge || run.head_sha === anchor.parents[1]) &&
    run.head_branch === head.ref &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.every((value) => {
      const associated = object(value);
      return (
        associated.number === number &&
        object(associated.head).sha === anchor.parents[1] &&
        object(associated.base).sha === anchor.parents[0]
      );
    })
  )
    return anchor.parents[1] === head.sha;
  if (ciRef(run)?.number === number) return true;
  return (
    run.head_branch === head.ref &&
    (string(run.path).endsWith(`@refs/pull/${number}/merge`) ||
      (Array.isArray(run.pull_requests) &&
        run.pull_requests.some((value) => object(value).number === number)))
  );
}
function selectCiRun(policy: GatePolicy, number: number, snapshot: GateSnapshot) {
  const candidates = snapshot.runs.filter(
    (run) => ciIdentity(policy, run) && ciCandidate(number, snapshot, run),
  );
  const active = candidates.find((run) => run.status !== "completed");
  if (active) return active;
  const starts = candidates
    .map((run) => {
      if (
        typeof run.run_started_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(run.run_started_at) ||
        !Number.isFinite(Date.parse(run.run_started_at))
      )
        throw new ReviewAppError("ci-attempt-time-unavailable");
      integer(run.run_attempt);
      return { run, time: Date.parse(run.run_started_at) };
    })
    .sort((a, b) => b.time - a.time);
  if (new Set(starts.map(({ time }) => time)).size !== starts.length)
    throw new ReviewAppError("ci-attempt-time-ambiguous");
  return starts[0]?.run;
}
function ciProvenance(
  policy: GatePolicy,
  number: number,
  snapshot: GateSnapshot,
  run: Record<string, unknown>,
) {
  const ref = ciRef(run),
    H = object(snapshot.pr.head).sha,
    B = object(snapshot.pr.base).sha;
  const anchor = snapshot.ciAnchors.find((value) => value.runId === run.id);
  return (
    ciIdentity(policy, run) &&
    ref?.number === number &&
    anchor?.merge === ref.merge &&
    anchor.parents.length === 2 &&
    anchor.parents[0] === B &&
    anchor.parents[1] === H &&
    (run.head_sha === H || run.head_sha === ref.merge) &&
    run.head_branch === object(snapshot.pr.head).ref &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.every((value) => {
      const associated = object(value);
      return (
        associated.number === number &&
        object(associated.head).sha === H &&
        object(associated.base).sha === B
      );
    })
  );
}
export function evaluateSnapshot(policy: GatePolicy, number: number, snapshot: GateSnapshot) {
  const blocked = (reason: string) => ({
    status: "BLOCKED" as const,
    reason,
    H: string(object(snapshot.pr.head).sha),
    B: string(object(snapshot.pr.base).sha),
    fingerprint: digest(snapshot),
  });
  try {
    const pr = snapshot.pr,
      head = object(pr.head),
      base = object(pr.base);
    const H = string(head.sha),
      B = string(base.sha);
    if (
      pr.state !== "open" ||
      pr.draft === true ||
      object(base.repo).full_name !== policy.repository ||
      base.ref !== policy.baseBranch ||
      !/^[a-f0-9]{40}$/.test(H) ||
      !/^[a-f0-9]{40}$/.test(B)
    )
      return blocked("pr-not-ready");
    if (snapshot.unresolved !== 0) return blocked("unresolved-threads");
    const effective = new Map<number, Record<string, unknown>>();
    for (const actor of new Set(snapshot.reviews.map((row) => integer(object(row.user).id)))) {
      const review = effectiveNativeReview(snapshot.reviews, { id: actor });
      if (review) effective.set(actor, review);
    }
    if ([...effective.values()].some((row) => row.state === "CHANGES_REQUESTED"))
      return blocked("changes-requested");
    const assessments = [];
    for (const lane of ["code", "browser"] as const) {
      const actor = lane === "code" ? policy.codeActor : policy.browserActor;
      const vote = effective.get(actor);
      if (
        !vote ||
        vote.state !== "APPROVED" ||
        vote.commit_id !== H ||
        object(vote.user).type !== "Bot" ||
        integer(object(pr.user).id) === actor
      )
        return blocked("native-approval-missing");
      const rows = snapshot.comments
        .filter(
          (row) =>
            integer(object(row.user).id) === actor &&
            typeof row.body === "string" &&
            row.body.startsWith(stateMarker),
        )
        .sort((a, b) => integer(b.id) - integer(a.id));
      const latest = rows[0];
      if (!latest || object(latest.user).type !== "Bot") return blocked("lane-state-missing");
      const state = readStateBody(string(latest.body));
      if (
        state.repo !== policy.repository ||
        state.pr !== number ||
        state.lane !== lane ||
        state.H !== H ||
        state.B !== B ||
        state.status !== "APPROVED" ||
        state.reviewId !== vote.id ||
        !state.assessment
      )
        return blocked("lane-state-not-approved");
      const assessment = state.assessment;
      if (
        assessment.status === "unknown" ||
        assessment.manifest.repository !== policy.repository ||
        assessment.manifest.baseBranch !== policy.baseBranch
      )
        return blocked("interface-unknown");
      const paths = snapshot.files.map((file) => string(file.filename)).sort();
      if (
        JSON.stringify(paths) !==
        JSON.stringify(assessment.dispositions.map((row) => row.path).sort())
      )
        return blocked("interface-coverage-incomplete");
      assessments.push(assessment);
    }
    const first = assessments[0],
      second = assessments[1];
    if (
      !first ||
      !second ||
      first.status !== second.status ||
      manifestDigest(first.manifest) !== manifestDigest(second.manifest) ||
      baselineDigest(first.manifest) !== baselineDigest(second.manifest)
    )
      return blocked("interface-disagreement");
    if (first.status === "required") {
      const scope = {
        repo: policy.repository,
        pr: number,
        branch: string(head.ref),
        baseBranch: string(base.ref),
        manifestDigest: manifestDigest(first.manifest),
        baselineDigest: baselineDigest(first.manifest),
      };
      const latest = snapshot.comments
        .filter(
          (row) =>
            integer(object(row.user).id) === policy.codeActor &&
            typeof row.body === "string" &&
            row.body.startsWith(consentMarker),
        )
        .filter((row) =>
          sameConsentScope(
            parseConsentState(
              JSON.parse(string(row.body).slice(consentMarker.length).split("\n")[0] ?? ""),
            ),
            scope,
          ),
        )
        .sort((a, b) => integer(b.id) - integer(a.id))[0];
      if (!latest || object(latest.user).type !== "Bot") return blocked("consent-missing");
      let consent;
      try {
        consent = parseConsentState(
          JSON.parse(string(latest.body).slice(consentMarker.length).split("\n")[0] ?? ""),
        );
        for (const row of snapshot.comments) {
          if (
            integer(object(row.user).id) !== policy.codeActor ||
            typeof row.body !== "string" ||
            !row.body.startsWith(consentMarker)
          )
            continue;
          const prior = parseConsentState(
            JSON.parse(row.body.slice(consentMarker.length).split("\n")[0] ?? ""),
          );
          if (!sameConsentScope(prior, scope)) continue;
          if (prior.task !== consent.task) return blocked("consent-task-conflict");
          if (prior.task === consent.task && prior.generation > consent.generation) consent = prior;
        }
      } catch {
        return blocked("consent-invalid");
      }
      if (
        consent.repo !== policy.repository ||
        consent.pr !== number ||
        consent.branch !== head.ref ||
        consent.baseBranch !== base.ref ||
        consent.decision !== "approved" ||
        consent.manifestDigest !== manifestDigest(first.manifest) ||
        consent.baselineDigest !== baselineDigest(first.manifest)
      )
        return blocked("consent-not-approved");
    }
    const run = selectCiRun(policy, number, snapshot);
    if (
      !run ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !ciProvenance(policy, number, snapshot, run)
    )
      return blocked("ci-not-success");
    if (
      snapshot.jobs.length !== policy.ciJobs.length ||
      policy.ciJobs.some(
        (name) =>
          snapshot.jobs.filter(
            (job) =>
              job.name === name &&
              job.run_id === run.id &&
              job.run_attempt === run.run_attempt &&
              job.status === "completed" &&
              job.conclusion === "success",
          ).length !== 1,
      )
    )
      return blocked("ci-jobs-not-success");
    return {
      status: "APPROVED" as const,
      reason: "all-gates-pass",
      H,
      B,
      fingerprint: digest(snapshot),
    };
  } catch {
    return blocked("malformed-evidence");
  }
}
export async function readGateSnapshot(
  api: GateGitHub,
  policy: GatePolicy,
  number: number,
): Promise<GateSnapshot> {
  const path = `/repos/${policy.repository}`;
  const pr = object(await api.request(`${path}/pulls/${number}`));
  const [reviews, comments, files, listedRuns] = await Promise.all([
    api.pages(`${path}/pulls/${number}/reviews`),
    api.pages(`${path}/issues/${number}/comments`),
    api.pages(`${path}/pulls/${number}/files`),
    api.pages(`${path}/actions/workflows/${policy.ciWorkflowId}/runs`, "workflow_runs"),
  ]);
  let unresolved = 0,
    cursor: string | null = null;
  const [owner, name] = policy.repository.split("/");
  for (let page = 0; ; page++) {
    if (page >= 1000) throw new ReviewAppError("gate-pagination-limit");
    const result = object(
      await api.request("/graphql", "POST", {
        query:
          "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}",
        variables: { owner, name, number, cursor },
      }),
    );
    if (result.errors) throw new ReviewAppError("gate-threads-unavailable");
    const connection = object(
      object(object(object(result.data).repository).pullRequest).reviewThreads,
    );
    if (!Array.isArray(connection.nodes)) throw new ReviewAppError("gate-response");
    for (const value of connection.nodes) {
      const node = object(value);
      if (typeof node.isResolved !== "boolean") throw new ReviewAppError("gate-response");
      if (!node.isResolved) unresolved++;
    }
    const info = object(connection.pageInfo);
    if (info.hasNextPage === false) break;
    if (info.hasNextPage !== true || info.endCursor === cursor)
      throw new ReviewAppError("gate-response");
    cursor = string(info.endCursor);
  }
  const runs: GateSnapshot["runs"] = [],
    ciAnchors: GateSnapshot["ciAnchors"] = [];
  for (const listed of listedRuns) {
    if (!ciIdentity(policy, listed)) continue;
    const ref = ciRef(listed);
    if (
      listed.head_sha !== object(pr.head).sha &&
      ref?.number !== number &&
      !(
        listed.head_branch === object(pr.head).ref &&
        (ref ||
          string(listed.path).endsWith(`@refs/pull/${number}/merge`) ||
          (Array.isArray(listed.pull_requests) &&
            listed.pull_requests.some((value) => object(value).number === number)))
      )
    )
      continue;
    const run = object(await api.request(`${path}/actions/runs/${integer(listed.id)}`));
    const attempt = object(
      await api.request(
        `${path}/actions/runs/${integer(listed.id)}/attempts/${integer(run.run_attempt)}`,
      ),
    );
    if (
      !ciIdentity(policy, run) ||
      !ciIdentity(policy, attempt) ||
      run.id !== listed.id ||
      ["path", "head_sha", "head_branch", "display_title"].some(
        (key) => run[key] !== listed[key],
      ) ||
      [
        "id",
        "path",
        "run_attempt",
        "head_sha",
        "head_branch",
        "display_title",
        "run_started_at",
        "status",
        "conclusion",
      ].some((key) => run[key] !== attempt[key]) ||
      digest(run.pull_requests) !== digest(attempt.pull_requests)
    )
      throw new ReviewAppError("ci-attempt-mismatch");
    runs.push(attempt);
    const actualRef = ciRef(attempt);
    const historicalMerge =
      actualRef?.merge ??
      (attempt.head_sha === object(pr.head).sha ? null : string(attempt.head_sha));
    if (historicalMerge) {
      if (!/^[a-f0-9]{40}$/.test(historicalMerge)) throw new ReviewAppError("invalid-ci-head");
      let parents: string[] = [];
      try {
        const commit = object(await api.request(`${path}/commits/${historicalMerge}`));
        if (commit.sha === historicalMerge && Array.isArray(commit.parents))
          parents = commit.parents.map((value) => string(object(value).sha));
      } catch {
        /* Missing historical lineage remains ineligible, never inferred from current merge state. */
      }
      ciAnchors.push({ runId: integer(attempt.id), merge: historicalMerge, parents });
    }
  }
  const snapshot = { pr, reviews, comments, files, unresolved, runs, jobs: [], ciAnchors };
  const run = selectCiRun(policy, number, snapshot);
  const jobs = run
    ? await api.pages(
        `${path}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`,
        "jobs",
      )
    : [];
  return { ...snapshot, jobs };
}
export function registerReviewGate(program: Command): void {
  program
    .command("review-gate")
    .description("Evaluate exact reviewer and interface gates.")
    .command("evaluate")
    .requiredOption("--repo <owner/name>")
    .requiredOption("--pr <number>")
    .requiredOption("--policy <file>")
    .option("--json")
    .action(async (options: { repo: string; pr: string; policy: string }) => {
      const policy = parseGatePolicy(await readJson(options.policy));
      if (policy.repository !== options.repo) throw new ReviewAppError("repository-mismatch");
      const number = integer(Number(options.pr));
      const snapshot = await readGateSnapshot(
        new GateGitHub(process.env["GITHUB_TOKEN"] ?? ""),
        policy,
        number,
      );
      const result = evaluateSnapshot(policy, number, snapshot);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== "APPROVED") process.exitCode = 1;
    });
}
