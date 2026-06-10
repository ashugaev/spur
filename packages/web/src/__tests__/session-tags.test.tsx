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

describe("SessionTags", () => {
  beforeEach(() => {
    applyTags.mockReset();
    applyTags.mockResolvedValue(undefined);
  });

  it("renders an applied tag chip with its catalog color and a remove control", () => {
    renderTags(["bug"]);
    const chip = screen.getByText("bug");
    expect(chip).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Remove tag bug"));
    expect(applyTags).toHaveBeenCalledWith("api-a1", { add: [], remove: ["bug"] });
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
