import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagFilter } from "@/components/TagFilter.js";
import type { SpurTagDefinition } from "@/lib/types.js";

const catalog: SpurTagDefinition[] = [
  { name: "bug", description: "A defect", color: "hsl(0 62% 64%)" },
  { name: "docs", description: "Docs only", color: "hsl(120 62% 64%)" },
];

const onChange = vi.fn();

// The trigger's aria-label reflects the current selection, so match its stable
// prefix rather than an exact string.
function trigger() {
  return screen.getByRole("button", { name: /Filter by tag/ });
}

beforeEach(() => {
  onChange.mockReset();
});

describe("TagFilter", () => {
  it("exposes menu a11y state on the trigger", () => {
    render(<TagFilter catalog={catalog} value={["bug"]} onChange={onChange} />);
    const button = trigger();
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-label", "Filter by tag: bug");
    fireEvent.click(button);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("appends a newly picked tag to the existing selection and keeps the popover open", () => {
    render(<TagFilter catalog={catalog} value={["bug"]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    expect(onChange).toHaveBeenCalledWith(["bug", "docs"]);
    // Popover stays open after a pick: menu rows remain in the document.
    expect(screen.getByRole("button", { name: "All tags" })).toBeInTheDocument();
  });

  it("marks both selected rows as pressed", () => {
    render(<TagFilter catalog={catalog} value={["bug", "docs"]} onChange={onChange} />);
    fireEvent.click(trigger());
    expect(screen.getByRole("button", { name: "bug" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "docs" })).toHaveAttribute("aria-pressed", "true");
  });

  it("removes a tag that is already selected", () => {
    render(<TagFilter catalog={catalog} value={["bug", "docs"]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "bug" }));
    expect(onChange).toHaveBeenCalledWith(["docs"]);
  });

  it("clears the selection via All tags", () => {
    render(<TagFilter catalog={catalog} value={["bug"]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "All tags" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("shows Tags on the trigger when the selection is empty", () => {
    render(<TagFilter catalog={catalog} value={[]} onChange={onChange} />);
    expect(trigger().textContent).toContain("Tags");
  });

  it("shows the single tag name on the trigger", () => {
    render(<TagFilter catalog={catalog} value={["bug"]} onChange={onChange} />);
    expect(trigger().textContent).toContain("bug");
  });

  it("shows both tag names on the trigger when two are selected", () => {
    render(<TagFilter catalog={catalog} value={["bug", "docs"]} onChange={onChange} />);
    const label = trigger().textContent ?? "";
    expect(label).toContain("bug");
    expect(label).toContain("docs");
  });

  it("shows a count on the trigger when more than two are selected", () => {
    render(<TagFilter catalog={catalog} value={["bug", "docs", "chore"]} onChange={onChange} />);
    expect(trigger().textContent).toContain("3 tags");
  });

  it("applies the accent border only when the selection is non-empty", () => {
    const { rerender } = render(<TagFilter catalog={catalog} value={[]} onChange={onChange} />);
    expect(trigger().className).not.toContain("border-[var(--color-accent)]");
    rerender(<TagFilter catalog={catalog} value={["bug"]} onChange={onChange} />);
    expect(trigger().className).toContain("border-[var(--color-accent)]");
  });

  it("renders no color dot in the trigger or the open menu", () => {
    const { container } = render(
      <TagFilter catalog={catalog} value={["bug"]} onChange={onChange} />,
    );
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(0);
    fireEvent.click(trigger());
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(0);
  });
});
