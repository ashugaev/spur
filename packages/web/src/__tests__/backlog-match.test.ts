import { describe, expect, it } from "vitest";
import {
  hasBoundedToken,
  isBacklogItemActivelyWorked,
  normalizeTrackerUrl,
} from "@/lib/backlog-match";
import type { AvailableBacklogItem, DashboardSession, SpurSessionState } from "@/lib/types";

function item(
  overrides: Partial<AvailableBacklogItem> = {},
): Pick<AvailableBacklogItem, "url" | "projectId"> {
  return {
    url: "https://jira.example.com/browse/WEB-17",
    projectId: "web",
    ...overrides,
  };
}

function session(
  overrides: Partial<Pick<DashboardSession, "state" | "prompt" | "links" | "projectId">> = {},
): Pick<DashboardSession, "state" | "prompt" | "links" | "projectId"> {
  return {
    state: "working" as SpurSessionState,
    prompt: "",
    links: [],
    projectId: "web",
    ...overrides,
  };
}

describe("isBacklogItemActivelyWorked", () => {
  it("matches an exact tracker link", () => {
    const active = session({
      links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }],
    });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(true);
  });

  it("does not match a url that is a prefix of a longer url in the prompt", () => {
    const active = session({
      prompt: "Work on https://jira.example.com/browse/WEB-15: unrelated",
    });
    expect(
      isBacklogItemActivelyWorked(item({ url: "https://jira.example.com/browse/WEB-1" }), [active]),
    ).toBe(false);
  });

  it("does not hide the item when the active session is in a different project", () => {
    const active = session({
      projectId: "other",
      links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }],
      prompt: "please look at https://jira.example.com/browse/WEB-17 today",
    });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(false);
  });

  it("matches tracker urls differing by trailing slash", () => {
    const active = session({
      links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17/" }],
    });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(true);
  });

  it("matches tracker urls differing by case", () => {
    const active = session({
      links: [{ label: "tracker", url: "HTTPS://JIRA.EXAMPLE.COM/browse/WEB-17" }],
    });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(true);
  });

  it("matches tracker urls differing only by query string", () => {
    const active = session({
      links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17?focused=true" }],
    });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(true);
  });

  it("does not match a session in a terminal state", () => {
    for (const state of ["stopped", "error", "killed"] as const) {
      const terminal = session({
        state,
        links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }],
      });
      expect(isBacklogItemActivelyWorked(item(), [terminal])).toBe(false);
    }
  });

  it("still counts a stale-parked session as actively working the item (it wakes silently rather than being replaced)", () => {
    const stale = session({
      state: "stale",
      links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }],
    });
    expect(isBacklogItemActivelyWorked(item(), [stale])).toBe(true);
  });

  it("matches by url even when the key is absent from the prompt", () => {
    const active = session({
      prompt: "please look at https://jira.example.com/browse/WEB-17 today",
    });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(true);
  });

  it("returns false when there is no active session", () => {
    expect(isBacklogItemActivelyWorked(item(), [])).toBe(false);
  });
});

describe("hasBoundedToken", () => {
  it("requires a non-alphanumeric boundary around the token", () => {
    expect(hasBoundedToken("SP-15 is unrelated", "SP-1")).toBe(false);
    expect(hasBoundedToken("see SP-1 please", "SP-1")).toBe(true);
    expect(hasBoundedToken("SP-1", "SP-1")).toBe(true);
  });
});

describe("normalizeTrackerUrl", () => {
  it("drops search, hash, and trailing slash and lowercases the host", () => {
    expect(normalizeTrackerUrl("https://Jira.Example.com/browse/WEB-17/?x=1#frag")).toBe(
      normalizeTrackerUrl("https://jira.example.com/browse/WEB-17"),
    );
  });
});
