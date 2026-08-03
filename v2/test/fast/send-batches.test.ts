import { describe, expect, it, vi } from "vitest";
import {
  isGitHubEventData,
  isServiceProblemEventData,
  isTelegramMessageEventData,
  createSendBatchParser,
  restoreSendBatch,
} from "../../src/send-batches.js";
import type { GitHubSignal, ReviewSnapshot } from "../../src/types.js";

vi.mock("../../src/metadata.js", () => ({
  readGitHubSourceSnapshot: vi.fn(),
  readReviewSourceSnapshot: vi.fn(),
}));

// Builds the on-disk/in-memory envelope shape the snapshot readers now return.
function storedSnapshot(signals: GitHubSignal[], prNumber: number | null = 42): ReviewSnapshot {
  return { prNumber, signals: new Map(signals.map((signal) => [signal.key, signal])) };
}

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

function telegramEventData(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "api-1",
    chatId: -100123,
    messageThreadId: 42,
    userId: 7,
    username: "alek",
    messageId: 99,
    text: "fix the failing test",
    ...overrides,
  };
}

function requireBatch<T>(value: T | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
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

describe("isTelegramMessageEventData", () => {
  it("returns true for valid data", () => {
    expect(isTelegramMessageEventData(telegramEventData())).toBe(true);
  });

  it("returns false for missing fields", () => {
    expect(isTelegramMessageEventData({ sessionId: "api-1" })).toBe(false);
  });
});

describe("createSendBatchParser", () => {
  describe("github type", () => {
    it("produces a batch from valid github data", () => {
      const parse = createSendBatchParser("github", "proj", "src-1");
      const batch = parse(githubEventData());
      expect(batch).not.toBeNull();
      expect(requireBatch(batch, "expected github batch").sessionId).toBe("api-1");
    });

    it("returns null for non-github data", () => {
      const parse = createSendBatchParser("github", "proj", "src-1");
      expect(parse(serviceEventData())).toBeNull();
    });
  });

  describe("gitlab type", () => {
    it("produces a batch from valid review data", () => {
      const parse = createSendBatchParser("gitlab", "proj", "src-1");
      const batch = parse(githubEventData());
      expect(batch).not.toBeNull();
      expect(requireBatch(batch, "expected gitlab batch").sessionId).toBe("api-1");
    });

    it("returns null for non-review data", () => {
      const parse = createSendBatchParser("gitlab", "proj", "src-1");
      expect(parse(serviceEventData())).toBeNull();
    });
  });

  describe("service type", () => {
    it("produces a batch from valid service data", () => {
      const parse = createSendBatchParser("service", "proj", "src-1");
      const batch = parse(serviceEventData());
      expect(batch).not.toBeNull();
      expect(requireBatch(batch, "expected service batch").sessionId).toBe("api-1");
    });

    it("returns null for non-service data", () => {
      const parse = createSendBatchParser("service", "proj", "src-1");
      expect(parse(githubEventData())).toBeNull();
    });
  });

  describe("telegram type", () => {
    it("produces a batch from valid telegram data", () => {
      const parse = createSendBatchParser("telegram", "proj", "src-1");
      const batch = parse(telegramEventData());
      expect(batch).not.toBeNull();
      expect(requireBatch(batch, "expected telegram batch").sessionId).toBe("api-1");
    });

    it("returns null for non-telegram data", () => {
      const parse = createSendBatchParser("telegram", "proj", "src-1");
      expect(parse(serviceEventData())).toBeNull();
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

describe("Telegram batch", () => {
  function makeBatch(prompt?: string) {
    const parse = createSendBatchParser("telegram", "proj", "src-1", prompt);
    return requireBatch(parse(telegramEventData()), "expected telegram batch");
  }

  it("format() includes chat, thread, sender, and text", () => {
    const batch = makeBatch();
    const formatted = batch.format();
    expect(formatted).toContain("chat -100123 thread 42");
    expect(formatted).toContain("Source: telegram");
    expect(formatted).toContain('spur source reply "message"');
    expect(formatted).toContain("@alek: fix the failing test");
  });

  it("merge() appends messages", () => {
    const batch = makeBatch();
    const next = createSendBatchParser(
      "telegram",
      "proj",
      "src-1",
    )(
      telegramEventData({
        chatId: -100456,
        messageThreadId: 7,
        username: "maria",
        text: "and rerun build",
      }),
    );
    batch.merge(requireBatch(next, "expected telegram batch update"));
    const formatted = batch.format();
    expect(formatted).toContain("chat -100123 thread 42 @alek: fix the failing test");
    expect(formatted).toContain("chat -100456 thread 7 @maria: and rerun build");
    expect(formatted).toContain("@alek: fix the failing test");
    expect(formatted).toContain("@maria: and rerun build");
  });

  it("format() with custom prompt uses the prompt", () => {
    const batch = makeBatch("Answer this Telegram thread.");
    const formatted = batch.format();
    expect(formatted).toContain("Answer this Telegram thread.");
    expect(formatted).toContain("Source: telegram");
    expect(formatted).not.toContain("Telegram message for this Spur session");
  });
});

describe("GitHub batch", () => {
  function makeBatch(overrides: Record<string, unknown> = {}) {
    const parse = createSendBatchParser("github", "proj", "src-1");
    return requireBatch(parse(githubEventData(overrides)), "expected github batch");
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
    );
    const nextBatch = requireBatch(next, "expected github batch update");
    batch.merge(nextBatch);
    const formatted = batch.format();
    expect(formatted).toContain("#99");
    expect(formatted).toContain("updated title");
    expect(formatted).toContain("CI is red");
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

    const snapshot = storedSnapshot([
      { key: "comment:1", kind: "comment", text: "comment one" },
    ]);
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
    vi.mocked(readGitHubSourceSnapshot).mockReturnValue(storedSnapshot([]));

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
    const batch = requireBatch(parse(githubEventData()), "expected github batch");
    const formatted = batch.format();
    expect(formatted).toContain("Custom instruction");
    expect(formatted).not.toContain("Review the latest GitHub updates");
  });

  it("format() includes PR lifecycle action lines", () => {
    const batch = makeBatch({
      signals: [
        { key: "ready_for_review", kind: "ready_for_review", text: "PR is ready for review." },
        { key: "approved:alice", kind: "approved", text: "alice approved this PR." },
        { key: "merged", kind: "merged", text: "PR #42 was merged." },
        { key: "closed", kind: "closed", text: "PR #42 was closed without merging." },
      ],
    });
    const formatted = batch.format();
    expect(formatted).toContain("The PR is ready for review.");
    expect(formatted).toContain("The PR received an approving review.");
    expect(formatted).toContain("The PR was merged.");
    expect(formatted).toContain("The PR was closed without merging.");
  });
});

describe("GitLab batch", () => {
  function makeBatch(overrides: Record<string, unknown> = {}) {
    const parse = createSendBatchParser("gitlab", "proj", "src-1");
    return requireBatch(parse(githubEventData(overrides)), "expected gitlab batch");
  }

  it("prune() uses the provider-specific snapshot reader", async () => {
    const { readGitHubSourceSnapshot, readReviewSourceSnapshot } =
      await import("../../src/metadata.js");
    vi.mocked(readGitHubSourceSnapshot).mockReset().mockReturnValue(null);
    const snapshot = storedSnapshot([
      { key: "comment:1", kind: "comment", text: "comment one" },
    ]);
    vi.mocked(readReviewSourceSnapshot).mockReset().mockReturnValue(snapshot);

    const batch = makeBatch({
      signals: [
        { key: "comment:1", kind: "comment", text: "comment one" },
        { key: "ci_failed", kind: "ci_failed", text: "CI" },
      ],
    });

    batch.prune("/data");
    const formatted = batch.format();
    expect(formatted).toContain("comment one");
    expect(formatted).not.toContain("CI");
    expect(readReviewSourceSnapshot).toHaveBeenCalledWith(
      "/data",
      "gitlab",
      "proj",
      "src-1",
      "api-1",
    );
    expect(readGitHubSourceSnapshot).not.toHaveBeenCalled();
  });

  it("format() uses GitLab-specific copy", () => {
    const batch = makeBatch({
      signals: [
        { key: "changes_requested", kind: "changes_requested", text: "Changes requested" },
        { key: "merge_conflict", kind: "merge_conflict", text: "Conflicts" },
      ],
    });
    const formatted = batch.format();
    expect(formatted).toContain('GitLab updates on merge request #42 "feat: add tests":');
    expect(formatted).toContain("Review the latest GitLab updates on the active merge request");
    expect(formatted).toContain("Resolve the active merge request merge conflicts");
    expect(formatted).toContain("Use `glab mr view --comments` and `glab ci status`");
  });
});

describe("Service batch", () => {
  function makeBatch(prompt?: string) {
    const parse = createSendBatchParser("service", "proj", "src-1", prompt);
    return requireBatch(parse(serviceEventData()), "expected service batch");
  }

  it("merge() accumulates ruleIds", () => {
    const batch = makeBatch();
    const next = createSendBatchParser(
      "service",
      "proj",
      "src-1",
    )(serviceEventData({ ruleId: "timeout" }));
    batch.merge(requireBatch(next, "expected service batch update"));
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
    )(serviceEventData({ ruleId: "alpha" }));
    batch.merge(requireBatch(next, "expected service batch update"));
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

describe("restoreSendBatch", () => {
  it("round-trips a multi-signal review batch through serialize()", () => {
    const parse = createSendBatchParser("github", "proj", "src-1");
    const batch = requireBatch(
      parse(
        githubEventData({
          signals: [
            { key: "changes_requested", kind: "changes_requested", text: "Changes requested" },
            { key: "merge_conflict", kind: "merge_conflict", text: "Conflicts" },
          ],
        }),
      ),
      "expected github batch",
    );

    const restored = restoreSendBatch(batch.serialize());
    expect(restored).not.toBeNull();
    expect(restored?.format()).toBe(batch.format());
  });

  it("round-trips a review batch's custom prompt", () => {
    const parse = createSendBatchParser("github", "proj", "src-1", "Custom instruction");
    const batch = requireBatch(parse(githubEventData()), "expected github batch");

    const restored = restoreSendBatch(batch.serialize());
    expect(restored?.format()).toBe(batch.format());
    expect(restored?.format()).toContain("Custom instruction");
  });

  it("round-trips a multi-ruleId service batch through serialize()", () => {
    const parse = createSendBatchParser("service", "proj", "src-1");
    const batch = requireBatch(parse(serviceEventData()), "expected service batch");
    const next = requireBatch(
      parse(serviceEventData({ ruleId: "timeout" })),
      "expected service batch update",
    );
    batch.merge(next);

    const restored = restoreSendBatch(batch.serialize());
    expect(restored).not.toBeNull();
    expect(restored?.format()).toBe(batch.format());
  });

  it("round-trips a multi-message telegram batch through serialize()", () => {
    const parse = createSendBatchParser("telegram", "proj", "src-1");
    const batch = requireBatch(parse(telegramEventData()), "expected telegram batch");
    const next = requireBatch(
      parse(telegramEventData({ messageId: 100, text: "one more thing" })),
      "expected telegram batch update",
    );
    batch.merge(next);

    const restored = restoreSendBatch(batch.serialize());
    expect(restored).not.toBeNull();
    expect(restored?.format()).toBe(batch.format());
  });

  it("returns null for an unknown kind", () => {
    expect(restoreSendBatch({ kind: "spawn" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(restoreSendBatch(null)).toBeNull();
  });

  it("returns null for a review payload missing required fields", () => {
    expect(
      restoreSendBatch({
        kind: "review",
        providerId: "github",
        projectId: "proj",
        sourceId: "src-1",
        sessionId: "api-1",
        prNumber: 42,
        // prTitle missing
        signals: [],
      }),
    ).toBeNull();
  });

  it("returns null for a review payload with a bad provider id", () => {
    expect(
      restoreSendBatch({
        kind: "review",
        providerId: "bitbucket",
        projectId: "proj",
        sourceId: "src-1",
        sessionId: "api-1",
        prNumber: 42,
        prTitle: "t",
        signals: [],
      }),
    ).toBeNull();
  });

  it("returns null for a service payload missing ruleIds", () => {
    expect(
      restoreSendBatch({
        kind: "service",
        sessionId: "api-1",
        serviceId: "web",
      }),
    ).toBeNull();
  });

  it("returns null for a service payload with non-string ruleIds", () => {
    expect(
      restoreSendBatch({
        kind: "service",
        sessionId: "api-1",
        serviceId: "web",
        ruleIds: [1, 2],
      }),
    ).toBeNull();
  });

  it("returns null for a telegram payload missing messages", () => {
    expect(
      restoreSendBatch({
        kind: "telegram",
        sessionId: "api-1",
      }),
    ).toBeNull();
  });

  it("returns null for a telegram payload with an invalid message shape", () => {
    expect(
      restoreSendBatch({
        kind: "telegram",
        sessionId: "api-1",
        messages: [{ sessionId: "api-1" }],
      }),
    ).toBeNull();
  });
});
