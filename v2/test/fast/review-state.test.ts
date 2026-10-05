import { afterEach, expect, test, vi } from "vitest";
import { GitHubApp } from "../../src/github-app.js";
import {
  consentMarker,
  publishConsentState,
  readStateBody,
  stateBody,
  type ConsentState,
  type LaneState,
} from "../../src/review-state.js";
afterEach(() => vi.restoreAllMocks());
const state: LaneState = {
  version: 1,
  repo: "owner/repo",
  pr: 1,
  session: "review-a",
  attempt: "a",
  lane: "code",
  H: "a".repeat(40),
  B: "b".repeat(40),
  status: "PENDING",
  evidenceDigest: "c".repeat(64),
  reviewId: null,
  assessment: null,
};
test("state marker survives readback with actual session footer", () => {
  expect(readStateBody(stateBody(state))).toEqual(state);
  expect(stateBody(state)).toContain("Written by Spur · review-a");
});
test("malformed reserved records and evidence-free approvals fail", () => {
  expect(() => readStateBody("Spur review state v1\n{broken}")).toThrow();
  expect(() => stateBody({ ...state, status: "APPROVED" })).toThrow();
});
test("shared authority revocation rejects late approval; fresh current requester can approve", async () => {
  const app = new GitHubApp({ appId: 1, keyPath: "unused" }, "owner/repo");
  vi.spyOn(app, "authenticate").mockResolvedValue({
    appId: 1,
    actor: "code[bot]",
    installationId: 1,
    repositoryId: 1,
    permissions: { pull_requests: "write", metadata: "read" },
  });
  const consent: ConsentState = {
    version: 1,
    repo: "owner/repo",
    pr: 5,
    task: "workspace",
    branch: "feature/example",
    baseBranch: "main",
    manifestDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    challenge: "first",
    decision: "approved",
    generation: 1,
  };
  const rows = [
    {
      id: 1,
      body: `${consentMarker}${JSON.stringify({ ...consent, decision: "revoked", generation: 2, challenge: "second" })}`,
      user: { login: "code[bot]" },
    },
  ];
  vi.spyOn(app, "history").mockImplementation(async () => rows);
  const request = vi.spyOn(app, "request").mockImplementation(async (_path, method, payload) => {
    if (method === "POST") {
      const row = {
        id: rows.length + 1,
        body: (payload as { body: string }).body,
        user: { login: "code[bot]" },
      };
      rows.push(row);
      return row;
    }
    return rows.at(-1);
  });
  await expect(publishConsentState(app, consent, "requester-a")).rejects.toThrow(
    "consent-superseded",
  );
  await expect(
    publishConsentState(app, { ...consent, task: "another-workspace", generation: 3 }),
  ).rejects.toThrow("consent-authority-handoff-required");
  expect(request).not.toHaveBeenCalled();
  await publishConsentState(app, { ...consent, generation: 3, challenge: "third" }, "requester-b");
  expect(rows.at(-1)?.body).toContain("Written by Spur · requester-b");
  expect(rows.at(-1)?.body).toContain('"task":"workspace"');
});
