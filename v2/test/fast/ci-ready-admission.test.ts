import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Script, constants } from "node:vm";
import { expect, test, vi } from "vitest";
import { parse } from "yaml";
import { manifestDigest, baselineDigest, parseAssessment } from "../../src/review-interface.js";
import {
  consentBody,
  stateBody,
  readStateBody,
  readConsentBody,
  type LaneState,
} from "../../src/review-state.js";

type Stage =
  | "quality"
  | "playwright"
  | "runtime-integration"
  | "real-agent-smoke"
  | "gitleaks"
  | "npm-audit"
  | "onboarding-test";
interface AdmissionResult {
  admitted: boolean;
  classification: string;
  reason: string;
  detail?: string;
  waitMs: number;
  requests: number;
}
interface AdmissionInput {
  repository: string;
  policy: typeof policy;
  sourceSha: string;
  defaultBranch: string;
  stage: Stage;
  runId: number;
  attempt: number;
  eventName: string;
  event: ReturnType<typeof fixture>["pr"] extends infer Pr ? { pull_request: Pr } : never;
  codeActor: number;
  browserActor: number;
  token: string;
  remainingMs: number;
  setupRequests: number;
  fetch: typeof fetch;
  now: () => number;
  wallNow: () => number;
  wait: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}
interface Controller {
  STAGES: Record<Stage, { workflow: string; seconds: number; predecessor: string | null }>;
  REQUIRED_CONTEXTS: string[];
  reviewReadiness: (
    value: typeof policy,
    actors: { code: number; browser: number },
    snapshot: ReturnType<typeof fixture>,
  ) => { ready: boolean; reason: string };
  canonicalAssessment: (assessment: unknown) => { manifestDigest: string; baselineDigest: string };
  stageDeadline: (
    stage: Stage,
    run: unknown,
    jobs: unknown[],
    wall: number,
    monotonic: number,
    remaining: number,
  ) => number;
  runAdmission: (input: AdmissionInput) => Promise<AdmissionResult>;
}
const controller: Controller = await import(
  new URL("../../../scripts/ci-ready-admission.mjs", import.meta.url).href
);
const H = "a".repeat(40),
  B = "b".repeat(40),
  OLD_B = "c".repeat(40);
const repository = "ashugaev/spur";
const policy = {
  version: 1,
  repository,
  codeAppId: 5195083,
  browserAppId: 5195109,
  contractDigest: "0bf6dde8891d6599d9c738bd873c07f30a11649e02bb7f35a7e4943320afde6a",
};
const actors = { code: 11, browser: 12 };
const wall = Date.parse("2026-10-15T09:00:00Z");
const iso = (offset = 0) => new Date(wall + offset).toISOString();
function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing fixture value");
  return value;
}

function fixture(number = 2, head = H, base = B) {
  const assessment = parseAssessment({
    status: "required",
    manifest: {
      version: 1,
      repository,
      baseBranch: "main",
      surfaces: [
        {
          kind: "API",
          id: "sessions.list",
          before: ["old"],
          after: ["new"],
          constraints: ["bounded"],
        },
      ],
    },
    dispositions: [
      {
        path: "v2/src/service.ts",
        callers: ["client"],
        surfaceIds: ["sessions.list"],
        evidence: ["observed caller"],
      },
    ],
  });
  const users = {
    code: { id: 11, type: "Bot", login: "spur-code-review[bot]" },
    browser: { id: 12, type: "Bot", login: "spur-ui-tester[bot]" },
  };
  const states: LaneState[] = (["code", "browser"] as const).map((lane, index) => ({
    version: 1,
    lane,
    repo: repository,
    pr: number,
    session: `review-${lane}`,
    attempt: `attempt-${lane}`,
    H: head,
    B: base,
    status: "APPROVED",
    evidenceDigest: "e".repeat(64),
    reviewId: 101 + index,
    assessment,
  }));
  const reviews = states.map((state) => ({
    id: present(state.reviewId),
    user: users[state.lane],
    state: "APPROVED",
    commit_id: head,
    submitted_at: iso(-1000),
    body: `Independent review.\n\nSpur review attempt: ${state.attempt}\nLane: ${state.lane}\nH: ${head}\nB: ${base}\nContractDigest: ${policy.contractDigest}\nStatus: APPROVED\nScenario evidence: []\nCoverage: {}\n\nWritten by Spur · ${state.session}`,
  }));
  const comments = states.map((state, index) => ({
    id: 201 + index,
    user: users[state.lane],
    body: stateBody(state),
    performed_via_github_app: {
      id: state.lane === "code" ? policy.codeAppId : policy.browserAppId,
    },
  }));
  comments.push({
    id: 300,
    user: users.code,
    performed_via_github_app: { id: policy.codeAppId },
    body: consentBody({
      version: 1,
      repo: repository,
      pr: number,
      task: "task",
      branch: `feature/pr-${number}`,
      baseBranch: "main",
      manifestDigest: manifestDigest(assessment.manifest),
      baselineDigest: baselineDigest(assessment.manifest),
      challenge: "challenge",
      decision: "approved",
      generation: 1,
    }),
  });
  return {
    pr: {
      number,
      state: "open",
      draft: false,
      user: { id: 99 },
      head: { sha: head, ref: `feature/pr-${number}`, repo: { id: 1, full_name: repository } },
      base: { sha: base, ref: "main", repo: { id: 1, full_name: repository } },
    },
    reviews,
    comments,
    files: [{ filename: "v2/src/service.ts" }],
    apps: {
      code: { id: policy.codeAppId, slug: "spur-code-review", actorId: 11 },
      browser: { id: policy.browserAppId, slug: "spur-ui-tester", actorId: 12 },
    },
    defaultBranch: "main",
  };
}

