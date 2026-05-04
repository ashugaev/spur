import { describe, expect, it } from "vitest";
import { formatSessionLinkDisplay } from "../../src/session-link-display.js";

describe("formatSessionLinkDisplay", () => {
  it("formats GitHub PR link with /pull/123 as github pr #123", () => {
    const display = formatSessionLinkDisplay({
      label: "github-pr",
      url: "https://github.com/acme/api/pull/123",
    });
    expect(display.text).toBe("github pr #123");
  });

  it("extracts Jira key from tracker URL", () => {
    const display = formatSessionLinkDisplay({
      label: "tracker",
      url: "https://jira.example.com/browse/API-42",
    });
    expect(display.text).toBe("tracker API-42");
  });

  it("handles jira label same as tracker", () => {
    const display = formatSessionLinkDisplay({
      label: "jira",
      url: "https://jira.example.com/browse/OPS-9",
    });
    expect(display.text).toBe("jira OPS-9");
  });

  it("formats custom label with last URL segment", () => {
    const display = formatSessionLinkDisplay({
      label: "docs",
      url: "https://example.com/path/to/page",
    });
    expect(display.text).toBe("docs page");
  });

  it("falls back to label for invalid URL", () => {
    const display = formatSessionLinkDisplay({
      label: "broken",
      url: "not-a-url",
    });
    expect(display.text).toBe("broken");
    expect(display.label).toBe("broken");
  });

  it("truncates long values", () => {
    const longSegment = "a".repeat(50);
    const display = formatSessionLinkDisplay({
      label: "docs",
      url: `https://example.com/${longSegment}`,
    });
    expect(display.text.length).toBeLessThanOrEqual(30);
    expect(display.text).toContain("…");
  });
});
