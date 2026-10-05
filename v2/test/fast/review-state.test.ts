import { expect, test } from "vitest";
import { readStateBody, stateBody, type LaneState } from "../../src/review-state.js";
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
