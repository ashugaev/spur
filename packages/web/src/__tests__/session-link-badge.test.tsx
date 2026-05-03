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
      canMerge: false,
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
          canMerge: true,
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

  it("renders compact PR indicators from reviewDecision when CI passes", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      canMerge: true,
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

  it("renders changes-requested composite when CI passes and review requests changes", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "changes_requested",
      ciStatus: "success",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/55" }}
        variant="row"
      />,
    );

    expect(screen.getByLabelText("Changes requested")).toBeInTheDocument();
  });

  it("suppresses review badge when CI is failing", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "failure",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/60" }}
        variant="row"
      />,
    );

    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
  });

  it("suppresses review badge when CI is pending", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/61" }}
        variant="row"
      />,
    );

    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
  });

  it("suppresses review badge and CI dot when CI status is null", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: null,
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    const { container } = render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/62" }}
        variant="row"
      />,
    );

    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
    expect(container.querySelectorAll("svg")).toHaveLength(1); // only the GitHub icon
  });

  it("renders CI passing dot when CI passes but review_required", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "review_required",
      ciStatus: "success",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/63" }}
        variant="row"
      />,
    );

    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
    expect(screen.getByLabelText("CI passing")).toBeInTheDocument();
  });

  it("renders CI passing dot when CI passes but reviewDecision is null", () => {
    usePrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "success",
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/64" }}
        variant="row"
      />,
    );

    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
    expect(screen.getByLabelText("CI passing")).toBeInTheDocument();
  });

  it("renders tracker badges without PR status indicators", () => {
    usePrInfoMock.mockReturnValue({
      state: null,
      reviewDecision: null,
      ciStatus: null,
      canMerge: false,
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
