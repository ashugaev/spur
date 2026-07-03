import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityDot } from "@/components/ActivityDot";

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

  it("hides the label when dotOnly is true", () => {
    render(<ActivityDot activity="working" dotOnly />);
    expect(screen.queryByText("working")).not.toBeInTheDocument();
  });
});
