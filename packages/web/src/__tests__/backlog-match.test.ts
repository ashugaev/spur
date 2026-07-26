import { describe, expect, it } from "vitest";
import {
  hasBoundedToken,
  isBacklogItemActivelyWorked,
  normalizeTrackerUrl,
} from "@/lib/backlog-match";
import type { AvailableBacklogItem, DashboardSession, SpurSessionState } from "@/lib/types";

function item(
  overrides: Partial<AvailableBacklogItem> = {},
): Pick<AvailableBacklogItem, "url" | "key"> {
  return {
    url: "https://jira.example.com/browse/WEB-17",
    key: "WEB-17",
    ...overrides,
  };
}

function session(
  overrides: Partial<Pick<DashboardSession, "state" | "prompt" | "links">> = {},
): Pick<DashboardSession, "state" | "prompt" | "links"> {
  return {
    state: "working" as SpurSessionState,
    prompt: "",
    links: [],
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

  it("matches a bounded key token in the prompt", () => {
    const active = session({ prompt: "Work on WEB-17: fix the checkout bug" });
    expect(isBacklogItemActivelyWorked(item(), [active])).toBe(true);
  });

  it("does not match a longer key containing the item key as a prefix", () => {
    const active = session({ prompt: "Work on SP-15: unrelated" });
    expect(
      isBacklogItemActivelyWorked(
        item({ key: "SP-1", url: "https://jira.example.com/browse/SP-1" }),
        [active],
      ),
    ).toBe(false);
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
