import { expect, test } from "vitest";
import {
  evaluateSnapshot,
  GateGitHub,
  type GateSnapshot,
  type GatePolicy,
} from "../../src/review-gate.js";
import { produceGates } from "../../src/review-gate-producer.js";
import { stateBody, readStateBody, consentMarker, type LaneState } from "../../src/review-state.js";
import { manifestDigest, baselineDigest } from "../../src/review-interface.js";
const H = "a".repeat(40),
  B = "b".repeat(40);
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
    mergeParents: [],
  };
}
test("two actual App approvals and complete N/A coverage permit fork without consent", () => {
  expect(evaluateSnapshot(policy, 5, fixture()).status).toBe("APPROVED");
});
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
test.each(["clean", "moved", "read-denied"])(
  "producer API fixture %s writes in_progress before evidence and never stale success",
  async (mode) => {
    const snapshot = fixture();
    const writes: { status: string; conclusion?: string }[] = [];
    let reads = 0;
    const api = new GateGitHub("fixture", async (url, options) => {
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
        return Response.json({ id: 91 });
      }
      if (path.endsWith("/pulls")) return Response.json([{ number: 5 }]);
      if (path.endsWith("/pulls/5")) {
        reads++;
        return Response.json(
          mode === "moved" && reads > 2
            ? { ...snapshot.pr, head: { ...(snapshot.pr.head as object), sha: "d".repeat(40) } }
            : snapshot.pr,
        );
      }
      if (path.endsWith("/reviews")) {
        if (mode === "read-denied") return new Response("denied", { status: 403 });
        return Response.json(snapshot.reviews);
      }
      if (path.endsWith("/comments")) return Response.json(snapshot.comments);
      if (path.endsWith("/files")) return Response.json(snapshot.files);
      if (path.endsWith("/runs")) return Response.json({ workflow_runs: snapshot.runs });
      if (path.endsWith("/jobs")) return Response.json({ jobs: snapshot.jobs });
      throw new Error("unexpected API path");
    });
    if (mode === "read-denied")
      await expect(produceGates(api, policy)).rejects.toThrow("gate-http-403");
    else await produceGates(api, policy);
    expect(writes[0]?.status).toBe("in_progress");
    expect(writes.at(-1)?.conclusion).toBe(
      mode === "clean" ? "success" : mode === "moved" ? "failure" : undefined,
    );
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
test("required semantics need matching consent; internal same-file edits reuse approved version, revocation outranks late older write", () => {
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
  snapshot.comments.push({
    id: 31,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify({ ...consent, decision: "revoked", generation: 2, challenge: "two" })}`,
  });
  snapshot.comments.push({
    id: 32,
    user: { id: 11, type: "Bot" },
    body: `${consentMarker}${JSON.stringify(consent)}`,
  });
  expect(evaluateSnapshot(policy, 5, snapshot).reason).toBe("consent-not-approved");
});
