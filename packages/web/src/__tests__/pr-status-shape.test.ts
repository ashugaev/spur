import { describe, expect, it } from "vitest";
import { isPrInfoShape, parseReviewDecision, prInfosEqual } from "@/lib/pr-status-shape.js";

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
});
