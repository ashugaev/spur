import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { activityConfig, ActivityDot } from "@/components/ActivityDot";

describe("ActivityDot", () => {
  it("renders the working label", () => {
    render(<ActivityDot activity="working" />);
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("renders 'needs input' for the needs_input activity", () => {
    render(<ActivityDot activity="needs_input" />);
    expect(screen.getByText("needs input")).toBeInTheDocument();
  });

  it("renders 'stopped' for the stopped activity", () => {
    render(<ActivityDot activity="stopped" />);
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("renders 'stale' for the stale activity with no pulse", () => {
    render(<ActivityDot activity="stale" dotOnly />);
    const dot = document.querySelector(".shrink-0.rounded-full");
    expect(dot).not.toBeNull();
    expect(dot).not.toHaveClass("dot-pulse");
  });

  it("renders the stale label", () => {
    render(<ActivityDot activity="stale" />);
    expect(screen.getByText("stale")).toBeInTheDocument();
  });

  // The two tests above render identically whether or not activityConfig has
  // a "stale" entry: activityConfig.stale reuses inactiveConfig's dot/bg/text
  // verbatim (same as "stopped"/"killed"), and ActivityDot's own fallback for
  // an unmapped activity also falls back to inactiveConfig with label set to
  // the raw activity string — so a deleted "stale" entry renders
  // pixel-identical output for activity="stale". Only a direct assertion on
  // the config map itself can pin the entry.
  it("maps the stale entry to the inactive dot/bg/text colors, not just the fallback shape", () => {
    expect(activityConfig.stale).toEqual({
      label: "stale",
      dot: "var(--color-text-tertiary)",
      bg: "var(--color-dot-bg-inactive)",
      text: "var(--color-text-secondary)",
    });
  });

  it("hides the label when dotOnly is true", () => {
    render(<ActivityDot activity="working" dotOnly />);
    expect(screen.queryByText("working")).not.toBeInTheDocument();
  });
});
