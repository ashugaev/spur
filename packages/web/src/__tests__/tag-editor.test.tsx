import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagEditor } from "@/components/TagEditor.js";
import { TagsContext, type TagsContextValue } from "@/components/TagsContext.js";
import type { DashboardSession } from "@/lib/types.js";

const applyTags = vi.fn().mockResolvedValue(undefined);

const catalog = [
  { name: "bug", description: "A defect to fix", color: "hsl(0 62% 64%)" },
  { name: "docs", description: "Documentation only", color: "hsl(120 62% 64%)" },
];

function renderEditor(tags: string[], variant: "dots" | "chips") {
  const session = { id: "api-a1", tags } as unknown as DashboardSession;
  const value: TagsContextValue = { catalog, applyTags };
  return render(
    <TagsContext.Provider value={value}>
      <TagEditor session={session} variant={variant} />
    </TagsContext.Provider>,
  );
}

describe("TagEditor dots variant", () => {
  beforeEach(() => {
    applyTags.mockReset();
    applyTags.mockResolvedValue(undefined);
  });

  it("renders one colored dot per applied tag in a shrink-0 cluster", () => {
    const { container } = renderEditor(["bug"], "dots");
    const cluster = container.querySelector("div.relative");
    expect(cluster?.className).toContain("shrink-0");

    const dot = screen.getByTitle("bug");
    // jsdom resolves hsl(0 62% 64%) to its rgb form on the dot background.
    expect(dot.getAttribute("style")).toContain("rgb(220, 106, 106)");
  });

  it("caps dots and collapses the rest into a +N indicator", () => {
    renderEditor(["bug", "feature", "docs", "security", "performance", "refactor"], "dots");
    expect(screen.getByTitle("bug")).toBeTruthy();
    expect(screen.getByTitle("security")).toBeTruthy();
    // 6 applied, 4 dots -> "+2"; the overflowed names get no individual dot.
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryByTitle("performance")).toBeNull();
    expect(screen.queryByTitle("refactor")).toBeNull();
  });

  it("shows a discoverable affordance and opens the popover when no tags applied", () => {
    renderEditor([], "dots");
    const trigger = screen.getByLabelText("Manage tags");
    expect(trigger).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("lists only unapplied tags in the add section and applies them", () => {
    renderEditor(["bug"], "dots");
    fireEvent.click(screen.getByLabelText("Manage tags"));
    // Only docs is unapplied; bug is not offered as an add option.
    expect(screen.getByText("Documentation only")).toBeTruthy();
    expect(screen.queryByText("A defect to fix")).toBeNull();

    fireEvent.click(screen.getByText("Documentation only"));
    expect(applyTags).toHaveBeenCalledWith("api-a1", { add: ["docs"], remove: [] });
  });

  it("removes an applied tag from the popover", () => {
    renderEditor(["bug"], "dots");
    fireEvent.click(screen.getByLabelText("Manage tags"));
    fireEvent.click(screen.getByLabelText("Remove tag bug"));
    expect(applyTags).toHaveBeenCalledWith("api-a1", { add: [], remove: ["bug"] });
  });

  it("closes the popover on Escape", () => {
    renderEditor([], "dots");
    fireEvent.click(screen.getByLabelText("Manage tags"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("TagEditor chips variant", () => {
  beforeEach(() => {
    applyTags.mockReset();
    applyTags.mockResolvedValue(undefined);
  });

  it("renders full-name chips tinted from the catalog color", () => {
    renderEditor(["bug"], "chips");
    const chip = screen.getByText("bug").closest("span[style]");
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("style")).toContain("rgb(220, 106, 106)");
    expect(chip?.getAttribute("style")).toContain("color-mix(in srgb");
  });

  it("exposes a manage-tags trigger that opens the add/remove popover", () => {
    renderEditor(["bug"], "chips");
    fireEvent.click(screen.getByLabelText("Manage tags"));
    fireEvent.click(screen.getByText("Documentation only"));
    expect(applyTags).toHaveBeenCalledWith("api-a1", { add: ["docs"], remove: [] });
  });
});
