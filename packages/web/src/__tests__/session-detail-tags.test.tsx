import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagEditor } from "@/components/TagEditor.js";
import { TagsContext, type TagsContextValue } from "@/components/TagsContext.js";
import type { DashboardSession } from "@/lib/types.js";

// SessionDetail wraps the metadata row in a TagsContext.Provider and renders
// <TagEditor variant="chips" />. Mounting the whole detail view in isolation
// pulls in the router and its polling fetch, so this mirrors that exact wiring:
// a chips editor fed by a detail-supplied catalog + applyTags.
const applyTags = vi.fn().mockResolvedValue(undefined);

const catalog = [
  { name: "bug", description: "A defect to fix", color: "hsl(0 62% 64%)" },
  { name: "docs", description: "Documentation only", color: "hsl(120 62% 64%)" },
];

function renderDetailTags(tags: string[]) {
  const session = { id: "api-detail", tags } as unknown as DashboardSession;
  const value: TagsContextValue = { catalog, applyTags };
  return render(
    <TagsContext.Provider value={value}>
      <TagEditor session={session} variant="chips" />
    </TagsContext.Provider>,
  );
}

describe("SessionDetail tag wiring", () => {
  beforeEach(() => {
    applyTags.mockReset();
    applyTags.mockResolvedValue(undefined);
  });

  it("renders full-name chips for the session's tags", () => {
    renderDetailTags(["bug"]);
    expect(screen.getByText("bug")).toBeTruthy();
  });

  it("adds a tag through the popover using the provided applyTags", () => {
    renderDetailTags([]);
    fireEvent.click(screen.getByLabelText("Manage tags"));
    fireEvent.click(screen.getByText("A defect to fix"));
    expect(applyTags).toHaveBeenCalledWith("api-detail", { add: ["bug"], remove: [] });
  });

  it("removes a tag through the popover using the provided applyTags", () => {
    renderDetailTags(["bug"]);
    fireEvent.click(screen.getByLabelText("Manage tags"));
    fireEvent.click(screen.getByLabelText("Remove tag bug"));
    expect(applyTags).toHaveBeenCalledWith("api-detail", { add: [], remove: ["bug"] });
  });
});
