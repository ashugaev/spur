import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityDot } from "@/components/ActivityDot";

describe("ActivityDot", () => {
  it("renders completed tasks with a ready badge without pulsing", () => {
    const { container } = render(<ActivityDot activity="completed" />);
    expect(screen.getByText("completed")).toHaveStyle({ color: "var(--color-status-ready)" });
    expect(container.firstChild).toHaveStyle({ background: "var(--color-status-ready-bg)" });
    expect(container.querySelector(".dot-pulse")).toBeNull();
  });

  it("renders closed sessions with an inactive badge", () => {
    const { container } = render(<ActivityDot activity="closed" />);
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(container.firstChild).toHaveStyle({ background: "var(--color-status-inactive-bg)" });
  });
  it("renders a distinct budget limited label", () => {
    render(<ActivityDot activity="budget_limited" />);
    expect(screen.getByText("BUDGET LIMITED")).toBeInTheDocument();
  });
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
    const dot = document.querySelector(".shrink-0.rounded-dot");
    expect(dot).not.toBeNull();
    expect(dot).not.toHaveClass("dot-pulse");
  });

  it("renders the stale label", () => {
    render(<ActivityDot activity="stale" />);
    expect(screen.getByText("stale")).toBeInTheDocument();
  });

  it("hides the label when dotOnly is true", () => {
    render(<ActivityDot activity="working" dotOnly />);
    expect(screen.queryByText("working")).not.toBeInTheDocument();
  });
});
