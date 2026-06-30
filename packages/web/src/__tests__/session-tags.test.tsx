import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTags } from "@/components/SessionTags.js";
import { TagsContext, type TagsContextValue } from "@/components/TagsContext.js";
import type { DashboardSession } from "@/lib/types.js";

const applyTags = vi.fn().mockResolvedValue(undefined);

const catalog = [
  { name: "bug", description: "A defect to fix", color: "hsl(0 62% 64%)" },
  { name: "docs", description: "Documentation only", color: "hsl(120 62% 64%)" },
];

function renderTags(tags: string[]) {
  const session = { id: "api-a1", tags } as unknown as DashboardSession;
  const value: TagsContextValue = { catalog, applyTags };
  return render(
    <TagsContext.Provider value={value}>
      <SessionTags session={session} />
    </TagsContext.Provider>,
  );
}

function tagGroup(container: HTMLElement): HTMLElement {
  const group = container.querySelector("span.relative");
  if (!group) throw new Error("tag group not found");
  return group as HTMLElement;
}

describe("SessionTags", () => {
  beforeEach(() => {
    applyTags.mockReset();
    applyTags.mockResolvedValue(undefined);
  });

  it("renders an applied tag chip with its catalog color and a remove control", () => {
    renderTags(["bug"]);
    // The colored style lives on the chip wrapper; the name sits in an inner span.
    const chip = screen.getByText("bug").closest("span[style]");
    expect(chip).toBeTruthy();
    // jsdom resolves hsl(0 62% 64%) to its rgb form; the chip tints from the catalog color.
    expect(chip?.getAttribute("style")).toContain("rgb(220, 106, 106)");
    expect(chip?.getAttribute("style")).toContain("color-mix(in srgb");

    const dot = chip?.querySelector("span.rounded-full");
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute("style")).toContain("rgb(220, 106, 106)");

    fireEvent.click(screen.getByLabelText("Remove tag bug"));
    expect(applyTags).toHaveBeenCalledWith("api-a1", { add: [], remove: ["bug"] });
  });

  it("caps visible chips and collapses the rest into a +N indicator", () => {
    renderTags(["bug", "feature", "docs", "security", "performance", "refactor"]);
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("security")).toBeTruthy();
    // 6 applied, 4 visible -> "+2", and the 5th/6th names are not rendered as chips.
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryByText("performance")).toBeNull();
    expect(screen.queryByText("refactor")).toBeNull();
  });

  it("hides the chip group below the sm breakpoint", () => {
    const { container } = renderTags(["bug"]);
    const group = tagGroup(container);
    expect(group.className).toContain("hidden");
    expect(group.className).toContain("sm:inline-flex");
  });

  it("opens the picker and applies a tag that is not yet present", () => {
    renderTags([]);
    fireEvent.click(screen.getByLabelText("Add tag"));

    // The picker lists only unapplied catalog tags with their descriptions.
    expect(screen.getByText("Documentation only")).toBeTruthy();
    fireEvent.click(screen.getByText("A defect to fix"));
    expect(applyTags).toHaveBeenCalledWith("api-a1", { add: ["bug"], remove: [] });
  });

  it("hides the add control when every catalog tag is already applied", () => {
    renderTags(["bug", "docs"]);
    expect(screen.queryByLabelText("Add tag")).toBeNull();
  });
});