test("canonical standalone assessment uses the existing manifest and baseline wire digests", () => {
  const state = readStateBody(present(fixture().comments[0]).body);
  const actual = controller.canonicalAssessment(state.assessment);
  expect(actual.manifestDigest).toBe(manifestDigest(present(state.assessment).manifest));
  expect(actual.baselineDigest).toBe(baselineDigest(present(state.assessment).manifest));
  expect(controller.reviewReadiness(policy, actors, fixture()).ready).toBe(true);
});

const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
  [
    "wrong App",
    (f) => {
      f.apps.code.id = 10;
    },
  ],
  [
    "wrong actor",
    (f) => {
      present(f.reviews[0]).user.id = 17;
    },
  ],
  [
    "human native",
    (f) => {
      present(f.reviews[0]).user.type = "User";
    },
  ],
  [
    "author vote",
    (f) => {
      f.pr.user.id = 11;
    },
  ],
  [
    "same login",
    (f) => {
      present(f.reviews[1]).user.login = present(f.reviews[0]).user.login;
    },
  ],
  [
    "stale H",
    (f) => {
      f.pr.head.sha = "f".repeat(40);
    },
  ],
  [
    "stale B",
    (f) => {
      f.pr.base.sha = "f".repeat(40);
    },
  ],
  [
    "wrong contract",
    (f) => {
      const vote = present(f.reviews[0]);
      vote.body = vote.body.replace(policy.contractDigest, "f".repeat(64));
    },
  ],
  [
    "wrong footer",
    (f) => {
      present(f.reviews[0]).body += "different";
    },
  ],
  [
    "wrong native reviewId",
    (f) => {
      present(f.reviews[0]).id = 999;
    },
  ],
  [
    "dismissed",
    (f) => {
      f.reviews.push({
        ...present(f.reviews[0]),
        id: 999,
        state: "DISMISSED",
        submitted_at: iso(),
      });
    },
  ],
  [
    "latest global changes requested",
    (f) => {
      f.reviews.push({
        ...present(f.reviews[0]),
        id: 999,
        user: { id: 78, login: "other", type: "User" },
        state: "CHANGES_REQUESTED",
        submitted_at: iso(),
      });
    },
  ],
  [
    "same-time ambiguity",
    (f) => {
      f.reviews.push({ ...present(f.reviews[0]), id: 999 });
    },
  ],
  [
    "latest pending marker",
    (f) => {
      const row = present(f.comments[0]);
      f.comments.push({
        ...row,
        id: 999,
        body: stateBody({ ...readStateBody(row.body), status: "PENDING" }),
      });
    },
  ],
  [
    "latest blocked marker",
    (f) => {
      const row = present(f.comments[0]);
      f.comments.push({
        ...row,
        id: 999,
        body: stateBody({ ...readStateBody(row.body), status: "BLOCKED" }),
      });
    },
  ],
  [
    "marker App mismatch",
    (f) => {
      present(f.comments[0]).performed_via_github_app.id = policy.browserAppId;
    },
  ],
  [
    "incomplete file coverage",
    (f) => {
      f.files.push({ filename: "other.ts" });
    },
  ],
  [
    "cross-lane manifest",
    (f) => {
      const row = present(f.comments[1]),
        state = readStateBody(row.body);
      present(present(state.assessment).manifest.surfaces[0]).after = ["different"];
      row.body = stateBody(state);
    },
  ],
  [
    "cross-lane baseline",
    (f) => {
      const row = present(f.comments[1]),
        state = readStateBody(row.body);
      present(present(state.assessment).manifest.surfaces[0]).before = ["different"];
      row.body = stateBody(state);
    },
  ],
  [
    "newer consent generation revoked",
    (f) => {
      const row = present(f.comments[2]),
        state = readConsentBody(row.body);
      f.comments.push({
        ...row,
        id: 400,
        body: consentBody({ ...state, generation: 2, decision: "revoked" }),
      });
    },
  ],
  [
    "same-generation challenge conflict",
    (f) => {
      const row = present(f.comments[2]),
        state = readConsentBody(row.body);
      f.comments.push({
        ...row,
        id: 400,
        body: consentBody({ ...state, challenge: "contradiction" }),
      });
    },
  ],
  [
    "ambiguous state envelope",
    (f) => {
      const row = present(f.comments[0]);
      row.body += `\n${row.body}`;
    },
  ],
  [
    "missing consent",
    (f) => {
      f.comments.pop();
    },
  ],
  [
    "revoked consent",
    (f) => {
      const row = present(f.comments[2]);
      row.body = row.body.replace('"approved"', '"revoked"');
    },
  ],
];
test.each(mutations)(
  "native class rejects %s without producing an aggregate approval",
  (_name, mutate) => {
    const f = fixture();
    mutate(f);
    let ready = false;
    try {
      ready = controller.reviewReadiness(policy, actors, f).ready;
    } catch {
      /* malformed evidence is ordinary */
    }
    expect(ready).toBe(false);
  },
);

