import { describe, expect, it } from "vitest";
import { renderBootstrapPrompt } from "../../../../v2/src/bootstrap-prompt.js";
import { matchesSessionSearch } from "@/lib/session-search.js";
import type { DashboardSession } from "@/lib/types.js";

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "api-42",
    projectId: "api",
    projectName: "Payments API",
    agent: "claude",
    title: "Retry processor",
    prompt: "runtime-only-instruction",
    originalTaskPrompt: "Fix duplicate payment retries",
    startupAttachmentIds: [],
    branch: "feature/payment-retries",
    worktree: true,
    tmuxSession: "api-42",
    status: "running",
    state: "working",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
    lastActivityAt: "2026-03-18T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/worktrees/api-42",
    services: [],
    artifacts: [],
    queuedMessages: { messages: [], awaitingPrompt: false },
    sidecars: [],
    runningSidecars: [],
    links: [
      { label: "github-pr", url: "https://github.com/acme/api/pull/742" },
      { label: "gitlab-pr", url: "https://gitlab.com/acme/api/-/merge_requests/81" },
      { label: "tracker", url: "https://jira.example.com/browse/PAY-319" },
      { label: "github_pr", url: "https://github.com/acme/api/pull/743" },
      { label: "jira", url: "https://jira.example.com/browse/PAY-320" },
    ],
    tags: ["backend-review"],
    hasServiceIssues: false,
    deskKey: "api-42",
    ...overrides,
  };
}

describe("matchesSessionSearch", () => {
  it.each([
    ["API-4", "session id"],
    ["processor", "title"],
    ["payments", "project name"],
    ["PAYMENT-RETRIES", "branch"],
    ["duplicate PAYMENT", "canonical task"],
    ["#742", "GitHub pull request"],
    ["!81", "GitLab merge request"],
    ["pay-319", "tracker item"],
    ["#743", "GitHub pull request alias"],
    ["pay-320", "Jira link alias"],
    ["backend-review", "tag"],
  ])("matches %s against the %s", (query) => {
    expect(matchesSessionSearch(makeSession(), query)).toBe(true);
  });

  it("matches the canonical Telegram task without indexing its wrapper", () => {
    const telegramSuffix = `

Source: telegram. The requester only sees messages you send with:
spur source reply "<message>"
Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.`;
    const session = makeSession({
      prompt: `Repair settlement export${telegramSuffix}`,
      originalTaskPrompt: `Repair settlement export${telegramSuffix}`,
    });

    expect(matchesSessionSearch(session, "settlement export")).toBe(true);
    expect(matchesSessionSearch(session, "terminal output")).toBe(false);
  });

  it.each([
    ["runtime-only-instruction", "raw runtime prompt"],
    ["github.com/acme/api", "link URL"],
    ["github-pr", "link label"],
    ["github_pr", "link label alias"],
    ["jira", "tracker link label alias"],
    ["task", "generic tracker fallback"],
    ["unrelated", "unrelated text"],
  ])("does not match %s from %s", (query) => {
    expect(matchesSessionSearch(makeSession(), query)).toBe(false);
  });

  it("does not index generic link fallbacks", () => {
    const session = makeSession({
      id: "billing-42",
      projectId: "billing",
      projectName: "Billing",
      title: null,
      prompt: "runtime",
      originalTaskPrompt: "Fix billing",
      branch: "feature/billing",
      links: [
        { label: "pr", url: "https://example.com/reviews/42" },
        { label: "tracker", url: "https://example.com/tasks/42" },
      ],
    });

    expect(matchesSessionSearch(session, "PR")).toBe(false);
    expect(matchesSessionSearch(session, "task")).toBe(false);
    expect(matchesSessionSearch(session, "reviews/42")).toBe(false);
  });

  it("does not crash when originalTaskPrompt is null", () => {
    const session = makeSession({
      prompt: "runtime only",
      originalTaskPrompt: null,
    });

    expect(() => matchesSessionSearch(session, "anything")).not.toThrow();
    expect(matchesSessionSearch(session, "anything")).toBe(false);
  });

  it("does not index generated bootstrap prompt text", () => {
    const prompt = renderBootstrapPrompt({
      id: "api",
      displayName: "Payments API",
      prefix: "pay",
      path: "/repo/payments",
      port: 3000,
      referencePath: "/repo/payments/spur.yaml.reference",
    });

    expect(
      matchesSessionSearch(makeSession({ prompt, originalTaskPrompt: prompt }), "spur.yaml"),
    ).toBe(false);
  });

  it("matches every session for a blank query", () => {
    expect(matchesSessionSearch(makeSession(), "   ")).toBe(true);
  });
});
