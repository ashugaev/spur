import { describe, expect, it } from "vitest";
import {
  appendedLines,
  evaluateServiceSourceState,
  normalizeLines,
} from "../../src/event-sources/service.js";

describe("normalizeLines", () => {
  it("splits on newlines and keeps non-empty lines", () => {
    expect(normalizeLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("trims trailing whitespace from each line", () => {
    expect(normalizeLines("alpha   \nbeta\t\n")).toEqual(["alpha", "beta"]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(normalizeLines("first\n\n   \nsecond")).toEqual(["first", "second"]);
  });
});

describe("appendedLines", () => {
  it("returns an empty array when next is fully contained in previous tail", () => {
    expect(appendedLines(["a", "b", "c"], ["b", "c"])).toEqual([]);
  });

  it("returns only the new tail when previous and next overlap partially", () => {
    expect(appendedLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
  });

  it("returns next as-is when there is no overlap", () => {
    expect(appendedLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("returns next as-is when previous is empty", () => {
    expect(appendedLines([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns an empty array when next is empty", () => {
    expect(appendedLines(["a", "b"], [])).toEqual([]);
  });
});

describe("evaluateServiceSourceState", () => {
  const config = {
    type: "service" as const,
    runOnStart: false,
    service: "isolated-ui",
    targetKind: "sidecar" as const,
    intervalMs: 2_000,
    tailLines: 200,
    rules: {
      typescript: {
        match: "TS[0-9]+",
        clear: "compiled successfully",
        cooldownMs: 60_000,
      },
    },
  };

  it("emits a rule when appended sidecar output matches", () => {
    const evaluated = evaluateServiceSourceState({
      config,
      previous: {
        serviceId: "isolated-ui",
        lastTailLines: ["ready"],
        rules: { typescript: { active: false } },
      },
      tailLines: ["ready", "TS2339: Property args does not exist"],
      candidateLines: ["TS2339: Property args does not exist"],
      nowMs: 1_000,
    });

    expect(evaluated.matchedRuleIds).toEqual(["typescript"]);
    expect(evaluated.state.rules["typescript"]).toEqual({
      active: true,
      lastAlertAt: "1970-01-01T00:00:01.000Z",
      lastMatch: "TS2339: Property args does not exist",
    });
  });

  it("uses clear patterns to deactivate a rule without emitting", () => {
    const evaluated = evaluateServiceSourceState({
      config,
      previous: {
        serviceId: "isolated-ui",
        lastTailLines: ["TS2339"],
        rules: {
          typescript: {
            active: true,
            lastAlertAt: "1970-01-01T00:00:01.000Z",
            lastMatch: "TS2339",
          },
        },
      },
      tailLines: ["TS2339", "compiled successfully"],
      candidateLines: ["compiled successfully"],
      nowMs: 2_000,
    });

    expect(evaluated.matchedRuleIds).toEqual([]);
    expect(evaluated.state.rules["typescript"]).toEqual({
      active: false,
      lastAlertAt: "1970-01-01T00:00:01.000Z",
    });
  });

  it("suppresses baseline emits while preserving active state", () => {
    const evaluated = evaluateServiceSourceState({
      config,
      previous: null,
      tailLines: ["TS2339"],
      candidateLines: ["TS2339"],
      nowMs: 1_000,
      mode: "suppress",
    });

    expect(evaluated.matchedRuleIds).toEqual([]);
    expect(evaluated.state.rules["typescript"]).toEqual({
      active: true,
      lastMatch: "TS2339",
    });
  });
});
