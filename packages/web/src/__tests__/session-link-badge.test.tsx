import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    reviewRequirement: "required",
  };

  it("shows one red person with approval count and both name groups, preserving the old composite", () => {
    const { container } = render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/101" }}
        prInfo={info}
      />,
    );
    const people = container.querySelectorAll("[data-pr-reviewers]");
    expect(people).toHaveLength(1);
    expect(people[0]).toHaveTextContent("2");
    expect(people[0]).toHaveClass("text-[var(--color-status-error)]");
    expect(people[0]).toHaveAttribute(
      "aria-label",
      "Changes requested\nApprovals: 2 · @alice, @bob\nChanges requested: 1 · @carol",
    );
    expect(people[0]).not.toHaveAttribute("title");
    expect(people[0]?.closest("[title]")).toBeNull();
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
      "CI passing\nGitHub requires review",
    );
    expect(screen.getByLabelText("CI passing")).toBeInTheDocument();
    const person = screen.getByLabelText(/Approvals: 1/);
    expect(person).toHaveTextContent("1");
    expect(person).toHaveClass("text-[var(--color-status-attention)]");
    expect(person).toHaveAttribute(
      "aria-label",
      "Review required\nApprovals: 1 · @alice\nChanges requested: 0",
    );
  });

  const emptyReviewers = [null, { approved: [], changesRequested: [], pending: [] }] as const;
  const populatedReviewers = [
    { approved: ["alice"], changesRequested: [] },
    { approved: [], changesRequested: ["carol"] },
    { approved: [], changesRequested: [], pending: [{ name: "core", team: true }] },
  ] as const;
  const optionalRequirements = ["none", "unavailable", undefined] as const;

  it.each(optionalRequirements.flatMap((r) => emptyReviewers.map((rv) => [r, rv] as const)))(
    "hides the reviewer badge without reviews or requests (%s, %j)",
    (reviewRequirement, reviewers) => {
      const { container } = render(
        <SessionLinkBadge
          link={{ label: "pr", url: "https://github.com/org/repo/pull/103" }}
          prInfo={{ ...info, reviewRequirement, reviewers: reviewers ? { ...reviewers } : null }}
        />,
      );
      expect(container.querySelector("[data-pr-reviewers]")).toBeNull();
    },
  );

  it.each(optionalRequirements.flatMap((r) => populatedReviewers.map((rv) => [r, rv] as const)))(
    "shows the reviewer badge for any review or request (%s, %j)",
    (reviewRequirement, reviewers) => {
      const { container } = render(
        <SessionLinkBadge
          link={{ label: "pr", url: "https://github.com/org/repo/pull/103" }}
          prInfo={{
            ...info,
            reviewRequirement,
            reviewDecision: null,
            reviewers: {
              ...reviewers,
              pending: "pending" in reviewers ? [...reviewers.pending] : [],
            },
          }}
        />,
      );
      expect(container.querySelectorAll("[data-pr-reviewers]")).toHaveLength(1);
    },
  );

  it("shows the reviewer badge when GitHub requires review and reviewers are unknown", () => {
    const { container } = render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/103" }}
        prInfo={{ ...info, reviewers: null, reviewRequirement: "required" }}
      />,
    );
    expect(container.querySelector("[data-pr-reviewers]")).not.toBeNull();
  });

  describe("hover cards", () => {
    const cardInfo: PrInfo = {
      ...info,
      ciStatus: "failure",
      reviewDecision: null,
      reviewRequirement: "none",
      reviewers: {
        approved: ["xena", "alice"],
        changesRequested: ["yuri", "alice"],
        pending: [
          { name: "core", team: true },
          { name: "zed", team: false },
        ],
      },
      checks: [
        { name: "lint", state: "passed" },
        { name: "e2e", state: "pending" },
        { name: "test", state: "failed" },
        { name: "gate", state: "failed" },
      ],
    };

    function renderBadge(prInfo: PrInfo = cardInfo) {
      return render(
        <SessionLinkBadge
          link={{ label: "pr", url: "https://github.com/org/repo/pull/200" }}
          prInfo={prInfo}
        />,
      );
    }

    function open(trigger: HTMLElement) {
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }

    function rows() {
      return [...document.querySelectorAll("[data-pr-card-row]")].map((row) => ({
        text: row.textContent,
        tone: row.querySelector("[data-pr-card-dot]")?.getAttribute("data-pr-card-dot"),
      }));
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("orders reviewer rows changes requested, pending, approved without duplicates", () => {
      const { container } = renderBadge();
      const trigger = container.querySelector("[data-pr-reviewers]")?.parentElement as HTMLElement;
      expect(trigger).not.toHaveAttribute("title");
      open(trigger);
      expect(rows()).toEqual([
        { text: "@yuri", tone: "error" },
        { text: "@alice", tone: "error" },
        { text: "coreteam", tone: "attention" },
        { text: "@zed", tone: "attention" },
        { text: "@xena", tone: "ready" },
      ]);
      expect(document.querySelector("[data-pr-card]")?.closest("a")).toBeNull();
    });

    it("orders check rows failed, pending, passed with no totals", () => {
      const { container } = renderBadge();
      open(container.querySelector("[aria-label='CI failing']")?.parentElement as HTMLElement);
      expect(rows()).toEqual([
        { text: "test", tone: "error" },
        { text: "gate", tone: "error" },
        { text: "e2e", tone: "attention" },
        { text: "lint", tone: "ready" },
      ]);
      expect(document.querySelector("[data-pr-card-more]")).toBeNull();
      expect(document.querySelector("[data-pr-card]")?.closest("a")).toBeNull();
    });

    it("caps checks at 8 rows with a +N more line", () => {
      const checks = Array.from({ length: 13 }, (_, i) => ({
        name: `check-${i}`,
        state: "passed" as const,
      }));
      const { container } = renderBadge({ ...cardInfo, checks });
      open(container.querySelector("[aria-label='CI failing']")?.parentElement as HTMLElement);
      expect(rows()).toHaveLength(8);
      expect(document.querySelector("[data-pr-card-more]")).toHaveTextContent("+5 more");
    });

    it("keeps the native title when no check rows exist", () => {
      const { container } = renderBadge({ ...cardInfo, checks: null });
      const status = container.querySelector("[aria-label='CI failing']")?.parentElement;
      expect(status).toHaveAttribute("title", "CI failing");
      open(status as HTMLElement);
      expect(document.querySelector("[data-pr-card]")).toBeNull();
    });

    it("keeps the card open when the pointer leaves and re-enters within the grace", () => {
      const { container } = renderBadge();
      const trigger = container.querySelector("[data-pr-reviewers]")?.parentElement as HTMLElement;
      open(trigger);
      fireEvent.mouseLeave(trigger);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(document.querySelector("[data-pr-card]")).not.toBeNull();
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(document.querySelector("[data-pr-card]")).not.toBeNull();
      fireEvent.mouseLeave(trigger);
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(document.querySelector("[data-pr-card]")).toBeNull();
    });

    it("does not prevent the desktop click so the badge link opens the PR", () => {
      const { container } = renderBadge();
      const trigger = container.querySelector("[data-pr-reviewers]")?.parentElement as HTMLElement;
      expect(fireEvent.click(trigger)).toBe(true);
    });

    it("pins the card on a touch tap without navigating", () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
      }));
      const { container } = renderBadge();
      const trigger = container.querySelector("[data-pr-reviewers]")?.parentElement as HTMLElement;
      expect(fireEvent.click(trigger)).toBe(false);
      expect(document.querySelector("[data-pr-card]")).not.toBeNull();
      fireEvent.pointerDown(document.body);
      expect(document.querySelector("[data-pr-card]")).toBeNull();
    });
  });

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
    expect(screen.getByLabelText(/Approvals: 2/)).toHaveTextContent("2");
  });

  it("uses fetched reviewer data and omits GitHub metadata on GitLab links", () => {
    usePrInfoMock.mockReturnValue(info);
    const { rerender } = render(
      <SessionLinkBadge link={{ label: "pr", url: "https://github.com/org/repo/pull/105" }} />,
    );
    expect(screen.getByLabelText(/Approvals: 2/)).toBeInTheDocument();
    rerender(
      <SessionLinkBadge
        link={{ label: "gitlab-pr", url: "https://gitlab.example/org/repo/-/merge_requests/105" }}
        prInfo={info}
      />,
    );
    expect(screen.queryByLabelText(/Approvals: 2/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Approved")).toBeInTheDocument();
  });

  it("uses green only for fulfilled required review with no current changes request", () => {
    render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/106" }}
        prInfo={{ ...info, reviewers: { approved: ["alice", "bob"], changesRequested: [] } }}
      />,
    );
    expect(screen.getByLabelText(/Approvals: 2/)).toHaveClass("text-[var(--color-status-ready)]");
  });

  it("gives aggregate changes_requested red priority when reviewer history is unavailable", () => {
    const { container } = render(
      <SessionLinkBadge
        link={{ label: "pr", url: "https://github.com/org/repo/pull/107" }}
        prInfo={{ ...info, reviewDecision: "changes_requested", reviewers: null }}
      />,
    );
    const person = container.querySelector("[data-pr-reviewers]");
    expect(person).toHaveClass("text-[var(--color-status-error)]");
    expect(person).toHaveTextContent("");
    expect(person?.parentElement).toHaveAttribute(
      "title",
      "Changes requested\nReview history unavailable",
    );
  });

  it.each([
    [null, ""],
    [{ approved: [], changesRequested: [] }, "0"],
  ] as const)(
    "distinguishes unknown from complete-empty received history (%j)",
    (reviewers, text) => {
      const { container } = render(
        <SessionLinkBadge
          link={{ label: "pr", url: "https://github.com/org/repo/pull/108" }}
          prInfo={{
            ...info,
            reviewDecision: "review_required",
            reviewers: reviewers ? { approved: [], changesRequested: [] } : null,
          }}
        />,
      );
      const person = container.querySelector("[data-pr-reviewers]");
      expect(person).toHaveTextContent(text);
      expect(person).toHaveClass("text-[var(--color-status-attention)]");
    },
  );

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
