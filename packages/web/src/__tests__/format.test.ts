import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRelativeTime,
  getSessionSubtitle,
  getSessionTitle,
  humanizeBranch,
  truncateMiddle,
} from "@/lib/format";
import type { DashboardSession } from "@/lib/types";

function makeSession(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "sess-1",
    prompt: "",
    title: null,
    branch: null,
    ...overrides,
  } as DashboardSession;
}

describe("humanizeBranch", () => {
  it("strips known prefixes and title-cases the remainder", () => {
    expect(humanizeBranch("feat/add-auth-flow")).toBe("Add Auth Flow");
  });

  it("leaves an unknown prefix attached, title-casing each word", () => {
    expect(humanizeBranch("random/thing")).toBe("Random/Thing");
  });
});

describe("getSessionTitle", () => {
  it("prefers an explicit title", () => {
    expect(getSessionTitle(makeSession({ title: "My session", prompt: "fallback" }))).toBe(
      "My session",
    );
  });

  it("falls back to the original task when title is missing", () => {
    expect(
      getSessionTitle(
        makeSession({
          originalTaskPrompt: "ping",
          prompt: "Task handoff from session shp-1 (cursor).",
        }),
      ),
    ).toBe("ping");
  });

  it("falls back to the first prompt line when title is missing", () => {
    expect(getSessionTitle(makeSession({ prompt: "first line\nsecond" }))).toBe("first line");
  });

  it("falls back to humanized branch when prompt is empty", () => {
    expect(getSessionTitle(makeSession({ prompt: "", branch: "feat/add-thing" }))).toBe(
      "Add Thing",
    );
  });

  it("falls back to id when nothing else is set", () => {
    expect(getSessionTitle(makeSession({ id: "abc", prompt: "" }))).toBe("abc");
  });
});

describe("getSessionSubtitle", () => {
  it("always returns null because prompt details render in structured sections", () => {
    expect(getSessionSubtitle(makeSession({ title: "other", prompt: "details" }))).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' under a minute", () => {
    expect(formatRelativeTime("2024-12-31T23:59:30Z")).toBe("just now");
  });

  it("returns minutes for sub-hour ages", () => {
    expect(formatRelativeTime("2024-12-31T23:55:00Z")).toBe("5m ago");
  });

  it("returns hours for sub-day ages", () => {
    expect(formatRelativeTime("2024-12-31T20:00:00Z")).toBe("4h ago");
  });

  it("returns days for older ages", () => {
    expect(formatRelativeTime("2024-12-28T00:00:00Z")).toBe("4d ago");
  });

  it("returns 'unknown' on unparseable input", () => {
    expect(formatRelativeTime("not-a-date")).toBe("unknown");
  });
});

describe("truncateMiddle", () => {
  it("returns the input unchanged when shorter than the max length", () => {
    expect(truncateMiddle("short", 64)).toBe("short");
  });

  it("collapses the middle with an ellipsis", () => {
    const value = "x".repeat(40);
    const result = truncateMiddle(value, 16);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(value.length);
  });
});
