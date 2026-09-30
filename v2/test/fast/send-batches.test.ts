import { describe, expect, it, vi } from "vitest";
import {
  isGitHubEventData,
  isServiceProblemEventData,
  isTelegramMessageEventData,
  createSendBatchParser,
  restoreSendBatch,
} from "../../src/send-batches.js";
import type { GitHubSignal, ReviewSnapshot } from "../../src/types.js";
import type * as ghModule from "../../src/gh.js";
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));
vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));

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

describe("live submission identity", () => {
  const parse = createSendBatchParser("github", "api", "pr-watch");
  const url = "https://git.example.com/acme/api/pull/42";
  const binding = { number: 42, repo: "acme/api", url };
  it("round-trips authoritative URL and overlays only the submission with stable daemon cwd", async () => {
    ghMock.mockReset().mockResolvedValue(JSON.stringify({ body: "current" }));
    const queue = requireBatch(parse(githubEventData({ prUrl: url, repo: "acme/api" })), "queue");
    const original = queue.retryItems();
    const submission = requireBatch(
      restoreSendBatch(structuredClone(queue.serialize())),
      "submission",
    );
    expect(
      await submission.refresh?.("/tmp/daemon-data", {
        ...binding,
        url: "https://other.example/acme/api/pull/42",
      }),
    ).toMatchObject([{ status: "live" }]);
    expect(queue.retryItems()).toEqual(original);
    expect(queue.format()).toContain("New comment from user");
    expect(submission.format()).toContain("current");
    expect(submission.serialize()).toMatchObject({ prUrl: url });
    expect(ghMock).toHaveBeenCalledWith(
      "/tmp/daemon-data",
      "api",
      "repos/acme/api/issues/comments/1",
      "--hostname",
      "git.example.com",
      "--cache",
      "0s",
    );
  });

  it.each(["host", "repo", "number"])(
    "retires the outgoing namespace on %s replacement",
    (change) => {
      const queue = requireBatch(parse(githubEventData({ prUrl: url, repo: "acme/api" })), "queue");
      const incoming = requireBatch(
        parse(
          githubEventData({
            prUrl:
              change === "host"
                ? "https://new.example/acme/api/pull/42"
                : change === "repo"
                  ? "https://git.example.com/other/api/pull/42"
                  : "https://git.example.com/acme/api/pull/43",
            repo: change === "repo" ? "other/api" : "acme/api",
            prNumber: change === "number" ? 43 : 42,
            signals: [{ key: "comment:2", kind: "comment", text: "incoming" }],
          }),
        ),
        "incoming",
      );
      expect(queue.merge(incoming)).toEqual({ retiredItemPrefix: '["github",42,' });
      expect(queue.retryItems().map((item) => item.key)).toEqual(["comment:2"]);
    },
  );

  it("preserves known identity and same-context descriptors when incoming metadata is absent", () => {
    const queue = requireBatch(parse(githubEventData({ prUrl: url, repo: "acme/api" })), "queue");
    expect(queue.merge(requireBatch(parse(githubEventData()), "incoming"))).toBeUndefined();
    expect(queue.serialize()).toMatchObject({ prUrl: url, repo: "acme/api" });
  });

  it.each(["URL to repo", "repo to URL"])(
    "replaces conflicting partial identity: %s",
    async (shape) => {
      ghMock.mockReset().mockResolvedValue(JSON.stringify({ body: "current new context" }));
      const queue = requireBatch(
        parse(githubEventData(shape === "URL to repo" ? { prUrl: url } : { repo: "acme/api" })),
        "queue",
      );
      queue.attachAutoPing({
        occurrenceId: "old",
        routeFingerprint: "route",
        destination: { kind: "session", sessionId: "api-1" },
        createGrant: () => "old-handle",
      });
      const newUrl = "https://new.example/other/api/pull/42";
      const incoming = requireBatch(
        parse(
          githubEventData({
            ...(shape === "URL to repo" ? { repo: "other/api" } : { prUrl: newUrl }),
            signals: [{ key: "comment:2", kind: "comment", text: "new context" }],
          }),
        ),
        "incoming",
      );
      expect(queue.merge(incoming)).toEqual({ retiredItemPrefix: '["github",42,' });
      expect(queue.retryItems().map((item) => item.key)).toEqual(["comment:2"]);
      expect(queue.serialize().autoPing?.items["comment:1"]).toBeUndefined();
      if (shape === "URL to repo") {
        expect(queue.serialize()).not.toHaveProperty("prUrl");
        const unresolved = requireBatch(parse(queue.serialize()), "unresolved");
        expect(await unresolved.refresh?.("/tmp/daemon-data")).toMatchObject([
          { status: "failed" },
        ]);
        expect(ghMock).not.toHaveBeenCalled();
      }
      expect(
        await queue.refresh?.("/tmp/daemon-data", { number: 42, repo: "other/api", url: newUrl }),
      ).toMatchObject([{ status: "live" }]);
      expect(queue.serialize()).toMatchObject({ repo: "other/api", prUrl: newUrl });
      expect(ghMock).toHaveBeenCalledWith(
        "/tmp/daemon-data",
        "api",
        "repos/other/api/issues/comments/2",
        "--hostname",
        "new.example",
        "--cache",
        "0s",
      );
    },
  );

  it.each(["URL to repo", "repo to URL"])("preserves compatible partial identity: %s", (shape) => {
    const queue = requireBatch(
      parse(githubEventData(shape === "URL to repo" ? { prUrl: url } : { repo: "ACME/api" })),
      "queue",
    );
    const original = queue.retryItems();
    const incoming = requireBatch(
      parse(
        githubEventData({
          ...(shape === "URL to repo" ? { repo: "ACME/api" } : { prUrl: url }),
          signals: [{ key: "comment:2", kind: "comment", text: "compatible" }],
        }),
      ),
      "incoming",
    );
    expect(queue.merge(incoming)).toBeUndefined();
    expect(queue.serialize()).toMatchObject({ prUrl: url });
    expect(queue.retryItems().slice(0, 1)).toEqual(original);
    expect(queue.retryItems().map((item) => item.key)).toEqual(["comment:1", "comment:2"]);
  });

  it.each(["missing", "number", "repo", "credentials", "malformed"])(
    "fails %s identity with zero requests",
    async (problem) => {
      ghMock.mockReset();
      const queue = requireBatch(
        parse(
          githubEventData({
            repo: "acme/api",
            ...(problem === "credentials"
              ? { prUrl: "https://user:pass@git.example.com/acme/api/pull/42" }
              : problem === "malformed"
                ? { prUrl: "not-url" }
                : {}),
          }),
        ),
        "queue",
      );
      const pr =
        problem === "missing"
          ? undefined
          : {
              ...binding,
              number: problem === "number" ? 43 : 42,
              repo: problem === "repo" ? "other/api" : "acme/api",
            };
      expect(await queue.refresh?.("/tmp/daemon-data", pr)).toMatchObject([{ status: "failed" }]);
      expect(queue.isEmpty()).toBe(true);
      expect(ghMock).not.toHaveBeenCalled();
    },
  );

  it("recovers a matching legacy binding and removes failed/deleted controls through filterItems", async () => {
    ghMock.mockReset().mockRejectedValue(new Error("HTTP 404"));
    const queue = requireBatch(parse(githubEventData({ repo: "acme/api" })), "queue");
    queue.attachAutoPing({
      occurrenceId: "occurrence",
      routeFingerprint: "route",
      destination: { kind: "session", sessionId: "api-1" },
      createGrant: () => "handle",
    });
    expect(await queue.refresh?.("/tmp/daemon-data", binding)).toEqual([
      { status: "deleted", key: "comment:1" },
    ]);
    expect(queue.serialize()).toMatchObject({ prUrl: url, autoPing: { items: {} } });
  });
});

