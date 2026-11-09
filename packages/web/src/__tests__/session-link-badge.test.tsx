import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionLinkBadge } from "@/components/SessionLinkBadge.js";
import type * as LinkIconsModule from "@/lib/link-icons.js";
import type { PrInfo } from "@/lib/pr-status-shape.js";

const usePrInfoMock = vi.fn();

vi.mock("@/lib/link-icons.js", async () => {
  const actual = await vi.importActual<typeof LinkIconsModule>("@/lib/link-icons.js");
  return {
    ...actual,
    usePrInfo: (...args: Parameters<typeof usePrInfoMock>) => usePrInfoMock(...args),
  };
});

describe("SessionLinkBadge", () => {
  const info: PrInfo = {
    state: "open",
    reviewDecision: "approved",
    ciStatus: "success",
    canMerge: true,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
    reviewers: { approved: ["alice", "bob"], changesRequested: ["carol"] },
  };

  it("shows separate person counts and names while preserving the approved composite", () => {
    const { container } = render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/101" }}
        prInfo={info}
      />,
    );
    expect(screen.getByTitle(/Approved · 2/)).toHaveTextContent("2");
    expect(screen.getByTitle(/Approved · 2/)).toHaveAttribute(
      "title",
      "Approved · 2\n@alice\n@bob",
    );
    expect(screen.getByTitle(/Changes requested · 1/)).toHaveTextContent("1");
    expect(screen.getByLabelText("Approved")).toBeInTheDocument();
    expect(
      container.querySelector("[data-pr-review-decision='approved'] svg")?.querySelectorAll("path"),
    ).toHaveLength(4);
    expect(screen.getByTitle(/CI passing/)).toHaveAttribute("title", "CI passing\nReview approved");
  });

  it("explains required review without inventing a deficit or changing the CI mark", () => {
    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/102" }}
        prInfo={{
          ...info,
          reviewDecision: "review_required",
          reviewers: { approved: ["alice"], changesRequested: [] },
        }}
      />,
    );
    expect(screen.getByTitle(/GitHub requires review/)).toHaveAttribute(
      "title",
      "CI passing\nGitHub requires review\nRemaining required approvals: unknown",
    );
    expect(screen.getByLabelText("CI passing")).toBeInTheDocument();
    expect(screen.getByTitle(/Approved · 1/)).toHaveAttribute("title", "Approved · 1\n@alice");
    expect(screen.queryByLabelText(/Changes requested ·/)).not.toBeInTheDocument();
  });

  it.each([null, undefined, { approved: [], changesRequested: [] }])(
    "hides zero or unknown reviewer groups (%j)",
    (reviewers) => {
      render(
        <SessionLinkBadge
          link={{ label: "pr", url: "https://github.com/org/repo/pull/103" }}
          prInfo={{ ...info, reviewers }}
        />,
      );
      expect(screen.queryByTitle(/Approved ·/)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Changes requested ·/)).not.toBeInTheDocument();
    },
  );

  it("keeps people metadata independent from failing CI and explains the conflict", () => {
    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/104" }}
        prInfo={{
          ...info,
          ciStatus: "failure",
          reviewDecision: "changes_requested",
          mergeConflict: true,
        }}
      />,
    );
    expect(screen.getByLabelText("CI failing")).toBeInTheDocument();
    expect(screen.getByTitle(/CI failing/)).toHaveAttribute(
      "title",
      "CI failing\nChanges requested\nMerge conflict",
    );
    expect(screen.getByTitle(/Approved · 2/)).toBeInTheDocument();
    expect(screen.getByTitle(/Changes requested · 1/)).toBeInTheDocument();
  });

  it("uses fetched reviewer data and omits GitHub metadata on GitLab links", () => {
    usePrInfoMock.mockReturnValue(info);
    const { rerender } = render(
      <SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/105" }} />,
    );
    expect(screen.getByTitle(/Approved · 2/)).toBeInTheDocument();
    rerender(
      <SessionLinkBadge
        link={{ label: "gitlab-pr", url: "https://gitlab.example/org/repo/-/merge_requests/105" }}
        prInfo={info}
      />,
    );
    expect(screen.queryByTitle(/Approved ·/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Approved")).toBeInTheDocument();
  });

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
          mergeConflict: false,
          totalThreads: 2,
          unresolvedThreads: 0,
        }}
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

    render(<SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/42" }} />);

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

    render(<SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/55" }} />);

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

    render(<SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/60" }} />);

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

    render(<SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/61" }} />);

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
      <SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/62" }} />,
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

    render(<SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/63" }} />);

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

    render(<SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/64" }} />);

    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
    expect(screen.getByLabelText("CI passing")).toBeInTheDocument();
  });

  it("renders merge-conflict badge when prInfo reports a conflict", () => {
    usePrInfoMock.mockReturnValue({
      state: null,
      reviewDecision: null,
      ciStatus: null,
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/70" }}
        prInfo={{
          state: "open",
          reviewDecision: null,
          ciStatus: "success",
          canMerge: false,
          mergeConflict: true,
          totalThreads: 0,
          unresolvedThreads: 0,
        }}
      />,
    );

    expect(screen.getByLabelText("Merge conflict")).toBeInTheDocument();
  });

  it("omits merge-conflict badge when prInfo reports no conflict", () => {
    usePrInfoMock.mockReturnValue({
      state: null,
      reviewDecision: null,
      ciStatus: null,
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    });

    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/71" }}
        prInfo={{
          state: "open",
          reviewDecision: null,
          ciStatus: "success",
          canMerge: true,
          mergeConflict: false,
          totalThreads: 0,
          unresolvedThreads: 0,
        }}
      />,
    );

    expect(screen.queryByLabelText("Merge conflict")).not.toBeInTheDocument();
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
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("WEB-42");
    expect(screen.queryByLabelText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Changes requested")).not.toBeInTheDocument();
  });
});
