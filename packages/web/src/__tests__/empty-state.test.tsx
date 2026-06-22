import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/components/EmptyState";

describe("EmptyState", () => {
  it("renders the default copy when no message is supplied", () => {
    render(<EmptyState />);
    expect(screen.getByText(/No Spur sessions are visible yet/)).toBeInTheDocument();
  });

  it("renders the provided message in place of the default copy", () => {
    render(<EmptyState message="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});
