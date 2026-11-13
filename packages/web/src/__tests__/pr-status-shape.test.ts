import { describe, expect, it } from "vitest";
import {
  isPrInfoShape,
  isPrReady,
  parseReviewDecision,
  prInfosEqual,
  prStatusIndicator,
  type PrInfo,
} from "@/lib/pr-status-shape.js";

function makePrInfo(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    state: "open",
    reviewDecision: null,
    ciStatus: null,
    canMerge: true,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
    ...overrides,
  };
}

describe("pr-status-shape", () => {
  it("validates optional native requirement without equating unavailable to none", () => {
    expect(isPrInfoShape(makePrInfo())).toBe(true);
    for (const reviewRequirement of ["required", "none", "unavailable"] as const) {
      expect(isPrInfoShape(makePrInfo({ reviewRequirement }))).toBe(true);
    }
    for (const reviewRequirement of [null, false, "optional"]) {
      expect(isPrInfoShape({ ...makePrInfo(), reviewRequirement })).toBe(false);
    }
    const unknown = makePrInfo({ reviewRequirement: "unavailable" });
    expect(prInfosEqual(unknown, makePrInfo())).toBe(true);
    expect(prInfosEqual(unknown, makePrInfo({ reviewRequirement: "none" }))).toBe(false);
    expect(isPrReady(unknown)).toBe(isPrReady(makePrInfo({ reviewRequirement: "required" })));
  });

  it("accepts legacy or unavailable reviewers and rejects malformed lists", () => {
    expect(isPrInfoShape(makePrInfo())).toBe(true);
    expect(isPrInfoShape(makePrInfo({ reviewers: null }))).toBe(true);
    expect(
      isPrInfoShape(makePrInfo({ reviewers: { approved: ["alice"], changesRequested: [] } })),
    ).toBe(true);
    for (const reviewers of [
      { approved: [1], changesRequested: [] },
      { approved: [] },
      { approved: [""], changesRequested: [] },
    ]) {
      expect(isPrInfoShape({ ...makePrInfo(), reviewers })).toBe(false);
    }
  });

  it("validates optional pending requests and checks", () => {
    const base = { approved: [], changesRequested: [] };
    expect(
      isPrInfoShape(makePrInfo({ reviewers: { ...base, pending: [{ name: "a", team: true }] } })),
    ).toBe(true);
    for (const pending of [[{ name: "", team: false }], [{ name: "a", team: "no" }], "x"]) {
      expect(isPrInfoShape({ ...makePrInfo(), reviewers: { ...base, pending } })).toBe(false);
    }
    for (const checks of [undefined, null, [], [{ name: "a", state: "passed" }]]) {
      expect(isPrInfoShape({ ...makePrInfo(), checks })).toBe(true);
    }
    for (const checks of [[{ name: "a", state: "ok" }], [{ name: "", state: "passed" }], "x"]) {
      expect(isPrInfoShape({ ...makePrInfo(), checks })).toBe(false);
    }
  });

  it("detects pending and check changes, treating legacy undefined as empty", () => {
    const base = { approved: [], changesRequested: [] };
    const a = makePrInfo({ reviewers: base });
    expect(
      prInfosEqual(a, { ...a, reviewers: { ...base, pending: [{ name: "x", team: false }] } }),
    ).toBe(false);
    expect(
      prInfosEqual(
        { ...a, reviewers: { ...base, pending: [{ name: "x", team: false }] } },
        { ...a, reviewers: { ...base, pending: [{ name: "x", team: true }] } },
      ),
    ).toBe(false);
    expect(prInfosEqual(a, { ...a, reviewers: { ...base, pending: [] } })).toBe(true);
    const withCheck = (state: "passed" | "failed") =>
      makePrInfo({ checks: [{ name: "t", state }] });
    expect(prInfosEqual(withCheck("passed"), withCheck("failed"))).toBe(false);
    expect(prInfosEqual(makePrInfo(), makePrInfo({ checks: [] }))).toBe(true);
    expect(prInfosEqual(makePrInfo({ checks: [] }), withCheck("passed"))).toBe(false);
  });

  it("notifies consumers when reviewer names or decisions change without changing readiness", () => {
    const first = makePrInfo({ reviewers: { approved: ["alice"], changesRequested: [] } });
    expect(
      prInfosEqual(first, { ...first, reviewers: { approved: ["alice"], changesRequested: [] } }),
    ).toBe(true);
    expect(
      prInfosEqual(first, { ...first, reviewers: { approved: ["bob"], changesRequested: [] } }),
    ).toBe(false);
    expect(
      prInfosEqual(first, { ...first, reviewers: { approved: [], changesRequested: ["alice"] } }),
    ).toBe(false);
    expect(prInfosEqual(first, { ...first, reviewers: null })).toBe(false);
    expect(isPrReady(first)).toBe(true);
    expect(isPrReady({ ...first, reviewers: { approved: [], changesRequested: ["bob"] } })).toBe(
      true,
    );
  });

  it.each([
    ["success", "approved", { kind: "review", decision: "approved" }],
    ["success", "changes_requested", { kind: "review", decision: "changes_requested" }],
    ["success", "review_required", { kind: "ci", status: "success" }],
    ["failure", "approved", { kind: "ci", status: "failure" }],
    ["pending", "changes_requested", { kind: "ci", status: "pending" }],
    [null, null, { kind: "ci", status: null }],
  ] as const)(
    "shares the displayed dot semantics for %s/%s",
    (ciStatus, reviewDecision, expected) => {
      expect(prStatusIndicator(makePrInfo({ ciStatus, reviewDecision }))).toEqual(expected);
    },
  );
  it("accepts reviewDecision in the PR info shape", () => {
    expect(
      isPrInfoShape({
        state: "open",
        reviewDecision: "approved",
        ciStatus: "success",
        canMerge: true,
        mergeConflict: false,
        totalThreads: 2,
        unresolvedThreads: 0,
      }),
    ).toBe(true);
  });

  it("rejects unknown reviewDecision values", () => {
    expect(
      isPrInfoShape({
        state: "open",
        reviewDecision: "approved-ish",
        ciStatus: "success",
        canMerge: false,
        mergeConflict: false,
        totalThreads: 2,
        unresolvedThreads: 0,
      }),
    ).toBe(false);
  });

  it("rejects PR info missing or non-boolean mergeConflict", () => {
    expect(
      isPrInfoShape({
        state: "open",
        reviewDecision: "approved",
        ciStatus: "success",
        canMerge: true,
        totalThreads: 2,
        unresolvedThreads: 0,
      }),
    ).toBe(false);
    expect(
      isPrInfoShape({
        state: "open",
        reviewDecision: "approved",
        ciStatus: "success",
        canMerge: true,
        mergeConflict: "yes",
        totalThreads: 2,
        unresolvedThreads: 0,
      }),
    ).toBe(false);
  });

  it("normalizes GitHub reviewDecision values to app values", () => {
    expect(parseReviewDecision("APPROVED")).toBe("approved");
    expect(parseReviewDecision("review_required")).toBe("review_required");
    expect(parseReviewDecision("MERGED")).toBeNull();
    expect(parseReviewDecision(null)).toBeNull();
  });

  it("treats reviewDecision as part of equality", () => {
    expect(
      prInfosEqual(
        {
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          canMerge: true,
          mergeConflict: false,
          totalThreads: 2,
          unresolvedThreads: 0,
        },
        {
          state: "open",
          reviewDecision: "review_required",
          ciStatus: "success",
          canMerge: true,
          mergeConflict: false,
          totalThreads: 2,
          unresolvedThreads: 0,
        },
      ),
    ).toBe(false);
  });

  it("treats mergeConflict as part of equality", () => {
    expect(
      prInfosEqual(
        {
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          canMerge: true,
          mergeConflict: false,
          totalThreads: 2,
          unresolvedThreads: 0,
        },
        {
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          canMerge: true,
          mergeConflict: true,
          totalThreads: 2,
          unresolvedThreads: 0,
        },
      ),
    ).toBe(false);
  });

  describe("isPrReady", () => {
    it("is true when mergeable, no unresolved threads, and no review decision", () => {
      expect(
        isPrReady(makePrInfo({ canMerge: true, unresolvedThreads: 0, reviewDecision: null })),
      ).toBe(true);
    });

    it("is true when the review decision is approved", () => {
      expect(isPrReady(makePrInfo({ reviewDecision: "approved" }))).toBe(true);
    });

    it("is true when the review decision is review_required", () => {
      expect(isPrReady(makePrInfo({ reviewDecision: "review_required" }))).toBe(true);
    });

    it("is false when changes were requested", () => {
      expect(isPrReady(makePrInfo({ reviewDecision: "changes_requested" }))).toBe(false);
    });

    it("is false when there are unresolved threads", () => {
      expect(isPrReady(makePrInfo({ unresolvedThreads: 1 }))).toBe(false);
    });

    it("is false when not mergeable", () => {
      expect(isPrReady(makePrInfo({ canMerge: false }))).toBe(false);
    });

    it("does not re-check mergeConflict (unreachable alongside canMerge in practice)", () => {
      expect(isPrReady(makePrInfo({ canMerge: true, mergeConflict: true }))).toBe(true);
    });

    it("does not re-check state", () => {
      expect(isPrReady(makePrInfo({ state: null, canMerge: true, unresolvedThreads: 0 }))).toBe(
        true,
      );
    });

    it("does not hide a failing optional CI check", () => {
      expect(isPrReady(makePrInfo({ ciStatus: "failure", canMerge: true }))).toBe(true);
    });
  });
});