type DemandMode =
  | "required"
  | "before-quality"
  | "after-quality"
  | "all-success"
  | "cancelled"
  | "old-head"
  | "old-attempt"
  | "optional-only"
  | "closed";
function harness(
  ownReady = false,
  mode: DemandMode = "required",
  stage: Stage = "quality",
  base = B,
) {
  let time = 0;
  const own = fixture(1, "d".repeat(40), base),
    candidate = fixture(2, H, base);
  if (!ownReady) own.reviews = [];
  if (mode === "closed") candidate.pr.state = "closed";
  const trace: string[] = [];
  const ownRun = {
    id: 10,
    run_attempt: 1,
    event: "pull_request",
    path: `.github/workflows/${controller.STAGES[stage].workflow}`,
    head_sha: own.pr.head.sha,
    head_branch: own.pr.head.ref,
    repository: { id: 1, full_name: repository },
    head_repository: { id: 1, full_name: repository },
    pull_requests: [{ number: 1, head: { sha: own.pr.head.sha }, base: { sha: base } }],
    created_at: iso(),
    status: "in_progress",
    conclusion: null,
  };
  const candidateRun = {
    ...structuredClone(ownRun),
    id: 20,
    workflow_id: 77,
    head_sha: mode === "old-head" ? "f".repeat(40) : H,
    head_branch: candidate.pr.head.ref,
    path: ".github/workflows/ci.yml",
    pull_requests: [{ number: 2, head: { sha: H }, base: { sha: base } }],
  };
  const job = (
    name: string,
    index: number,
    status = "in_progress",
    conclusion: string | null = null,
  ) => ({
    id: 50 + index,
    name,
    run_attempt: 1,
    head_sha: H,
    status,
    conclusion,
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/${50 + index}`,
  });
  let candidateJobs = [job("Quality", 0)];
  if (mode === "before-quality") candidateJobs = [job("quality-admission / Admission", 0)];
  if (mode === "after-quality")
    candidateJobs = [
      job("Quality", 0, "completed", "success"),
      job("playwright-admission / Admission", 1),
    ];
  if (mode === "all-success")
    candidateJobs = controller.REQUIRED_CONTEXTS.map((name, index) =>
      job(name, index, "completed", "success"),
    );
  if (mode === "optional-only") candidateJobs = [job("NPM Audit", 0)];
  if (mode === "cancelled") {
    candidateRun.status = "completed";
    candidateJobs = [job("Quality", 0, "completed", "cancelled")];
  }
  const ownAttempt = structuredClone(ownRun),
    candidateAttempt = structuredClone(candidateRun);
  if (mode === "old-attempt") candidateAttempt.run_attempt = 2;
  let hook: ((path: string) => void) | undefined;
  const transport: typeof fetch = async (url, options) => {
    expect(options?.method).toBe("GET");
    const parsed = new URL(String(url)),
      path = decodeURIComponent(parsed.pathname);
    trace.push(path);
    hook?.(path);
    let data: unknown;
    if (path === `/repos/${repository}/actions/runs/10`) data = ownRun;
    else if (path === `/repos/${repository}/actions/runs/10/attempts/1`) data = ownAttempt;
    else if (path === `/repos/${repository}/actions/runs/10/attempts/1/jobs`)
      data = {
        total_count: 1,
        jobs: [
          {
            name: controller.STAGES[stage].predecessor,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
            completed_at: iso(),
          },
        ],
      };
    else if (path === `/repos/${repository}/actions/runs/20`) data = candidateRun;
    else if (path === `/repos/${repository}/actions/runs/20/attempts/1`) data = candidateAttempt;
    else if (path === `/repos/${repository}/actions/runs/20/attempts/1/jobs`)
      data = { total_count: candidateJobs.length, jobs: candidateJobs };
    else if (path === `/repos/${repository}/actions/workflows/ci.yml`)
      data = { id: 77, path: ".github/workflows/ci.yml" };
    else if (path === `/repos/${repository}/actions/workflows/77/runs`)
      data = { total_count: 1, workflow_runs: [candidateRun] };
    else if (path.startsWith(`/repos/${repository}/check-runs/`)) {
      const current = candidateJobs.find((row) => row.id === Number(path.split("/").at(-1)));
      data = { name: current?.name, head_sha: H, app: { id: 15368 } };
    } else if (path === `/repos/${repository}/pulls`) data = [candidate.pr];
    else if (path === `/repos/${repository}/commits/main`) data = { sha: B };
    else if (path.startsWith("/apps/")) {
      const lane = path.endsWith("spur-code-review") ? "code" : "browser";
      data = { id: candidate.apps[lane].id, slug: candidate.apps[lane].slug };
    } else if (path.startsWith("/users/")) {
      const lane = path.includes("spur-code-review") ? "code" : "browser";
      data = { id: actors[lane], login: `${candidate.apps[lane].slug}[bot]`, type: "Bot" };
    } else {
      const match = new RegExp(
        `^/repos/${repository}/(?:pulls|issues)/(1|2)(?:/(reviews|files|comments))?$`,
      ).exec(path);
      if (!match) throw new Error(`Unexpected GET: ${path}`);
      const f = match[1] === "1" ? own : candidate;
      data =
        match[2] === "reviews"
          ? f.reviews
          : match[2] === "files"
            ? f.files
            : match[2] === "comments"
              ? f.comments
              : f.pr;
    }
    return Response.json(data);
  };
  const input: AdmissionInput = {
    repository,
    policy,
    sourceSha: B,
    defaultBranch: "main",
    stage,
    runId: 10,
    attempt: 1,
    eventName: "pull_request",
    event: { pull_request: structuredClone(own.pr) },
    codeActor: 11,
    browserActor: 12,
    token: "fixture",
    remainingMs: controller.STAGES[stage].seconds * 1000,
    setupRequests: 4,
    fetch: transport,
    now: () => time,
    wallNow: () => wall + time,
    wait: async (ms) => {
      time += ms;
    },
  };
  return {
    input,
    own,
    candidate,
    ownRun,
    ownAttempt,
    candidateRun,
    candidateAttempt,
    trace,
    setHook: (callback: typeof hook) => {
      hook = callback;
    },
    advance: (ms: number) => {
      time += ms;
    },
    finishDemand: () => {
      candidateJobs = controller.REQUIRED_CONTEXTS.map((name, index) =>
        job(name, index, "completed", "success"),
      );
    },
  };
}

test("genuine ready own PR is admitted immediately after final H/B and trusted target reads", async () => {
  const h = harness(true);
  const result = await controller.runAdmission(h.input);
  expect(result.classification).toBe("ready");
  expect(result.waitMs).toBe(0);
  expect(h.trace.at(-1)).toBe(`/repos/${repository}/pulls/1`);
});
test("observed B remains separate from live MAIN; genuine same-B receipts retain scheduling class", async () => {
  expect(
    (await controller.runAdmission(harness(true, "required", "quality", OLD_B).input))
      .classification,
  ).toBe("ready");
});
test.each(["head", "base"] as const)(
  "final %s movement during native collection cannot grant stale priority",
  async (field) => {
    const h = harness(true);
    let reads = 0;
    h.setHook((path) => {
      if (path.endsWith("/pulls/1") && ++reads === 2) h.own.pr[field].sha = "f".repeat(40);
    });
    expect((await controller.runAdmission(h.input)).classification).not.toBe("ready");
  },
);
test.each(["run", "attempt", "event", "id"])(
  "contradictory fork %s metadata is ordinary, never priority",
  async (field) => {
    const h = harness(true);
    if (field === "run") h.ownRun.head_repository.full_name = "fork/repo";
    if (field === "attempt") h.ownAttempt.head_repository.full_name = "fork/repo";
    if (field === "event") h.input.event.pull_request.head.repo.full_name = "fork/repo";
    if (field === "id") h.ownRun.head_repository.id = 2;
    expect((await controller.runAdmission(h.input)).classification).toBe("ordinary");
  },
);
test.each([
  "all-success",
  "cancelled",
  "old-head",
  "old-attempt",
  "optional-only",
  "closed",
] as DemandMode[])("%s candidate cannot create a scheduling hold", async (mode) => {
  const h = harness(false, mode);
  const result = await controller.runAdmission(h.input);
  expect(result.classification).toBe("ordinary");
  expect(result.waitMs).toBe(0);
});
test.each(["required", "before-quality", "after-quality"] as DemandMode[])(
  "%s genuine unfinished demand holds ordinary work and revalidates after completion",
  async (mode) => {
    const h = harness(false, mode);
    h.input.wait = async (ms) => {
      h.advance(ms);
      h.finishDemand();
    };
    const result = await controller.runAdmission(h.input);
    expect(result.classification).toBe("ordinary");
    expect(result.waitMs).toBe(30_000);
    expect(h.trace.filter((path) => path.endsWith("/pulls/2")).length).toBeGreaterThanOrEqual(4);
  },
);
test("holding cannot outlive allocation or request cap, including setup and transport time", async () => {
  const h = harness();
  h.input.remainingMs = 70_000;
  h.setHook(() => h.advance(200));
  const result = await controller.runAdmission(h.input);
  expect(result.waitMs).toBeGreaterThan(0);
  expect(result.waitMs).toBeLessThanOrEqual(70_000);
  expect(result.requests).toBeLessThanOrEqual(96);
});
test("source setup consumed the entire allocation: no metadata request or priority", async () => {
  const h = harness(true);
  h.input.remainingMs = 0;
  const result = await controller.runAdmission(h.input);
  expect(result.classification).toBe("ordinary");
  expect(h.trace).toEqual([]);
});
test("complete pagination reads later revocation; truncated pagination never grants priority", async () => {
  for (const truncated of [false, true]) {
    const h = harness(true);
    const transport = h.input.fetch;
    h.input.fetch = async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/issues/1/comments")) {
        const page = Number(parsed.searchParams.get("page"));
        if (page === 1 || truncated)
          return Response.json(h.own.comments, {
            headers: { link: '<https://api.github.com/next>; rel="next"' },
          });
        const row = present(h.own.comments[2]);
        return Response.json([
          { ...row, id: 999, body: row.body.replace('"approved"', '"revoked"') },
        ]);
      }
      return transport(url, options);
    };
    const result = await controller.runAdmission(h.input);
    expect(result.classification).toBe("ordinary");
    if (truncated) expect(result.detail).toBe("pagination-budget-exhausted");
  }
});
test("revoked demand and trusted MAIN movement are re-read after a hold", async () => {
  const h = harness();
  h.input.wait = async (ms) => {
    h.advance(ms);
    const row = present(h.candidate.comments[2]);
    row.body = row.body.replace('"approved"', '"revoked"');
  };
  expect((await controller.runAdmission(h.input)).waitMs).toBe(30_000);
  const moved = harness(true);
  const transport = moved.input.fetch;
  moved.input.fetch = async (url, options) =>
    String(url).includes("/commits/main")
      ? Response.json({ sha: "f".repeat(40) })
      : transport(url, options);
  expect((await controller.runAdmission(moved.input)).classification).toBe("ordinary");
});
test.each(["workflow", "attempt", "stage"])(
  "wrong caller %s cannot reset allocation or claim readiness",
  async (field) => {
    const h = harness(true);
    if (field === "workflow") h.ownRun.path = ".github/workflows/release.yml";
    if (field === "attempt") h.input.attempt = 2;
    if (field === "stage") h.input.stage = "unknown" as Stage;
    expect((await controller.runAdmission(h.input)).classification).toBe("ordinary");
  },
);
test("concurrent complete controller invocations consume fixed CI and Security shares including setup; restart cannot renew anchors", async () => {
  for (const stages of [
    ["quality", "playwright", "runtime-integration", "real-agent-smoke"],
    ["gitleaks", "npm-audit"],
  ] as Stage[][]) {
    const invocations = stages.map((stage) => {
      const h = harness(false, "required", stage);
      h.advance(20_000);
      h.input.remainingMs -= 20_000;
      return h;
    });
    const results = await Promise.all(invocations.map((h) => controller.runAdmission(h.input)));
    expect(results.reduce((sum, result) => sum + result.waitMs + 20_000, 0)).toBeLessThanOrEqual(
      600_000,
    );
    expect(results.every((result) => result.classification === "ordinary")).toBe(true);
    const restarted = harness(false, "required", stages[0]);
    restarted.advance(controller.STAGES[present(stages[0])].seconds * 1000);
    expect((await controller.runAdmission(restarted.input)).waitMs).toBe(0);
  }
});
test.each([403, 429])(
  "restricted token/status %s degrades without holding or granting priority",
  async (status) => {
    const h = harness(true);
    h.input.fetch = async () => new Response("denied", { status });
    expect((await controller.runAdmission(h.input)).classification).toBe("ordinary");
  },
);
test("non-PR bypass has no fetch; workflow cancellation is not caught as ordinary success", async () => {
  const h = harness();
  h.input.eventName = "push";
  expect((await controller.runAdmission(h.input)).classification).toBe("bypass");
  expect(h.trace).toEqual([]);
  h.input.eventName = "pull_request";
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  h.input.signal = abort.signal;
  await expect(controller.runAdmission(h.input)).rejects.toThrow("cancelled");
});
test("four CI, two Security, one onboarding fixed allocations total at most 600 per attempt", () => {
  const totals = new Map<string, number>();
  for (const entry of Object.values(controller.STAGES))
    totals.set(entry.workflow, (totals.get(entry.workflow) ?? 0) + entry.seconds);
  expect([...totals.values()]).toEqual([600, 600, 600]);
});
test.each(["playwright", "runtime-integration", "real-agent-smoke"] as const)(
  "%s admission deadline anchors to successful Quality in the current attempt",
  (stage) => {
    expect(controller.STAGES[stage].predecessor).toBe("Quality");
    const run = { created_at: iso(-19 * 60_000), run_attempt: 3 };
    const jobs = [
      {
        name: "Quality",
        status: "completed",
        conclusion: "success",
        run_attempt: 3,
        completed_at: iso(),
      },
    ];
    expect(controller.stageDeadline(stage, run, jobs, wall, 0, 150_000)).toBe(150_000);
    expect(controller.stageDeadline(stage, run, jobs, wall + 90_000, 90_000, 150_000)).toBe(
      150_000,
    );
    expect(controller.stageDeadline(stage, run, jobs, wall + 160_000, 160_000, 150_000)).toBe(
      150_000,
    );
    expect(() =>
      controller.stageDeadline(stage, run, [{ ...jobs[0], run_attempt: 2 }], wall, 0, 150_000),
    ).toThrow();
    expect(() => controller.stageDeadline(stage, run, [], wall, 0, 150_000)).toThrow();
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      expect(() =>
        controller.stageDeadline(stage, run, [{ ...jobs[0], conclusion }], wall, 0, 150_000),
      ).toThrow();
    }
  },
);

type Workflow = {
  on: {
    workflow_dispatch?: null;
    push?: { branches: string[] };
    pull_request?: { branches: string[] };
  };
  permissions?: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<
    string,
    {
      name?: string;
      "runs-on"?: string;
      needs?: string | string[];
      if?: string;
      uses?: string;
      "timeout-minutes"?: number;
      env?: { SPUR_BUILD_RESTART?: string; SPUR_TEST_DEPLOY_EXPORT_DIR?: string };
      with?: { stage?: Stage };
      steps?: {
        id?: string;
        uses?: string;
        run?: string;
        env?: { SPUR_TEST_DEPLOY_EXPORT_DIR?: string };
        with?: {
          script?: string;
          ref?: string;
          "persist-credentials"?: boolean;
          name?: string;
          path?: string;
          "if-no-files-found"?: string;
          "compression-level"?: number;
          "retention-days"?: number;
        };
      }[];
    }
  >;
};
async function workflow(name: string): Promise<Workflow> {
  return parse(
    await readFile(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8"),
  ) as Workflow;
}
test("CI preserves dispatch and main pushes while admitting exactly the intended PR bases", async () => {
  const definition = await workflow("ci.yml");
  expect(definition.on).toEqual({
    workflow_dispatch: null,
    push: { branches: ["main"] },
    pull_request: { branches: ["main", "feature/release-continuation"] },
  });
  const branches = present(definition.on.pull_request).branches;
  expect(new Set(branches).size).toBe(branches.length);
  for (const branch of branches) expect(branch).not.toMatch(/[*!?[\]+]/);
});
test.each([
  ["main", true],
  ["feature/release-continuation", true],
  ["feature/native-input-proof", false],
  ["feature/unrelated", false],
  ["feature/release-other", false],
  ["feature/release-continuation-extra", false],
  ["feature/release-continuation/child", false],
  ["prefix/feature/release-continuation", false],
  ["feature/release", false],
])("CI PR base %s admitted=%s", async (base, admitted) => {
  const definition = await workflow("ci.yml");
  expect(present(definition.on.pull_request).branches.includes(base)).toBe(admitted);
});
test("required jobs retain admission, fan out after Quality and preserve readonly permissions", async () => {
  const expected = {
    "ci.yml": ["quality", "playwright", "runtime-integration", "real-agent-smoke"],
    "security.yml": ["gitleaks", "npm-audit"],
    "onboarding-test.yml": ["onboarding-test"],
  };
  for (const [file, ids] of Object.entries(expected)) {
    const definition = await workflow(file);
    expect(
      new Set(
        Object.entries(definition.jobs)
          .filter(([, job]) => job["runs-on"] === "self-hosted")
          .map(([id]) => id),
      ),
    ).toEqual(new Set([...ids, ...(file === "ci.yml" ? ["install-candidate"] : [])]));
    expect(definition.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "read",
    });
    for (const id of ids) {
      const job = present(definition.jobs[id]),
        gate = present(definition.jobs[`${id}-admission`]);
      expect(gate.uses).toBe("./.github/workflows/ci-ready-admission.yml");
      expect(gate.if).toBe("github.event_name == 'pull_request'");
      expect(gate.with?.stage).toBe(id);
      expect([job.needs].flat()).toContain(`${id}-admission`);
      expect(job.if).toContain("!cancelled()");
      expect(job.if).toContain("github.event_name != 'pull_request'");
      expect(job.if).not.toContain("always()");
      if (file === "ci.yml" && id !== "quality") {
        expect(gate.needs).toBe("quality");
        expect(job.needs).toEqual(["quality", `${id}-admission`]);
        expect(job.if).toContain("needs.quality.result == 'success'");
      } else {
        expect(gate.needs).toBeUndefined();
        expect(job.needs).toBe(`${id}-admission`);
      }
    }
  }
  const ci = await workflow("ci.yml");
  expect(
    ["quality", "playwright", "runtime-integration", "real-agent-smoke"].map(
      (id) => present(ci.jobs[id]).name,
    ),
  ).toEqual(["Quality", "Playwright E2E", "Runtime Integration", "Real-Agent Smoke"]);
  for (const name of ["release.yml", "review-approval.yml"])
    expect(JSON.stringify(await workflow(name))).not.toContain("ci-ready-admission");
});

test.each(["ci.yml", "security.yml", "onboarding-test.yml"])(
  "%s cancels superseded PRs and isolates non-PR runs",
  async (file) => {
    const definition = await workflow(file);
    const evaluate = (expression: string, event: string, ref: string, runId: number) =>
      new Script(expression.slice(3, -2)).runInNewContext({
        github: { workflow: file, event_name: event, ref, run_id: runId },
      }) as string | boolean;
    const group = (event: string, ref: string, runId: number) =>
      definition.concurrency.group.replace(/\$\{\{.*?\}\}/g, (expression) =>
        String(evaluate(expression, event, ref, runId)),
      );
    const cancel = (event: string) =>
      evaluate(definition.concurrency["cancel-in-progress"], event, "refs/heads/main", 1);
    expect(group("pull_request", "refs/pull/1/merge", 1)).toBe(
      group("pull_request", "refs/pull/1/merge", 2),
    );
    expect(group("pull_request", "refs/pull/1/merge", 1)).not.toBe(
      group("pull_request", "refs/pull/2/merge", 1),
    );
    expect(cancel("pull_request")).toBe(true);
    for (const event of ["push", "workflow_dispatch", "schedule"]) {
      expect(group(event, "refs/heads/main", 1)).not.toBe(group(event, "refs/heads/main", 2));
      expect(group(event, "refs/heads/main", 1)).not.toBe(
        group("pull_request", "refs/pull/1/merge", 1),
      );
      expect(cancel(event)).toBe(false);
    }
  },
);

test("PR install artifact follows Quality admission and binds the canonical export to exact head", async () => {
  const definition = await workflow("ci.yml");
  const job = present(definition.jobs["install-candidate"]);
  expect(job.if).toBe("github.event_name == 'pull_request'");
  expect(job.needs).toBe("quality");
  expect(present(definition.jobs.quality).needs).toBe("quality-admission");
  expect(job["runs-on"]).toBe("self-hosted");
  expect(job["timeout-minutes"]).toBe(20);
  expect(job.env).toEqual({ SPUR_BUILD_RESTART: "0" });
  const steps = present(job.steps);
  expect(steps[0]).toEqual({
    uses: "actions/checkout@v5",
    with: { ref: "${{ github.event.pull_request.head.sha }}", "persist-credentials": false },
  });
  expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
    "pnpm install --frozen-lockfile",
    'bash scripts/test-deploy.sh\nprintf \'directory=%s\\n\' "$SPUR_TEST_DEPLOY_EXPORT_DIR" >> "$GITHUB_OUTPUT"\n',
  ]);
  expect(steps.find((step) => step.id === "candidate")?.env).toEqual({
    SPUR_TEST_DEPLOY_EXPORT_DIR:
      "${{ runner.temp }}/spur-install-candidate-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  expect(steps.at(-1)).toEqual({
    uses: "actions/upload-artifact@v4",
    with: {
      name: "spur-install-candidate-${{ github.event.pull_request.head.sha }}",
      path: "${{ steps.candidate.outputs.directory }}/manifest.json\n${{ steps.candidate.outputs.directory }}/*.tgz\n",
      "if-no-files-found": "error",
      "compression-level": 0,
      "retention-days": 3,
    },
  });
});

test("install candidate job env rejects runner-only expression contexts", async () => {
  // https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
  const allowed = ["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"];
  const job = present((await workflow("ci.yml")).jobs["install-candidate"]);
  for (const value of Object.values(job.env ?? {})) {
    for (const [, context] of value?.matchAll(/\$\{\{\s*(\w+)\./g) ?? [])
      expect(allowed).toContain(context);
  }
});

async function wrapper(
  mode: "controller404" | "invalid-import" | "stall" | "valid",
  stage: Stage = "quality",
  eventName = "pull_request",
) {
  const definition = await workflow("ci-ready-admission.yml");
  const script = present(present(present(present(definition.jobs.admission).steps)[0]).with).script;
  if (!script) throw new Error("Missing actual wrapper script");
  const outputs = new Map<string, unknown>();
  const summary = { addHeading: () => summary, addCodeBlock: () => summary, write: async () => {} };
  const core = {
    setOutput: (key: string, value: unknown) => outputs.set(key, value),
    info: vi.fn(),
    warning: vi.fn(),
    summary,
  };
  let time = 0,
    aborted = false;
  const transport = vi.fn<typeof fetch>(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === `/repos/${repository}`) return Response.json({ default_branch: "main" });
    if (path.endsWith("/commits/main")) {
      time += mode === "stall" ? controller.STAGES[stage].seconds * 1000 - 1 : 20_000;
      return Response.json({ sha: B });
    }
    if (path.includes("/contents/scripts/")) {
      if (mode === "controller404") return new Response("missing controller", { status: 404 });
      if (mode === "stall")
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("source deadline"));
            },
            { once: true },
          ),
        );
      return new Response(
        mode === "invalid-import"
          ? "this is invalid javascript"
          : "export async function runAdmission(input) { return { classification:'ordinary', reason:'fixture-budget', remainingMs:input.remainingMs, setupRequests:input.setupRequests }; }",
      );
    }
    if (path.includes("/contents/.github/")) return new Response(JSON.stringify(policy));
    throw new Error(`Unexpected wrapper GET ${path}`);
  });
  await new Script(`(async () => {${script}\n})()`, {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInNewContext({
    core,
    context: { payload: {} },
    require: createRequire(import.meta.url),
    fetch: transport,
    Buffer,
    AbortSignal,
    performance: { now: () => time },
    process: {
      env: {
        ADMISSION_STAGE: stage,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REPOSITORY: repository,
        ADMISSION_TOKEN: "fixture",
        GITHUB_RUN_ID: "10",
        GITHUB_RUN_ATTEMPT: "1",
      },
    },
  });
  return { outputs, core, transport, aborted };
}
async function realChild(
  gate: "success" | "failure" | "cancelled" | "skipped",
  event: string,
  cancelled: boolean,
  predecessor = "success",
  jobId = "playwright",
) {
  const definition = await workflow("ci.yml");
  const condition = present(present(definition.jobs[jobId]).if)
    .slice(3, -2)
    .replace(/needs\.([\w-]+)\.result/g, 'needs["$1"].result');
  return new Script(condition).runInNewContext({
    cancelled: () => cancelled,
    github: { event_name: event },
    needs: { quality: { result: predecessor }, [`${jobId}-admission`]: { result: gate } },
  }) as boolean;
}
test.each(["playwright", "runtime-integration", "real-agent-smoke"])(
  "%s requires Quality and its own PR admission without sibling dependencies",
  async (jobId) => {
    expect(await realChild("success", "pull_request", false, "success", jobId)).toBe(true);
    for (const state of ["failure", "cancelled", "skipped"] as const) {
      expect(await realChild(state, "pull_request", false, "success", jobId)).toBe(false);
      expect(await realChild("success", "pull_request", false, state, jobId)).toBe(false);
    }
    for (const event of ["push", "workflow_dispatch"]) {
      expect(await realChild("skipped", event, false, "success", jobId)).toBe(true);
      for (const state of ["failure", "cancelled", "skipped"] as const) {
        expect(await realChild("skipped", event, false, state, jobId)).toBe(false);
      }
    }
    expect(await realChild("success", "pull_request", true, "success", jobId)).toBe(false);
  },
);
test.each(["controller404", "invalid-import", "stall"] as const)(
  "actual wrapper %s finishes degraded admission and permits real child execution",
  async (mode) => {
    const result = await wrapper(mode);
    expect(result.outputs.get("classification")).toBe("ordinary");
    expect(result.core.info).toHaveBeenCalledWith(expect.stringContaining("degraded-bootstrap"));
    const child = vi.fn();
    if (await realChild("success", "pull_request", false)) child();
    expect(child).toHaveBeenCalledOnce();
    expect(result.transport.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.aborted).toBe(mode === "stall");
  },
);
test("actual wrappers charge source setup across concurrent CI/Security invocations; publishers bypass source fetch", async () => {
  for (const stages of [
    ["quality", "playwright", "runtime-integration", "real-agent-smoke"],
    ["gitleaks", "npm-audit"],
  ] as Stage[][]) {
    const results = await Promise.all(stages.map((stage) => wrapper("valid", stage)));
    const remaining = results.reduce((sum, result) => {
      const output = JSON.parse(String(result.core.info.mock.calls[0]?.[0])) as {
        remainingMs: number;
        setupRequests: number;
      };
      expect(output.setupRequests).toBe(4);
      return sum + output.remainingMs + 20_000;
    }, 0);
    expect(remaining).toBe(600_000);
  }
  const bypass = await wrapper("valid", "quality", "push");
  expect(bypass.outputs.get("classification")).toBe("bypass");
  expect(bypass.transport).not.toHaveBeenCalled();
  expect(await realChild("failure", "pull_request", false)).toBe(false);
  expect(await realChild("cancelled", "pull_request", false)).toBe(false);
  expect(await realChild("success", "pull_request", true)).toBe(false);
  expect(await realChild("skipped", "push", false)).toBe(true);
  expect(await realChild("success", "pull_request", false, "failure")).toBe(false);
});
