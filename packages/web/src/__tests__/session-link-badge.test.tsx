import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionLinkBadge } from "@/components/SessionLinkBadge.js";
import type * as LinkIconsModule from "@/lib/link-icons.js";

const usePrInfoMock = vi.fn();

vi.mock("@/lib/link-icons.js", async () => {
  const actual = await vi.importActual<typeof LinkIconsModule>("@/lib/link-icons.js");
  return {
    ...actual,
    usePrInfo: (...args: Parameters<typeof usePrInfoMock>) => usePrInfoMock(...args),
  };
});

describe("SessionLinkBadge", () => {
  it("renders injected PR info without fetching for that badge", () => {
    usePrInfoMock.mockReturnValue({
      state: null,
      reviewDecision: null,
      ciStatus: null,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/99" }}
        prInfo={{
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          totalThreads: 2,
          unresolvedThreads: 0,
        }}
        variant="row"
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("#99");
    expect(screen.getByLabelText("Approved")).toBeInTheDocument();
    expect(usePrInfoMock).toHaveBeenCalledWith(undefined);
  });

  it("renders compact PR indicators from reviewDecision", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      totalThreads: 3,
      unresolvedThreads: 1,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/42" }}
        variant="detail"
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("#42");
    expect(screen.getByLabelText("Approved")).toBeInTheDocument();
    expect(screen.getByTitle("1 unresolved of 3 threads")).toBeInTheDocument();
  });

  it("renders tracker badges without PR status indicators", () => {
    usePrInfoMock.mockReturnValue({
      state: null,
      reviewDecision: null,
      ciStatus: null,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "tracker", url: "https://jira.example.com/browse/WEB-42" }}
        variant="row"
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("WEB-42");
    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
  });
});
