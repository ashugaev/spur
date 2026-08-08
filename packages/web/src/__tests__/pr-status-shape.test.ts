import { describe, expect, it } from "vitest";
import {
  isPrInfoShape,
  isPrReady,
  parseReviewDecision,
  prInfosEqual,
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