describe("isGitHubEventData", () => {
  it("restores proven legacy GitLab discussion targets without inventing individual threads", () => {
    const batch = restoreSendBatch({
      kind: "review",
      providerId: "gitlab",
      projectId: "proj",
      sourceId: "src",
      ...githubEventData({
        signals: [
          { key: "discussion:thread-1:note-2", kind: "comment", text: "thread" },
          { key: "comment:3", kind: "comment", text: "individual" },
        ],
      }),
    });
    const stored = batch?.serialize();
    expect(stored?.kind).toBe("review");
    if (stored?.kind !== "review") throw new Error("missing review batch");
    expect(stored.signals[0]?.providerThreadTarget).toEqual({
      kind: "gitlab-discussion",
      mergeRequestIid: 42,
      discussionId: "thread-1",
    });
    expect(stored.signals[1]?.providerThreadTarget).toBeUndefined();
  });
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
    expect(formatted).toContain(
      "Source: telegram. The requester only sees messages you send with:",
    );
    expect(formatted).toContain('spur source reply "<message>"');
    expect(formatted).toContain(
      "Your terminal output is invisible to them. Reply to the same Telegram thread when you need input and when the task completes, with a short result summary.",
    );
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
    expect(formatted).toContain(
      "Source: telegram. The requester only sees messages you send with:",
    );
    expect(formatted).toContain(
      "Your terminal output is invisible to them. Reply to the same Telegram thread when you need input and when the task completes, with a short result summary.",
    );
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

    const snapshot = storedSnapshot([{ key: "comment:1", kind: "comment", text: "comment one" }]);
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
    const snapshot = storedSnapshot([{ key: "comment:1", kind: "comment", text: "comment one" }]);
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

describe("automatic ping controls", () => {
  it("filters one suppressed thread item while preserving its sibling and one subscription control", () => {
    const parse = createSendBatchParser("github", "proj", "src-1");
    const batch = requireBatch(
      parse(
        githubEventData({
          signals: [
            {
              key: "review-comment:1",
              kind: "comment",
              text: "inline",
              providerThreadTarget: { kind: "github-review-thread", threadId: "thread-1" },
            },
            { key: "ready_for_review", kind: "ready_for_review", text: "ready" },
          ],
        }),
      ),
      "expected review batch",
    );
    let grant = 0;
    batch.attachAutoPing({
      occurrenceId: "occurrence",
      routeFingerprint: "route",
      destination: { kind: "session", sessionId: "api-1" },
      createGrant: () => `ap1_${String(++grant).padStart(43, "a")}`,
    });
    batch.filterAutoPing(
      (_occurrenceId, threadTarget) =>
        threadTarget?.kind === "github-review-thread" && threadTarget.threadId === "thread-1",
    );

    expect(batch.format()).toContain("ready");
    expect(batch.format()).not.toContain("inline");
    expect(batch.formatAutoPingControls()).toContain("--event");
    expect(batch.formatAutoPingControls().match(/--subscription/g)).toHaveLength(1);
    expect(batch.formatAutoPingControls()).not.toContain("--thread");
    expect(restoreSendBatch(batch.serialize())?.format()).toContain("ready");
  });
});

describe("restoreSendBatch", () => {
  it("rejects present policy state that omits targets for a restored payload", () => {
    const batch = requireBatch(
      createSendBatchParser("github", "proj", "src")(githubEventData()),
      "review batch",
    );
    expect(
      restoreSendBatch({
        ...batch.serialize(),
        autoPing: {
          routeFingerprint: "route",
          destination: { kind: "session", sessionId: "api-1" },
          subscriptionHandle: "subscription",
          items: {},
        },
      }),
    ).toBeNull();
    expect(restoreSendBatch(batch.serialize())).not.toBeNull();
  });
  it.each([
    null,
    {},
    { occurrenceId: "event", eventHandle: 1 },
    { occurrenceId: "event", eventHandle: "handle", threadTarget: { kind: "subscription" } },
    { occurrenceId: "event", eventHandle: "handle", threadHandle: "orphan" },
  ])("rejects malformed persisted auto-ping items: %j", (item) => {
    const batch = requireBatch(
      createSendBatchParser("github", "proj", "src")(githubEventData()),
      "review batch",
    );
    expect(
      restoreSendBatch({
        ...batch.serialize(),
        autoPing: {
          routeFingerprint: "route",
          destination: { kind: "session", sessionId: "api-1" },
          subscriptionHandle: "subscription",
          items: { "comment:1": item },
        },
      }),
    ).toBeNull();
  });
  it("reserves retained conflict replay budgets for GitHub without capping later GitLab episodes", () => {
    const data = githubEventData({
      signals: [{ key: "merge_conflict", kind: "merge_conflict", text: "Conflicts" }],
    });
    const github = requireBatch(
      createSendBatchParser("github", "proj", "src")(data),
      "GitHub batch",
    );
    const gitlab = requireBatch(
      createSendBatchParser("gitlab", "proj", "src")(data),
      "GitLab batch",
    );
    expect(github.retryItems()[0]?.mergeConflict).toEqual({ prNumber: 42 });
    expect(gitlab.retryItems()[0]?.mergeConflict).toBeUndefined();
    expect(restoreSendBatch(gitlab.serialize())?.retryItems()[0]?.mergeConflict).toBeUndefined();
  });
  it("preserves semantic identity across control and title changes while separating edited items", () => {
    const parse = createSendBatchParser("github", "proj", "src-1");
    const batch = requireBatch(parse(githubEventData()), "review batch");
    const [before] = batch.retryItems();
    batch.merge(requireBatch(parse(githubEventData({ prTitle: "renamed" })), "renamed batch"));
    expect(batch.retryItems()).toEqual([before]);
    batch.merge(
      requireBatch(
        parse(
          githubEventData({ signals: [{ key: "comment:1", kind: "comment", text: "Changed" }] }),
        ),
        "edited batch",
      ),
    );
    expect(batch.retryItems()[0]?.itemKey).toBe(before?.itemKey);
    expect(batch.retryItems()[0]?.fingerprint).not.toBe(before?.fingerprint);
    expect(restoreSendBatch(batch.serialize())?.retryItems()).toEqual(batch.retryItems());
  });

  it("deduplicates a Telegram item while retaining same-text messages and separate chats", () => {
    const parse = createSendBatchParser("telegram", "proj", "src-1");
    const batch = requireBatch(parse(telegramEventData()), "Telegram batch");
    batch.merge(requireBatch(parse(telegramEventData()), "duplicate"));
    batch.merge(requireBatch(parse(telegramEventData({ messageId: 100 })), "new message"));
    batch.merge(requireBatch(parse(telegramEventData({ chatId: -200 })), "other chat"));
    expect(batch.retryItems()).toHaveLength(3);
    const retained = batch.retryItems()[2]?.itemKey;
    batch.filterItems((item) => item.itemKey === retained);
    expect(batch.retryItems()).toHaveLength(1);
    expect(batch.format()).toContain("chat -200");
  });
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
