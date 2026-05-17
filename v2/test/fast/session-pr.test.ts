import { describe, expect, it } from "vitest";
import {
  deriveSessionSlots,
  normalizeSessionPrBinding,
  parseSessionPrBinding,
} from "../../src/session-pr.js";
import type { SessionRecord } from "../../src/types.js";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    agent: "claude",
    prompt: "fix the bug",
    branch: "feature/native-pr-binding",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api-a1b2",
    tmuxSession: "api-a1b2",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-04-26T09:00:00.000Z",
    updatedAt: "2026-04-26T09:00:00.000Z",
    ...overrides,
  };
}

describe("session-pr", () => {
  it("parses a GitHub PR URL into a native session binding", () => {
    expect(parseSessionPrBinding("https://github.com/acme/api/pull/42")).toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
  });

  it("imports a legacy pr slot into session.pr and strips the generic link", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          title: "Investigate CI",
          links: [
            { label: "tracker", url: "https://tracker.example.com/TASK-9" },
            { label: "pr", url: "https://github.com/acme/api/pull/42" },
          ],
        },
      }),
    );

    expect(normalized.pr).toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(normalized.slots).toEqual({
      title: "Investigate CI",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
  });

  it("imports a legacy github-pr slot into session.pr and strips it from slots", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          title: "Investigate CI",
          links: [
            { label: "tracker", url: "https://tracker.example.com/TASK-9" },
            { label: "github-pr", url: "https://github.com/acme/api/pull/42" },
          ],
        },
      }),
    );

    expect(normalized.pr).toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(normalized.slots).toEqual({
      title: "Investigate CI",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
  });

  it("keeps non-GitHub pr links as generic slots", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          links: [{ label: "pr", url: "https://example.com/claude/pull/1" }],
        },
      }),
    );

    expect(normalized.pr).toBeUndefined();
    expect(normalized.slots).toEqual({
      links: [{ label: "pr", url: "https://example.com/claude/pull/1" }],
    });
    expect(deriveSessionSlots(normalized)).toEqual(normalized.slots);
  });

  it("collapses legacy github-pr aliases into generic pr slots for non-GitHub URLs", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          links: [{ label: "github-pr", url: "https://gitlab.com/acme/api/-/merge_requests/7" }],
        },
      }),
    );

    expect(normalized.pr).toBeUndefined();
    expect(normalized.slots).toEqual({
      links: [{ label: "pr", url: "https://gitlab.com/acme/api/-/merge_requests/7" }],
    });
  });

  it("derives the display pr link from the native binding", () => {
    expect(
      deriveSessionSlots(
        makeSession({
          pr: {
            number: 42,
            repo: "acme/api",
            url: "https://github.com/acme/api/pull/42",
          },
          slots: {
            links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
          },
        }),
      ),
    ).toEqual({
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-9" },
        { label: "pr", url: "https://github.com/acme/api/pull/42" },
      ],
    });
  });
});
