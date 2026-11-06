import type { ReviewFeedback } from "../../src/review-state.js";

export const plan: ReviewFeedback = {
  kind: "plan",
  reason: "Review current changes",
  check: "Named boundary checks and changed-code inspection",
  observed: "Checks not run yet",
  expected: "Supported behavior passes",
  evidence: "Pending execution",
  action: "Run intended checks and inspect results",
  actor: "Assigned reviewer",
};
export const capability: ReviewFeedback = {
  ...plan,
  kind: "capability",
  constraint: "environment",
  reason: "Required fixture unavailable",
  observed: "Fixture startup returned connection refused",
  unproven: "Code attribution and supported behavior remain unproven",
  action: "Restore fixture and rerun named check",
  actor: "Fixture operator and reviewer",
};
export const defect: ReviewFeedback = {
  ...plan,
  kind: "defect",
  reason: "Confirmed failure in changed boundary",
  observed: "Named check returned wrong supported result",
  evidence: "Reproduction and attributable failed assertion",
  action: "Fix changed result and rerun named check",
  actor: "PR author",
};
