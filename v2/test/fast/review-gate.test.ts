import { expect, test, vi } from "vitest";
import {
  evaluateSnapshot,
  readGateSnapshot,
  GateGitHub,
  type GateSnapshot,
  type GatePolicy,
} from "../../src/review-gate.js";
import { produceGates } from "../../src/review-gate-producer.js";
import {
  stateBody,
  readStateBody,
  stateMarker,
  consentMarker,
  consentBody,
  type LaneState,
} from "../../src/review-state.js";
import { manifestDigest, baselineDigest } from "../../src/review-interface.js";
const H = "a".repeat(40),
  B = "b".repeat(40),
  M = "d".repeat(40);
const policy: GatePolicy = {
  repository: "owner/repo",
  baseBranch: "main",
  codeActor: 11,
  browserActor: 12,
  ciWorkflowId: 100,
  ciJobs: ["Quality", "E2E"],
};
function fixture(): GateSnapshot {
  return {
    pr: {
      state: "open",
      draft: false,
      user: { id: 9 },
      head: { sha: H, ref: "feature/example", repo: { full_name: "contributor/fork" } },
      base: { sha: B, ref: "main", repo: { full_name: "owner/repo" } },
    },
    reviews: [11, 12].map((id) => ({
      id,
      user: { id, type: "Bot" },
      state: "APPROVED",
      commit_id: H,
      body: "Review conclusion",
      submitted_at: "2026-10-05T12:00:00Z",
    })),
    comments: [11, 12].map((id) => ({
      id,
      user: { id, type: "Bot" },
      body: stateBody({
        version: 1,
        repo: "owner/repo",
        pr: 5,
        lane: id === 11 ? "code" : "browser",
        session: `review-${id}`,
        attempt: "a",
        H,
        B,
        evidenceDigest: "c".repeat(64),
        status: "APPROVED",
        reviewId: id,
        assessment: {
          status: "N/A",
          manifest: { version: 1, repository: "owner/repo", baseBranch: "main", surfaces: [] },
          dispositions: [
            {
              path: "internal.ts",
              callers: ["main"],
              surfaceIds: [],
              evidence: ["internal call contract unchanged"],
            },
          ],
        },
      } satisfies LaneState),
    })),
    files: [{ filename: "internal.ts" }],
    unresolved: 0,
    runs: [
      {
        id: 1,
        workflow_id: 100,
        path: ".github/workflows/ci.yml@refs/pull/5/merge",
        repository: { full_name: "owner/repo" },
        event: "pull_request",
        pull_requests: [{ number: 5, head: { sha: H }, base: { sha: B } }],
        head_sha: H,
        head_branch: "feature/example",
        display_title: `Spur CI v1 REF=refs/pull/5/merge M=${M}`,
        run_started_at: "2026-10-05T12:00:00Z",
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
      },
    ],
    jobs: policy.ciJobs.map((name) => ({
      name,
      run_id: 1,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    })),
    ciAnchors: [{ runId: 1, merge: M, parents: [B, H] }],
  };
}
const strictPolicy = {
  ...policy,
  ciJobs: ["Quality", "Playwright E2E", "Runtime Integration", "Real-Agent Smoke"],
};
const equivalentChanges = [
  "pr-order",
  "mergeable-state",
  "updated-at",
  "jobs-order",
  "association-order",
  "noncandidate-updated-at",
  "noncandidate-insert",
  "noncandidate-delete",
  "noncandidate-metadata",
] as const;
function addOtherPr(snapshot: GateSnapshot) {
  snapshot.runs.push({
    ...snapshot.runs[0],
    id: 2,
    head_sha: "e".repeat(40),
    path: ".github/workflows/ci.yml@refs/pull/6/merge",
    display_title: `Spur CI v1 REF=refs/pull/6/merge M=${"e".repeat(40)}`,
    pull_requests: [{ number: 6, head: { sha: "f".repeat(40) }, base: { sha: B } }],
  });
  snapshot.ciAnchors.push({ runId: 2, merge: "e".repeat(40), parents: [B, "f".repeat(40)] });
}
function changeEquivalent(snapshot: GateSnapshot, mode: string) {
  if (mode === "pr-order") snapshot.pr = Object.fromEntries(Object.entries(snapshot.pr).reverse());
  if (mode === "mergeable-state") snapshot.pr.mergeable_state = "blocked";
  if (mode === "updated-at") snapshot.pr.updated_at = "2026-10-06T12:00:00Z";
  if (mode === "jobs-order") snapshot.jobs.reverse();
  if (mode === "association-order") {
    const run = snapshot.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.pull_requests = [{ base: { sha: B }, head: { sha: H }, number: 5 }];
  }
  if (mode === "noncandidate-updated-at") {
    snapshot.runs[1] = { ...snapshot.runs[1], updated_at: "2026-10-07T12:00:00Z" };
  }
  if (mode === "noncandidate-insert") addOtherPr(snapshot);
  if (mode === "noncandidate-delete") {
    snapshot.runs.pop();
    snapshot.ciAnchors.pop();
  }
  if (mode === "noncandidate-metadata") {
    const run = snapshot.runs[1];
    if (!run) throw new Error("missing other PR fixture");
    Object.assign(run, {
      id: 3,
      status: "queued",
      conclusion: null,
      run_attempt: 2,
      run_started_at: "2026-10-07T12:00:00Z",
      updated_at: "2026-10-07T12:00:00Z",
      path: ".github/workflows/ci.yml@refs/pull/7/merge",
      display_title: `Spur CI v1 REF=refs/pull/7/merge M=${"e".repeat(40)}`,
      pull_requests: [{ number: 7, head: { sha: "f".repeat(40) }, base: { sha: B } }],
    });
    snapshot.ciAnchors[1] = { runId: 3, merge: "e".repeat(40), parents: ["f".repeat(40), B] };
  }
}
test.each(equivalentChanges)(
  "approved evidence ignores %s without changing source arrays",
  (mode) => {
    const before = fixture();
    if (
      mode === "noncandidate-delete" ||
      mode === "noncandidate-metadata" ||
      mode === "noncandidate-updated-at"
    )
      addOtherPr(before);
    const after = structuredClone(before);
    changeEquivalent(after, mode);
    const original = structuredClone(after);
    const initial = evaluateSnapshot(policy, 5, before);
    const current = evaluateSnapshot(policy, 5, after);
    expect(initial.status).toBe("APPROVED");
    expect(current).toEqual(initial);
    expect(after).toEqual(original);
  },
);
test.each([
  "attempt",
  "run",
  "job-id",
  "merged",
  "head-repository",
  "review-body",
  "review-time",
  "review-order",
  "lane-attempt",
  "lane-evidence",
  "lane-callers",
  "candidate-transition",
  "association-own-key",
])("approved evidence retains %s identity even when both evaluations approve", (mode) => {
  const before = fixture(),
    after = fixture();
  const run = after.runs[0];
  if (!run) throw new Error("missing fixture run");
  if (mode === "attempt") {
    run.run_attempt = 2;
    after.jobs.forEach((job) => {
      job.run_attempt = 2;
    });
  }
  if (mode === "run") {
    run.id = 2;
    after.jobs.forEach((job) => {
      job.run_id = 2;
    });
    after.ciAnchors[0] = { runId: 2, merge: M, parents: [B, H] };
  }
  if (mode === "job-id") after.jobs[0] = { ...after.jobs[0], id: 50 };
  if (mode === "merged") after.pr.merged = true;
  if (mode === "head-repository")
    after.pr.head = { ...(after.pr.head as object), repo: { full_name: "other/fork" } };
  if (mode === "review-body") after.reviews[0] = { ...after.reviews[0], body: "Different proof" };
  if (mode === "review-time")
    after.reviews[0] = { ...after.reviews[0], submitted_at: "2026-10-05T13:00:00Z" };
  if (mode === "review-order") after.reviews.reverse();
  if (mode === "lane-attempt")
    after.comments[0] = {
      ...after.comments[0],
      body: stateBody({ ...readStateBody(String(after.comments[0]?.body)), attempt: "b" }),
    };
  if (mode === "lane-evidence")
    after.comments[0] = {
      ...after.comments[0],
      body: stateBody({
        ...readStateBody(String(after.comments[0]?.body)),
        evidenceDigest: "d".repeat(64),
      }),
    };
  if (mode === "lane-callers") {
    const state = readStateBody(String(after.comments[0]?.body));
    if (!state.assessment) throw new Error("missing assessment");
    state.assessment.dispositions[0] = {
      ...state.assessment.dispositions[0],
      path: "internal.ts",
      callers: ["other"],
      surfaceIds: [],
      evidence: ["different proof"],
    };
    after.comments[0] = { ...after.comments[0], body: stateBody(state) };
  }
  if (mode === "candidate-transition") {
    addOtherPr(before);
    addOtherPr(after);
    after.runs[1] = { ...after.runs[0], id: 2, run_started_at: "2026-10-04T12:00:00Z" };
    after.ciAnchors[1] = { runId: 2, merge: M, parents: [B, H] };
  }
  if (mode === "association-own-key")
    run.pull_requests = [
      {
        number: 5,
        head: { sha: H },
        base: { sha: B },
        ...Object.fromEntries([
          ["__proto__", "proof"],
          ["constructor", "proof"],
        ]),
      },
    ];
  const initial = evaluateSnapshot(policy, 5, before),
    current = evaluateSnapshot(policy, 5, after);
  expect(initial.status).toBe("APPROVED");
  expect(current.status).toBe("APPROVED");
  expect(current.fingerprint).not.toBe(initial.fingerprint);
});
test("ignored partial native history stays approved and remains evidence", () => {
  const before = fixture(),
    after = fixture();
  after.reviews.push({
    id: 50,
    user: { id: 50 },
    state: "COMMENTED",
    submitted_at: null,
    body: { partial: true },
  });
  const initial = evaluateSnapshot(policy, 5, before),
    current = evaluateSnapshot(policy, 5, after);
  expect(current.status).toBe("APPROVED");
  expect(current.fingerprint).not.toBe(initial.fingerprint);
});
test("association serialization preserves own reserved keys and ignores their insertion order", () => {
  const before = fixture(),
    after = fixture();
  const association = {
    number: 5,
    head: { sha: H },
    base: { sha: B },
    ...Object.fromEntries([
      ["__proto__", "proof"],
      ["constructor", "proof"],
    ]),
  };
  before.runs[0] = { ...before.runs[0], pull_requests: [association] };
  after.runs[0] = {
    ...after.runs[0],
    pull_requests: [Object.fromEntries(Object.entries(association).reverse())],
  };
  expect(evaluateSnapshot(policy, 5, before)).toEqual(evaluateSnapshot(policy, 5, after));
});
test.each([
  "H",
  "B",
  "repository",
  "base-ref",
  "head-ref",
  "closed",
  "draft",
  "author",
  "actor",
  "native-sha",
  "native-type",
  "native-id",
  "lane-status",
  "lane-scope",
  "lane-assessment",
  "workflow",
  "source",
  "active-order",
  "tied-ci-time",
])("security boundary %s remains blocked and cannot match approved evidence", (mode) => {
  const before = fixture(),
    after = fixture();
  if (mode === "H") after.pr.head = { ...(after.pr.head as object), sha: "f".repeat(40) };
  if (mode === "B") after.pr.base = { ...(after.pr.base as object), sha: "f".repeat(40) };
  if (mode === "repository")
    after.pr.base = { ...(after.pr.base as object), repo: { full_name: "other/repo" } };
  if (mode === "base-ref") after.pr.base = { ...(after.pr.base as object), ref: "other" };
  if (mode === "head-ref") after.pr.head = { ...(after.pr.head as object), ref: "other" };
  if (mode === "closed") after.pr.state = "closed";
  if (mode === "draft") after.pr.draft = true;
  if (mode === "author") after.pr.user = { id: 11 };
  if (mode === "actor") after.reviews[0] = { ...after.reviews[0], user: { id: 50, type: "Bot" } };
  if (mode === "native-sha") after.reviews[0] = { ...after.reviews[0], commit_id: "f".repeat(40) };
  if (mode === "native-type")
    after.reviews[0] = { ...after.reviews[0], user: { id: 11, type: "User" } };
  if (mode === "native-id") after.reviews[0] = { ...after.reviews[0], id: 50 };
  if (mode.startsWith("lane-")) {
    const state = readStateBody(String(after.comments[0]?.body));
    if (mode === "lane-status") state.status = "BLOCKED";
    if (mode === "lane-scope") state.repo = "other/repo";
    if (mode === "lane-assessment" && state.assessment) state.assessment.status = "unknown";
    // Raw envelope bypasses outbound validation to exercise the existing gate parser.
    after.comments[0] = { ...after.comments[0], body: `${stateMarker}${JSON.stringify(state)}` };
  }
  if (mode === "workflow") after.runs[0] = { ...after.runs[0], workflow_id: 101 };
  if (mode === "source") after.runs[0] = { ...after.runs[0], event: "push" };
  if (mode === "active-order" || mode === "tied-ci-time") {
    after.runs.push({
      ...after.runs[0],
      id: 2,
      ...(mode === "active-order" ? { status: "queued" } : {}),
    });
    after.ciAnchors.push({ runId: 2, merge: M, parents: [B, H] });
  }
  const initial = evaluateSnapshot(policy, 5, before),
    current = evaluateSnapshot(policy, 5, after);
  expect(current.status).toBe("BLOCKED");
  expect(current.fingerprint).not.toBe(initial.fingerprint);
});
test.each([
  "duplicate",
  "mixed-duplicate",
  "missing-run",
  "missing-attempt",
  "duplicate-anchor",
  "reverse-parents",
  "threads",
  "malformed-history",
  "malformed-lane",
  "newer-native",
  "coverage",
])("blocked %s cannot share the approved fingerprint under row permutations", (mode) => {
  const before = fixture(),
    after = fixture();
  if (mode === "duplicate") after.jobs.push({ ...after.jobs[0] });
  if (mode === "mixed-duplicate") after.jobs[1] = { ...after.jobs[0], conclusion: "failure" };
  if (mode === "missing-run") delete after.jobs[0]?.run_id;
  if (mode === "missing-attempt") delete after.jobs[0]?.run_attempt;
  if (mode === "duplicate-anchor") {
    before.ciAnchors.push({ runId: 1, merge: M, parents: [H, B] });
    after.ciAnchors = [...before.ciAnchors].reverse();
  }
  if (mode === "reverse-parents") after.ciAnchors[0]?.parents.reverse();
  if (mode === "threads") after.unresolved = 1;
  if (mode === "malformed-history")
    after.reviews.push({ ...after.reviews[0], id: 3, submitted_at: "invalid" });
  if (mode === "malformed-lane")
    after.comments[0] = {
      ...after.comments[0],
      body: String(after.comments[0]?.body) + "\ngarbage",
    };
  if (mode === "newer-native")
    after.reviews.push({
      ...after.reviews[0],
      id: 30,
      state: "DISMISSED",
      submitted_at: "2026-10-05T13:00:00Z",
    });
  if (mode === "coverage") after.files.push({ filename: "uncovered.ts" });
  const initial = evaluateSnapshot(policy, 5, before);
  expect(initial.status).toBe("APPROVED");
  for (const jobs of [after.jobs, [...after.jobs].reverse()]) {
    const result = evaluateSnapshot(policy, 5, { ...after, jobs });
    expect(result.status).toBe("BLOCKED");
    expect(result.fingerprint).not.toBe(initial.fingerprint);
  }
});
async function readCiFixture(
  snapshot: GateSnapshot,
  options: {
    commit?: Record<string, unknown> | null;
    attemptMismatch?: boolean;
    runMismatch?: boolean;
    jobFault?: string;
    unavailableCommitStatus?: 403 | 404;
    historicalCommit?: Record<string, unknown>;
    associationMismatch?: boolean;
    threadFault?: "graphql" | "node" | "cursor";
  } = {},
) {
  const paths: string[] = [];
  const api = new GateGitHub("fixture", async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/graphql")
      return Response.json({
        ...(options.threadFault === "graphql" ? { errors: [{ message: "unavailable" }] } : {}),
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: options.threadFault === "node" ? [{ isResolved: null }] : [],
                pageInfo:
                  options.threadFault === "cursor"
                    ? { hasNextPage: true, endCursor: null }
                    : { hasNextPage: false },
              },
            },
          },
        },
      });
    if (path.endsWith("/pulls/5")) return Response.json(snapshot.pr);
    if (path.endsWith("/reviews")) return Response.json(snapshot.reviews);
    if (path.endsWith("/comments")) return Response.json(snapshot.comments);
    if (path.endsWith("/files")) return Response.json(snapshot.files);
    if (path.endsWith("/runs")) return Response.json({ workflow_runs: snapshot.runs });
    if (path.endsWith(`/commits/${M}`)) {
      if (options.commit === null) return new Response("missing", { status: 404 });
      return Response.json(options.commit ?? { sha: M, parents: [{ sha: B }, { sha: H }] });
    }
    if (path.includes("/commits/"))
      return options.historicalCommit
        ? Response.json(options.historicalCommit)
        : new Response("unavailable", { status: options.unavailableCommitStatus ?? 404 });
    const match = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(\/jobs)?$/.exec(path);
    if (match) {
      const run = snapshot.runs.find((value) => value.id === Number(match[1]));
      if (!run) throw new Error("unknown run");
      if (match[3]) {
        const jobs = strictPolicy.ciJobs.map((name) => ({
          name,
          run_id: run.id,
          run_attempt: Number(match[2]),
          status: options.jobFault === "pending" ? "in_progress" : "completed",
          conclusion: options.jobFault ?? "success",
        }));
        if (options.jobFault === "missing") jobs.pop();
        return Response.json({ jobs });
      }
      return Response.json(
        match[2] && options.associationMismatch
          ? { ...run, pull_requests: [] }
          : match[2] && options.attemptMismatch
            ? { ...run, run_attempt: Number(match[2]) + 1 }
            : options.runMismatch
              ? { ...run, head_sha: "f".repeat(40) }
              : run,
      );
    }
    throw new Error("unexpected CI fixture API");
  });
  const fresh = await readGateSnapshot(api, strictPolicy, 5);
  return { result: evaluateSnapshot(strictPolicy, 5, fresh), paths };
}
test.each(["association", "graphql", "node", "cursor"] as const)(
  "reader %s errors cannot be hidden by evidence projection",
  async (mode) => {
    await expect(
      readCiFixture(
        fixture(),
        mode === "association" ? { associationMismatch: true } : { threadFault: mode },
      ),
    ).rejects.toThrow();
  },
);
test.each([
  "fork",
  "dependabot",
  "merge-head",
  "old-B",
  "no-marker",
  "wrong-pr",
  "wrong-head",
  "wrong-branch",
  "wrong-event",
  "wrong-workflow",
  "wrong-repository",
  "old-association",
  "reversed-parents",
  "third-parent",
  "wrong-commit",
  "deleted-commit",
  "missing-time",
  "invalid-time",
  "wrong-attempt",
  "list-run-mismatch",
  "pending",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "missing",
])(
  "historical API provenance %s never substitutes current merge/base or old success",
  async (fault) => {
    const snapshot = fixture();
    snapshot.pr.merge_commit_sha = "e".repeat(40); // A fresh current merge cannot stand in for tested M.
    const run = snapshot.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.pull_requests = [];
    const options: Parameters<typeof readCiFixture>[1] = {};
    if (fault === "dependabot") snapshot.pr.user = { id: 9, login: "dependabot[bot]" };
    if (fault === "merge-head") run.head_sha = M;
    if (fault === "old-B")
      options.commit = { sha: M, parents: [{ sha: "f".repeat(40) }, { sha: H }] };
    if (fault === "no-marker") delete run.display_title;
    if (fault === "wrong-pr") run.display_title = `Spur CI v1 REF=refs/pull/6/merge M=${M}`;
    if (fault === "wrong-head") run.head_sha = "f".repeat(40);
    if (fault === "wrong-branch") run.head_branch = "feature/other";
    if (fault === "wrong-event") run.event = "push";
    if (fault === "wrong-workflow") run.workflow_id = 101;
    if (fault === "wrong-repository") run.repository = { full_name: "other/repo" };
    if (fault === "old-association")
      run.pull_requests = [{ number: 5, head: { sha: H }, base: { sha: "f".repeat(40) } }];
    if (fault === "reversed-parents")
      options.commit = { sha: M, parents: [{ sha: H }, { sha: B }] };
    if (fault === "third-parent")
      options.commit = { sha: M, parents: [{ sha: B }, { sha: H }, { sha: B }] };
    if (fault === "wrong-commit")
      options.commit = { sha: "f".repeat(40), parents: [{ sha: B }, { sha: H }] };
    if (fault === "deleted-commit") options.commit = null;
    if (fault === "missing-time") delete run.run_started_at;
    if (fault === "invalid-time") run.run_started_at = "yesterday";
    if (fault === "wrong-attempt") options.attemptMismatch = true;
    if (fault === "list-run-mismatch") options.runMismatch = true;
    if (["pending", "failure", "cancelled", "skipped", "neutral", "missing"].includes(fault))
      options.jobFault = fault;
    if (["missing-time", "invalid-time", "wrong-attempt", "list-run-mismatch"].includes(fault)) {
      await expect(readCiFixture(snapshot, options)).rejects.toThrow();
      return;
    }
    const { result, paths } = await readCiFixture(snapshot, options);
    expect(result.status).toBe(
      ["fork", "dependabot", "merge-head"].includes(fault) ? "APPROVED" : "BLOCKED",
    );
    expect(paths).not.toContain(`/repos/owner/repo/commits/${snapshot.pr.merge_commit_sha}`);
    if (["fork", "dependabot", "merge-head"].includes(fault)) {
      expect(paths).toContain("/repos/owner/repo/actions/runs/1");
      expect(paths).toContain("/repos/owner/repo/actions/runs/1/attempts/1");
      expect(paths).toContain("/repos/owner/repo/actions/runs/1/attempts/1/jobs");
    }
  },
);
test.each([
  "queued-rerun",
  "running-rerun",
  "old-late-completion",
  "completed-rerun",
  "failed-rerun",
  "skipped-rerun",
  "missing-marker-rerun",
  "markerless-merge-rerun",
  "markerless-missing-merge-rerun",
  "markerless-denied-merge-rerun",
  "tied-start",
])(
  "current-attempt API ordering %s blocks active/ambiguous/newer failed CI without ID or completion fallback",
  async (scenario) => {
    const snapshot = fixture();
    const earlier: Record<string, unknown> = {
      ...snapshot.runs[0],
      pull_requests: [],
      updated_at: "2026-10-05T16:00:00Z",
    };
    const later: Record<string, unknown> = {
      ...earlier,
      id: 2,
      run_started_at: "2026-10-05T13:00:00Z",
      updated_at: "2026-10-05T13:30:00Z",
    };
    snapshot.runs = [earlier, later];
    if (scenario === "old-late-completion") later.status = "in_progress";
    else {
      earlier.run_attempt = 2;
      earlier.run_started_at =
        scenario === "tied-start" ? later.run_started_at : "2026-10-05T14:00:00Z";
      if (scenario === "queued-rerun") earlier.status = "queued";
      if (scenario === "running-rerun") earlier.status = "in_progress";
      if (scenario === "failed-rerun") earlier.conclusion = "failure";
      if (scenario === "skipped-rerun") earlier.conclusion = "skipped";
      if (scenario === "missing-marker-rerun") delete earlier.display_title;
      if (scenario.startsWith("markerless-")) {
        delete earlier.display_title;
        earlier.head_sha = scenario === "markerless-merge-rerun" ? M : "e".repeat(40);
      }
    }
    if (scenario === "tied-start") {
      await expect(readCiFixture(snapshot)).rejects.toThrow("ci-attempt-time-ambiguous");
      return;
    }
    const { result, paths } = await readCiFixture(snapshot, {
      ...(scenario === "markerless-denied-merge-rerun" ? { unavailableCommitStatus: 403 } : {}),
    });
    if (scenario.startsWith("markerless-"))
      expect((await readCiFixture({ ...snapshot, runs: [later] })).result.status).toBe("APPROVED");
    expect(result.status).toBe(scenario === "completed-rerun" ? "APPROVED" : "BLOCKED");
    expect(paths).toContain("/repos/owner/repo/actions/runs/2/attempts/1");
    expect(paths).toContain(
      `/repos/owner/repo/actions/runs/1/attempts/${scenario === "old-late-completion" ? 1 : 2}`,
    );
    if (scenario === "completed-rerun")
      expect(paths).toContain("/repos/owner/repo/actions/runs/1/attempts/2/jobs");
  },
);
test("two actual App approvals and complete N/A coverage permit fork without consent", () => {
  expect(evaluateSnapshot(policy, 5, fixture()).status).toBe("APPROVED");
});
test.each([
  { designated: [], expected: "BLOCKED" },
  { designated: [policy.codeActor], expected: "BLOCKED" },
  { designated: [policy.browserActor], expected: "BLOCKED" },
  { designated: [policy.codeActor, policy.browserActor], expected: "APPROVED" },
])(
  "designated approvals $designated cannot be replaced by two outsiders",
  ({ designated, expected }) => {
    const snapshot = fixture();
    const outsiderReviews = [21, 22].map((id) => ({
      ...snapshot.reviews[0],
      id,
      user: { id, type: "Bot" },
    }));
    snapshot.reviews = [
      ...snapshot.reviews.filter((review) => designated.includes(Number(review.id))),
      ...outsiderReviews,
    ];
    const result = evaluateSnapshot(policy, 5, snapshot);
    expect(result.status).toBe(expected);
    if (expected === "BLOCKED") expect(result.reason).toBe("native-approval-missing");
  },
);
test.each([
  "queued",
  "in_progress",
  "success",
  "failure",
  "native-merge",
  "denied",
  "missing",
  "malformed-parent",
  "extra-parent",
  "wrong-commit",
  "native-current-contradiction",
  "native-old-contradiction",
  "association-contradiction",
])(
  "obsolete historical head %s excludes only proven history and retains uncertain/contradictory blockers",
  async (scenario) => {
    const snapshot = fixture(),
      oldH = "f".repeat(40),
      oldM = "e".repeat(40);
    const oldRun = {
      ...snapshot.runs[0],
      id: 2,
      head_sha: scenario === "native-merge" ? oldM : oldH,
      display_title: `Spur CI v1 REF=refs/pull/5/merge M=${oldM}`,
      run_started_at: "2026-10-05T13:00:00Z",
      pull_requests: [],
      status: ["queued", "in_progress"].includes(scenario) ? scenario : "completed",
      conclusion: scenario === "success" ? "success" : "failure",
    };
    snapshot.runs.push(oldRun);
    const options: Parameters<typeof readCiFixture>[1] = {
      historicalCommit: { sha: oldM, parents: [{ sha: B }, { sha: oldH }] },
    };
    if (["denied", "missing"].includes(scenario)) {
      delete options.historicalCommit;
      options.unavailableCommitStatus = scenario === "denied" ? 403 : 404;
    }
    if (scenario === "malformed-parent")
      options.historicalCommit = { sha: oldM, parents: [{ sha: B }, { sha: "invalid" }] };
    if (scenario === "extra-parent")
      options.historicalCommit = { sha: oldM, parents: [{ sha: B }, { sha: oldH }, { sha: B }] };
    if (scenario === "wrong-commit")
      options.historicalCommit = { sha: M, parents: [{ sha: B }, { sha: oldH }] };
    if (scenario === "native-current-contradiction") oldRun.head_sha = H;
    if (scenario === "native-old-contradiction")
      options.historicalCommit = { sha: oldM, parents: [{ sha: B }, { sha: "c".repeat(40) }] };
    if (scenario === "association-contradiction")
      Object.assign(oldRun, { pull_requests: [{ number: 5, head: { sha: H }, base: { sha: B } }] });
    const { result, paths } = await readCiFixture(snapshot, options);
    expect(result.status).toBe(
      ["queued", "in_progress", "success", "failure", "native-merge"].includes(scenario)
        ? "APPROVED"
        : "BLOCKED",
    );
    if (result.status === "APPROVED")
      expect(paths).toContain("/repos/owner/repo/actions/runs/1/attempts/1/jobs");
  },
);
test.each(["newer-blocker", "missing-time", "tied-time"])(
  "aggregate native chronology %s fails closed despite older review ID",
  (scenario) => {
    const snapshot = fixture();
    snapshot.reviews.push({
      id: 3,
      user: { id: 11, type: "Bot" },
      state: "CHANGES_REQUESTED",
      commit_id: H,
      body: "New blocker",
      submitted_at:
        scenario === "missing-time"
          ? undefined
          : scenario === "tied-time"
            ? "2026-10-05T12:00:00Z"
            : "2026-10-05T12:01:00Z",
    });
    const result = evaluateSnapshot(policy, 5, snapshot);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toBe(
      scenario === "newer-blocker" ? "changes-requested" : "malformed-evidence",
    );
  },
);
test("same-head CI from an older base cannot pass fresh lane attestations", () => {
  const snapshot = fixture();
  snapshot.runs[0] = {
    ...snapshot.runs[0],
    pull_requests: [{ number: 5, head: { sha: H }, base: { sha: "f".repeat(40) } }],
  };
  expect(evaluateSnapshot(policy, 5, snapshot).reason).toBe("ci-not-success");
});
test.each([
  "clean",
  ...equivalentChanges,
  "new-successful-attempt",
  "new-successful-run",
  "moved",
  "read-denied",
  "abort-read",
  "abort-before-write",
  "abort-during-success",
])(
  "producer API fixture %s writes in_progress before evidence and never stale success",
  async (mode) => {
    const snapshot = fixture();
    if (
      mode === "noncandidate-delete" ||
      mode === "noncandidate-metadata" ||
      mode === "noncandidate-updated-at"
    )
      addOtherPr(snapshot);
    const writes: { status: string; conclusion?: string }[] = [];
    const controller = new AbortController();
    const trace = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let reads = 0;
    let jobReads = 0;
    let requestsAfterAbort = 0;
    const transport: typeof fetch = async (url, options) => {
      if (controller.signal.aborted) requestsAfterAbort++;
      const path = new URL(String(url)).pathname;
      if (path === "/graphql")
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        });
      if (path.endsWith("/check-runs") && options?.method === "POST") {
        writes.push(JSON.parse(String(options.body)) as { status: string });
        return Response.json({
          id: 91,
          name: "Spur Approval Gate",
          head_sha: H,
          app: { slug: "github-actions" },
        });
      }
      if (path.endsWith("/check-runs/91")) {
        writes.push(JSON.parse(String(options?.body)) as { status: string; conclusion: string });
        if (mode === "abort-during-success") {
          // The server committed success; losing the response does not undo it.
          expect(writes.at(-1)?.conclusion).toBe("success");
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("lost acknowledgement")),
              { once: true },
            );
            queueMicrotask(() => controller.abort());
          });
        }
        return Response.json({ id: 91 });
      }
      if (path.endsWith("/pulls")) return Response.json([{ number: 5 }]);
      if (path.endsWith("/pulls/5")) {
        reads++;
        if (reads === 3) {
          changeEquivalent(snapshot, mode);
          if (mode === "new-successful-attempt") {
            snapshot.runs[0] = { ...snapshot.runs[0], run_attempt: 2 };
            snapshot.jobs.forEach((job) => {
              job.run_attempt = 2;
            });
          }
          if (mode === "new-successful-run") {
            snapshot.runs[0] = { ...snapshot.runs[0], id: 2 };
            snapshot.jobs.forEach((job) => {
              job.run_id = 2;
            });
          }
        }
        return Response.json(
          mode === "moved" && reads > 2
            ? { ...snapshot.pr, head: { ...(snapshot.pr.head as object), sha: "d".repeat(40) } }
            : snapshot.pr,
        );
      }
      if (path.endsWith("/reviews")) {
        if (mode === "abort-read") controller.abort();
        if (mode === "read-denied") return new Response("denied", { status: 403 });
        return Response.json(snapshot.reviews);
      }
      if (path.endsWith("/comments")) return Response.json(snapshot.comments);
      if (path.endsWith("/files")) return Response.json(snapshot.files);
      if (path.endsWith("/runs")) return Response.json({ workflow_runs: snapshot.runs });
      const runPath = /\/runs\/(\d+)(?:\/attempts\/\d+)?$/.exec(path);
      if (runPath) return Response.json(snapshot.runs.find((run) => run.id === Number(runPath[1])));
      if (path.endsWith(`/commits/${M}`))
        return Response.json({ sha: M, parents: [{ sha: B }, { sha: H }] });
      if (path.endsWith(`/commits/${"e".repeat(40)}`))
        return Response.json({
          sha: "e".repeat(40),
          parents: [{ sha: B }, { sha: "f".repeat(40) }],
        });
      if (path.endsWith("/jobs")) {
        if (++jobReads === 2 && mode === "abort-before-write") controller.abort();
        return Response.json({ jobs: snapshot.jobs });
      }
      throw new Error("unexpected API path");
    };
    const api = new GateGitHub("fixture", transport, controller.signal);
    try {
      if (mode.startsWith("abort-")) {
        await expect(produceGates(api, policy)).rejects.toThrow("gate-reconciliation-timeout");
        expect(requestsAfterAbort).toBe(0);
        expect(writes).toHaveLength(mode === "abort-during-success" ? 2 : 1);
        expect(trace.mock.calls.map(([line]) => String(line)).join("")).not.toContain(
          "completion-confirmed",
        );
        if (mode === "abort-during-success") {
          expect(writes.at(-1)?.conclusion).toBe("success");
          expect(trace.mock.calls.map(([line]) => String(line)).join("")).toContain('"checkId":91');
          expect(trace.mock.calls.map(([line]) => String(line)).join("")).toContain(
            '"outcome":"UNKNOWN"',
          );
        }
      } else {
        if (mode === "read-denied")
          await expect(produceGates(api, policy)).rejects.toThrow("gate-reconciliation-incomplete");
        else await produceGates(api, policy);
        expect(writes[0]?.status).toBe("in_progress");
        expect(writes.at(-1)?.conclusion).toBe(
          mode === "clean" || equivalentChanges.some((change) => change === mode)
            ? "success"
            : "failure",
        );
      }
    } finally {
      trace.mockRestore();
    }
  },
);
test.each(["pending", "failure", "cancelled", "skipped", "neutral", "missing", "stale"])(
  "CI %s never passes",
  (status) => {
    const snapshot = fixture();
    if (status === "missing") snapshot.jobs.pop();
    else if (status === "stale") snapshot.jobs[0] = { ...snapshot.jobs[0], run_attempt: 2 };
    else
      snapshot.jobs[0] = {
        ...snapshot.jobs[0],
        status: status === "pending" ? "in_progress" : "completed",
        conclusion: status,
      };
    expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("BLOCKED");
  },
);
test.each(["PENDING", "BLOCKED"] as const)(
  "newer same-head %s defeats older approvals",
  (status) => {
    const snapshot = fixture();
    snapshot.comments.push({
      id: 99,
      user: { id: 11, type: "Bot" },
      body: stateBody({
        version: 1,
        repo: "owner/repo",
        pr: 5,
        lane: "code",
        session: "code",
        attempt: "new",
        H,
        B,
        status,
        evidenceDigest: "c".repeat(64),
        reviewId: null,
        assessment: null,
      }),
    });
    expect(evaluateSnapshot(policy, 5, snapshot).reason).toBe("lane-state-not-approved");
  },
);
test("malformed newer authenticated state blocks, another actor cannot supersede", () => {
  const snapshot = fixture();
  snapshot.comments.push({ id: 99, user: { id: 11 }, body: "Spur review state v1\nbroken" });
  expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("BLOCKED");
  snapshot.comments[2] = { id: 99, user: { id: 999 }, body: "Spur review state v1\nbroken" };
  expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("APPROVED");
});
test.each(["version", "missing-close", "duplicate"])(
  "newest hidden malformed %s cannot disappear behind legacy approval",
  (fault) => {
    const snapshot = fixture();
    const prior = snapshot.comments[0];
    if (!prior) throw new Error("missing fixture state");
    const value = readStateBody(String(prior.body));
    prior.body = `Spur review state v1\n${JSON.stringify(value)}`;
    const hidden = stateBody({ ...value, status: "PENDING" });
    const body =
      fault === "version"
        ? hidden.replace("state v1", "state v2")
        : fault === "missing-close"
          ? hidden.replace("\n-->", "")
          : `${hidden}\n${hidden}`;
    snapshot.comments.push({ id: 100, user: { id: 11, type: "Bot" }, body });
    expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("BLOCKED");
  },
);
test("missing classification, uncovered paths, unresolved threads and native dismissal block", () => {
  for (const mutate of [
    (snapshot: GateSnapshot) => {
      snapshot.comments.pop();
    },
    (snapshot: GateSnapshot) => {
      snapshot.files.push({ filename: "unknown.ts" });
    },
    (snapshot: GateSnapshot) => {
      snapshot.unresolved = 1;
    },
    (snapshot: GateSnapshot) => {
      snapshot.reviews.push({
        id: 99,
        user: { id: 11 },
        state: "DISMISSED",
        commit_id: H,
        body: "Dismissed",
        submitted_at: "2026-10-05T12:01:00Z",
      });
    },
    (snapshot: GateSnapshot) => {
      snapshot.reviews.push({
        id: 99,
        user: { id: 50 },
        state: "CHANGES_REQUESTED",
        commit_id: H,
        body: "Blocker",
        submitted_at: "2026-10-05T12:01:00Z",
      });
    },
  ]) {
    const snapshot = fixture();
    mutate(snapshot);
    expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("BLOCKED");
  }
});
test.each([
  "history",
  "rejected",
  "task-conflict",
  "malformed-wrong-scope",
  "new-generation",
  "new-challenge",
])("required semantics retain consent %s evidence and validation", (mode) => {
  const snapshot = fixture();
  const manifest = {
    version: 1 as const,
    repository: "owner/repo",
    baseBranch: "main",
    surfaces: [
      { kind: "CLI" as const, id: "example", before: ["old"], after: ["new"], constraints: [] },
    ],
  };
  snapshot.comments = snapshot.comments.map((row) => ({
    ...row,
    body: stateBody({
      ...readStateBody(String(row.body)),
      assessment: {
        status: "required",
        manifest,
        dispositions: [
          {
            path: "internal.ts",
            callers: ["main"],
            surfaceIds: ["example"],
            evidence: ["public semantics observed"],
          },
        ],
      },
    }),
  }));
  expect(evaluateSnapshot(policy, 5, snapshot).reason).toBe("consent-missing");
  const consent = {
    version: 1,
    repo: "owner/repo",
    pr: 5,
    task: "owner",
    branch: "feature/example",
    baseBranch: "main",
    manifestDigest: manifestDigest(manifest),
    baselineDigest: baselineDigest(manifest),
    challenge: "one",
    decision: "approved",
    generation: 1,
  };
  snapshot.comments.push({
    id: 30,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify(consent)}`,
  });
  expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("APPROVED");
  const approved = evaluateSnapshot(policy, 5, snapshot);
  if (mode !== "history") {
    snapshot.comments.push({
      id: 31,
      user: { id: 11, type: "Bot" },
      body: `${consentMarker}${JSON.stringify({
        ...consent,
        generation: 2,
        ...(mode === "rejected" ? { decision: "rejected" } : {}),
        ...(mode === "task-conflict" ? { task: "other" } : {}),
        ...(mode === "malformed-wrong-scope" ? { repo: "other/repo", generation: "invalid" } : {}),
        ...(mode === "new-challenge" ? { challenge: "different" } : {}),
      })}`,
    });
    const current = evaluateSnapshot(policy, 5, snapshot);
    expect(current.status).toBe(
      mode === "new-generation" || mode === "new-challenge" ? "APPROVED" : "BLOCKED",
    );
    expect(current.fingerprint).not.toBe(approved.fingerprint);
    return;
  }
  snapshot.comments.push({
    id: 31,
    user: { id: 11, type: "Bot" },
    body: consentBody({
      ...consent,
      version: 1,
      decision: "revoked",
      generation: 2,
      challenge: "two",
    }),
  });
  snapshot.comments.push({
    id: 32,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify(consent)}`,
  });
  expect(evaluateSnapshot(policy, 5, snapshot).reason).toBe("consent-not-approved");
  expect(evaluateSnapshot(policy, 5, snapshot).fingerprint).not.toBe(approved.fingerprint);
  snapshot.comments.push({
    id: 33,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify({ ...consent, generation: 3, challenge: "three" })}`,
  });
  snapshot.comments.push({
    id: 34,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify({ ...consent, generation: 3, challenge: "three", decision: "revoked" })}`,
  });
  expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("BLOCKED");
  snapshot.comments.push({
    id: 35,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify({ ...consent, generation: 4, challenge: "four" })}`,
  });
  snapshot.comments.push({
    id: 36,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify({ ...consent, generation: 4, challenge: "different" })}`,
  });
  expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("BLOCKED");
  snapshot.comments.push({
    id: 37,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify({ ...consent, generation: 5, challenge: "five" })}`,
  });
  expect(evaluateSnapshot(policy, 5, snapshot).status).toBe("APPROVED");
  expect(evaluateSnapshot(policy, 5, snapshot).fingerprint).not.toBe(approved.fingerprint);
});
