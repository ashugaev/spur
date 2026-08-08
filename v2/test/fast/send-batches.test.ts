import { describe, expect, it, vi } from "vitest";
import {
  isGitHubEventData,
  isServiceProblemEventData,
  createSendBatchParser,
} from "../../src/send-batches.js";
import type { GitHubSignal } from "../../src/types.js";

vi.mock("../../src/metadata.js", () => ({
  readGitHubSourceSnapshot: vi.fn(),
}));

function githubEventData(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "api-1",
    prNumber: 42,
    prTitle: "feat: add tests",
    signals: [{ key: "comment:1", kind: "comment", text: "New comment from user" }],
    ...overrides,
  };
}

function serviceEventData(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "api-1",
    serviceId: "web",
    ruleId: "crash",
    ...overrides,
  };
}

describe("isGitHubEventData", () => {
  it("returns true for valid data", () => {
    expect(isGitHubEventData(githubEventData())).toBe(true);
  });

  it("returns false for null", () => {
    expect(isGitHubEventData(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isGitHubEventData(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isGitHubEventData("not an object")).toBe(false);
  });

  it("returns false for missing fields", () => {
    expect(isGitHubEventData({ sessionId: "x" })).toBe(false);
  });

  it("returns false when signals is not an array", () => {
    expect(
      isGitHubEventData({ sessionId: "x", prNumber: 1, prTitle: "t", signals: "not-array" }),
    ).toBe(false);
  });
});

describe("isServiceProblemEventData", () => {
  it("returns true for valid data", () => {
    expect(isServiceProblemEventData(serviceEventData())).toBe(true);
  });

  it("returns false for null", () => {
    expect(isServiceProblemEventData(null)).toBe(false);
  });

  it("returns false for missing fields", () => {
    expect(isServiceProblemEventData({ sessionId: "x" })).toBe(false);
  });
});

describe("createSendBatchParser", () => {
  describe("github type", () => {
    it("produces a batch from valid github data", () => {
      const parse = createSendBatchParser("github", "proj", "src-1");
      const batch = parse(githubEventData());
      expect(batch).not.toBeNull();
      expect(batch!.sessionId).toBe("api-1");
    });

    it("returns null for non-github data", () => {
      const parse = createSendBatchParser("github", "proj", "src-1");
      expect(parse(serviceEventData())).toBeNull();
    });
  });

  describe("service type", () => {
    it("produces a batch from valid service data", () => {
      const parse = createSendBatchParser("service", "proj", "src-1");
      const batch = parse(serviceEventData());
      expect(batch).not.toBeNull();
      expect(batch!.sessionId).toBe("api-1");
    });

    it("returns null for non-service data", () => {
      const parse = createSendBatchParser("service", "proj", "src-1");
      expect(parse(githubEventData())).toBeNull();
    });
  });

  describe("unknown type", () => {
    it("always returns null", () => {
      const parse = createSendBatchParser("cron", "proj", "src-1");
      expect(parse(githubEventData())).toBeNull();
      expect(parse(serviceEventData())).toBeNull();
    });
  });
});

describe("GitHub batch", () => {
  function makeBatch(overrides: Record<string, unknown> = {}) {
    const parse = createSendBatchParser("github", "proj", "src-1");
    return parse(githubEventData(overrides))!;
  }

  it("merge() updates signals, prNumber, and prTitle", () => {
    const batch = makeBatch();
    const next = createSendBatchParser(
      "github",
      "proj",
      "src-1",
    )(
      githubEventData({
        prNumber: 99,
        prTitle: "updated title",
        signals: [{ key: "ci_failed", kind: "ci_failed", text: "CI is red" }],
      }),
    )!;
    batch.merge(next);
    const formatted = batch.format();
    expect(formatted).toContain("#99");
    expect(formatted).toContain("updated title");
    expect(formatted).toContain("CI is red");
    expect(formatted).toContain("New comment from user");
  });

  it("merge() replaces a signal with the same key instead of duplicating it", () => {
    const batch = makeBatch();
    const next = createSendBatchParser(
      "github",
      "proj",
      "src-1",
    )(
      githubEventData({
        signals: [{ key: "comment:1", kind: "comment", text: "edited comment" }],
      }),
    )!;
    batch.merge(next);
    const formatted = batch.format();
    expect(formatted).toContain("edited comment");
    expect(formatted).not.toContain("New comment from user");
    expect(formatted.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });

  it("prune() removes signals not in snapshot", async () => {
    const { readGitHubSourceSnapshot } = await import("../../src/metadata.js");
    const mock = vi.mocked(readGitHubSourceSnapshot);

    const batch = makeBatch({
      signals: [
        { key: "comment:1", kind: "comment", text: "comment one" },
        { key: "ci_failed", kind: "ci_failed", text: "CI" },
      ],
    });

    const snapshot = new Map<string, GitHubSignal>();
    snapshot.set("comment:1", { key: "comment:1", kind: "comment", text: "comment one" });
    mock.mockReturnValue(snapshot);

    batch.prune("/data");
    const formatted = batch.format();
    expect(formatted).toContain("comment one");
    expect(formatted).not.toContain("CI");
  });

  it("prune() with null snapshot removes all signals", async () => {
    const { readGitHubSourceSnapshot } = await import("../../src/metadata.js");
    vi.mocked(readGitHubSourceSnapshot).mockReturnValue(null);

    const batch = makeBatch();
    batch.prune("/data");
    expect(batch.isEmpty()).toBe(true);
  });

  it("isEmpty() returns true after prune with no remaining signals", async () => {
    const { readGitHubSourceSnapshot } = await import("../../src/metadata.js");
    vi.mocked(readGitHubSourceSnapshot).mockReturnValue(new Map());

    const batch = makeBatch();
    batch.prune("/data");
    expect(batch.isEmpty()).toBe(true);
  });

  it("format() includes PR number, title, and signal texts", () => {
    const batch = makeBatch();
    const formatted = batch.format();
    expect(formatted).toContain("#42");
    expect(formatted).toContain("feat: add tests");
    expect(formatted).toContain("New comment from user");
  });

  it("format() without custom prompt includes kind-specific action lines", () => {
    const batch = makeBatch({
      signals: [
        { key: "changes_requested", kind: "changes_requested", text: "Changes requested" },
        { key: "ci_failed", kind: "ci_failed", text: "CI failing" },
        { key: "merge_conflict", kind: "merge_conflict", text: "Conflicts" },
        { key: "comment:1", kind: "comment", text: "A comment" },
      ],
    });
    const formatted = batch.format();
    expect(formatted).toContain("Address the requested review changes");
    expect(formatted).toContain("Inspect the failing checks");
    expect(formatted).toContain("Resolve the active PR merge conflicts");
    expect(formatted).toContain("Read the latest PR comments");
  });

  it("format() with custom prompt uses the prompt instead of action lines", () => {
    const parse = createSendBatchParser("github", "proj", "src-1", "Custom instruction");
    const batch = parse(githubEventData())!;
    const formatted = batch.format();
    expect(formatted).toContain("Custom instruction");
    expect(formatted).not.toContain("Review the latest GitHub updates");
  });
});

describe("Service batch", () => {
  function makeBatch(prompt?: string) {
    const parse = createSendBatchParser("service", "proj", "src-1", prompt);
    return parse(serviceEventData())!;
  }

  it("merge() accumulates ruleIds", () => {
    const batch = makeBatch();
    const next = createSendBatchParser(
      "service",
      "proj",
      "src-1",
    )(serviceEventData({ ruleId: "timeout" }))!;
    batch.merge(next);
    const formatted = batch.format();
    expect(formatted).toContain("crash");
    expect(formatted).toContain("timeout");
  });

  it("format() includes serviceId and sorted ruleIds", () => {
    const batch = makeBatch();
    const next = createSendBatchParser(
      "service",
      "proj",
      "src-1",
    )(serviceEventData({ ruleId: "alpha" }))!;
    batch.merge(next);
    const formatted = batch.format();
    expect(formatted).toContain("web");
    expect(formatted).toContain("Triggered rules: alpha, crash");
  });

  it("format() with custom prompt uses the prompt", () => {
    const batch = makeBatch("Fix the service now");
    const formatted = batch.format();
    expect(formatted).toContain("Fix the service now");
    expect(formatted).not.toContain("has a problem");
  });
});
