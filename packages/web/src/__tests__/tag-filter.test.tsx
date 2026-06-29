import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagFilter } from "@/components/TagFilter.js";
import type { SpurTagDefinition } from "@/lib/types.js";

const catalog: SpurTagDefinition[] = [
  { name: "bug", description: "A defect", color: "hsl(0 62% 64%)" },
  { name: "docs", description: "Docs only", color: "hsl(120 62% 64%)" },
];

const onChange = vi.fn();

beforeEach(() => {
  onChange.mockReset();
});

describe("TagFilter", () => {
  it("opens the menu and selects a tag", () => {
    render(<TagFilter catalog={catalog} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Filter by tag"));
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    expect(onChange).toHaveBeenCalledWith("docs");
  });

  it("clears the filter via All tags", () => {
    render(<TagFilter catalog={catalog} value="bug" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Filter by tag"));
    fireEvent.click(screen.getByRole("button", { name: "All tags" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows the active tag name on the trigger", () => {
    render(<TagFilter catalog={catalog} value="bug" onChange={onChange} />);
    expect(screen.getByLabelText("Filter by tag").textContent).toContain("bug");
  });
});
