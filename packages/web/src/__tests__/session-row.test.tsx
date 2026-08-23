import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRow } from "@/components/SessionRow.js";
import type { DashboardSession, SpurSessionLink } from "@/lib/types.js";

const useSessionLinkPrInfoMock = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/SessionLinkBadge.js", () => ({
  useSessionLinkPrInfo: (...args: Parameters<typeof useSessionLinkPrInfoMock>) =>
    useSessionLinkPrInfoMock(...args),
  SessionLinkBadge: ({ link }: { link: SpurSessionLink }) => {
    const pr = link.url.match(/\/pull\/(\d+)/);
    const tracker = link.url.match(/\/browse\/([A-Z]+-\d+)/);
    const text = pr ? `#${pr[1]}` : (tracker?.[1] ?? link.label);
    return <a href={link.url}>{text}</a>;
  },
}));

function makeSession(overrides?: Partial<DashboardSession>): DashboardSession {
  return {
    id: "api-a1",
    projectId: "api",
    projectName: "api",
    agent: "codex",
    title: "Remove row link strip",
    prompt: "Remove row link strip",
    startupAttachmentIds: [],
    branch: "feature/remove-row-link-strip",
    worktree: true,
    tmuxSession: "api-a1",
    status: "running",
    state: "needs_input",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    lastActivityAt: "2026-05-10T09:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/api-a1",
    services: [],
    artifacts: [],
    queuedMessages: {
      messages: [],
      awaitingPrompt: false,
    },
    sidecars: [],
    runningSidecars: [],
    links: [
      { label: "tracker", url: "https://jira.example.com/browse/WEBDEV-4617" },
      { label: "github-pr", url: "https://github.com/test/repo/pull/42" },
    ],
    hasServiceIssues: false,
    ...overrides,
  };
}

const onRestoreSession = vi.fn().mockResolvedValue(undefined);
const onCompleteSession = vi.fn().mockResolvedValue(undefined);

describe("SessionRow", () => {
  beforeEach(() => {
    onCompleteSession.mockReset();
    onCompleteSession.mockResolvedValue(undefined);
    onRestoreSession.mockReset();
    onRestoreSession.mockResolvedValue(undefined);
  });

  it("renders tracker and PR badges alongside the merge action", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession()}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Remove row link strip" })).toHaveAttribute(
      "href",
      "/sessions/api-a1",
    );
    expect(screen.getByRole("link", { name: /WEBDEV-4617/i })).toHaveAttribute(
      "href",
      "https://jira.example.com/browse/WEBDEV-4617",
    );
    expect(screen.getByRole("link", { name: /#42/ })).toHaveAttribute(
      "href",
      "https://github.com/test/repo/pull/42",
    );
    expect(screen.getByRole("button", { name: "Merge PR for api-a1" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open web terminal for api-a1" }),
    ).not.toBeInTheDocument();
  });

  it("renders badges and the done action when PR state is merged", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "merged",
      reviewDecision: null,
      ciStatus: "success",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession()}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Mark api-a1 as done" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /WEBDEV-4617/i })).toHaveAttribute(
      "href",
      "https://jira.example.com/browse/WEBDEV-4617",
    );
    expect(screen.getByRole("link", { name: /#42/ })).toHaveAttribute(
      "href",
      "https://github.com/test/repo/pull/42",
    );
  });

  it("renders the done action when PR state is closed", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "closed",
      reviewDecision: null,
      ciStatus: null,
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession()}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(screen.getByRole("button", { name: "Mark api-a1 as done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge PR for api-a1" })).not.toBeInTheDocument();
  });

  it("shows done rather than restore for a restorable session with a closed PR", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "closed",
      reviewDecision: null,
      ciStatus: null,
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          runtimeAlive: false,
          tmuxSession: null,
          status: "errored",
          state: "error",
          error: "Agent runtime exited unexpectedly.",
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(screen.getByRole("button", { name: "Mark api-a1 as done" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore session api-a1" }),
    ).not.toBeInTheDocument();
  });

  it("shows interval wake timer details from the row marker", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          intervalWake: {
            nextDueAt: new Date(Date.now() + 300_000).toISOString(),
            intervalMs: 300_000,
            message: "Check CI",
            stopCondition: "CI is green",
          },
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Interval wake scheduled"));

    expect(screen.getByText("Interval wake")).toBeInTheDocument();
    expect(screen.getByText(/in \d+m/)).toBeInTheDocument();
    expect(screen.getByText("every 5m")).toBeInTheDocument();
    expect(screen.getByText("until CI is green")).toBeInTheDocument();
    expect(screen.getByText("Check CI")).toBeInTheDocument();
  });

  it("renders ToDo progress geometry and all five counts", () => {
    useSessionLinkPrInfoMock.mockReturnValue({ state: "open", canMerge: false });
    render(
      <SessionRow
        session={makeSession({
          todo: {
            kind: "summary",
            revision: "rev-1",
            status: "active",
            counts: { total: 5, open: 2, held: 1, completed: 1, cancelled: 1 },
          },
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    const trigger = screen.getByRole("button", { name: "2 of 5 ToDo items resolved" });
    expect(trigger).toHaveClass("h-5", "w-5");
    const progress = trigger.querySelector('circle[transform="rotate(-90 10 10)"]');
    expect(progress).toHaveAttribute("cx", "10");
    expect(progress).toHaveAttribute("cy", "10");
    expect(progress).toHaveAttribute("r", "7");
    expect(progress).toHaveAttribute("stroke-width", "2");
    fireEvent.click(trigger);
    expect(screen.getByText("ToDo Progress")).toBeInTheDocument();
    for (const count of ["Total", "Open", "Held", "Completed", "Cancelled"]) {
      expect(screen.getByText(count)).toBeInTheDocument();
    }
  });

  it("renders explicit ToDo errors without a progress ring", () => {
    useSessionLinkPrInfoMock.mockReturnValue({ state: "open", canMerge: false });
    render(
      <SessionRow
        session={makeSession({ todo: { kind: "error", code: "todo_ledger_corrupt" } })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    const trigger = screen.getByRole("button", { name: "ToDo ledger corrupt" });
    expect(trigger.querySelector('circle[transform="rotate(-90 10 10)"]')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("ToDo ledger corrupt")).toBeInTheDocument();
  });

  it("keeps ToDo, wake, and sidecar popovers mutually exclusive", () => {
    useSessionLinkPrInfoMock.mockReturnValue({ state: "open", canMerge: false });
    render(
      <SessionRow
        session={makeSession({
          todo: {
            kind: "summary",
            revision: "rev-1",
            status: "held",
            counts: { total: 1, open: 0, held: 1, completed: 0, cancelled: 0 },
          },
          scheduledWake: { dueAt: new Date(Date.now() + 60_000).toISOString(), message: "Wake" },
          runningSidecars: [{ name: "web" }],
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "0 of 1 ToDo items resolved" }));
    expect(screen.getByText("ToDo Progress")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Wake scheduled" }));
    expect(screen.queryByText("ToDo Progress")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Running sidecars for api-a1" }));
    expect(screen.queryByText("Wake")).not.toBeInTheDocument();
    expect(screen.getByText("Running Sidecars")).toBeInTheDocument();
  });

  it("shows one-shot wake timer details from the row marker", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          scheduledWake: {
            dueAt: new Date(Date.now() + 120_000).toISOString(),
            message: "Ask user for status",
          },
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Wake scheduled"));

    expect(screen.getByText("Wake")).toBeInTheDocument();
    expect(screen.getByText(/in \d+m/)).toBeInTheDocument();
    expect(screen.getByText("Ask user for status")).toBeInTheDocument();
  });

  it("shows exact running sidecar names and links from the row marker", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          runningSidecars: [
            { name: "isolated-ui", url: "http://127.0.0.1:5625/" },
            { name: "extremely-long-running-sidecar-name-for-overflow-verification" },
          ],
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Running sidecars for api-a1"));

    expect(screen.getByText("Running Sidecars")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "isolated-ui" })).toHaveAttribute(
      "href",
      "http://127.0.0.1:5625/",
    );
    expect(
      screen.getByText("extremely-long-running-sidecar-name-for-overflow-verification"),
    ).toHaveClass("break-all");
    expect(
      screen.queryByRole("link", {
        name: "extremely-long-running-sidecar-name-for-overflow-verification",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start sidecar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop sidecar/i })).not.toBeInTheDocument();
  });

  it("colors a dashboard sidecar age by ageWarn, not a fresh sidecar's age", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          runningSidecars: [
            { name: "stale-sidecar", ageSeconds: 50_000, ageWarn: true },
            { name: "fresh-sidecar", ageSeconds: 5, ageWarn: false },
          ],
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Running sidecars for api-a1"));

    const staleAge = screen.getByTestId("dashboard-sidecar-age-stale-sidecar");
    const freshAge = screen.getByTestId("dashboard-sidecar-age-fresh-sidecar");
    expect(staleAge).toHaveClass("text-[var(--color-status-attention)]");
    expect(freshAge).toHaveClass("text-[var(--color-text-tertiary)]");
    expect(freshAge).not.toHaveClass("text-[var(--color-status-attention)]");
  });

  it("shows daily wake timer details from the row marker", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          dailyWake: {
            dailyAt: ["09:00", "17:00"],
            nextDueAt: new Date(Date.now() + 300_000).toISOString(),
            message: "Check daily state",
            stopCondition: "Daily checks done",
          },
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Daily wake scheduled"));

    expect(screen.getByText("Daily wake")).toBeInTheDocument();
    expect(screen.getByText(/in \d+m/)).toBeInTheDocument();
    expect(screen.getByText("daily 09:00, 17:00")).toBeInTheDocument();
    expect(screen.getByText("until Daily checks done")).toBeInTheDocument();
    expect(screen.getByText("Check daily state")).toBeInTheDocument();
  });

  it("keeps wake and running sidecar popovers mutually exclusive", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          dailyWake: {
            dailyAt: ["09:00"],
            nextDueAt: new Date(Date.now() + 300_000).toISOString(),
            message: "Check daily state",
          },
          runningSidecars: [{ name: "isolated-ui" }],
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    const wakeButton = screen.getByLabelText("Daily wake scheduled");
    const sidecarButton = screen.getByLabelText("Running sidecars for api-a1");

    fireEvent.click(wakeButton);

    expect(wakeButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Daily wake")).toBeInTheDocument();
    expect(screen.queryByText("Running Sidecars")).not.toBeInTheDocument();

    fireEvent.click(sidecarButton);

    expect(wakeButton).toHaveAttribute("aria-expanded", "false");
    expect(sidecarButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Daily wake")).not.toBeInTheDocument();
    expect(screen.getByText("Running Sidecars")).toBeInTheDocument();
    expect(screen.getByText("isolated-ui")).toBeInTheDocument();
  });

  it("shows restore for restorable errored sessions", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          runtimeAlive: false,
          tmuxSession: null,
          status: "errored",
          state: "error",
          error: "Agent runtime exited unexpectedly.",
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(screen.getByRole("button", { name: "Restore session api-a1" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open web terminal for api-a1" }),
    ).not.toBeInTheDocument();
  });

  it("shows restore for a stale-parked session", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          runtimeAlive: false,
          status: "stopped",
          state: "stale",
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(screen.getByRole("button", { name: "Restore session api-a1" })).toBeInTheDocument();
  });

  it("hides restore when the workspace no longer exists", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession({
          runtimeAlive: false,
          workspaceExists: false,
          tmuxSession: null,
          status: "errored",
          state: "error",
          error: "Agent runtime exited unexpectedly.",
        })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Restore session api-a1" }),
    ).not.toBeInTheDocument();
  });

  it("dims attention text after the session has been opened", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    const { rerender } = render(
      <SessionRow
        session={makeSession({ hasUnseenAttention: true })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    const titleLink = screen.getByRole("link", { name: "Remove row link strip" });
    expect(titleLink).toHaveClass("text-[var(--color-text-primary)]");
    expect(titleLink).not.toHaveClass("opacity-70");

    rerender(
      <SessionRow
        session={makeSession({ hasUnseenAttention: false })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    expect(titleLink).toHaveClass("opacity-70");
  });

  it("does not dim row text for non-needs_input states even when unseen", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    for (const state of ["working", "waiting", "stale", "stopped", "error"] as const) {
      const { unmount } = render(
        <SessionRow
          session={makeSession({ state, hasUnseenAttention: false })}
          onCompleteSession={onCompleteSession}
          onRestoreSession={onRestoreSession}
        />,
      );

      const titleLink = screen.getByRole("link", { name: "Remove row link strip" });
      expect(titleLink).not.toHaveClass("opacity-70");
      expect(titleLink).toHaveClass("text-[var(--color-text-secondary)]");
      unmount();
    }
  });

  it("keeps a needs_input row bright when the viewed marker is absent", () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });

    render(
      <SessionRow
        session={makeSession()}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    const titleLink = screen.getByRole("link", { name: "Remove row link strip" });
    expect(titleLink).toHaveClass("text-[var(--color-text-primary)]");
    expect(titleLink).not.toHaveClass("opacity-70");
  });

  it("delegates the done action and re-enables on failure", async () => {
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "merged",
      reviewDecision: null,
      ciStatus: "success",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });
    onCompleteSession.mockRejectedValue(new Error("Complete failed"));

    render(
      <SessionRow
        session={makeSession()}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    const doneButton = screen.getByRole("button", { name: "Mark api-a1 as done" });
    fireEvent.click(doneButton);

    expect(doneButton).toBeDisabled();
    await waitFor(() => {
      expect(onCompleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: "api-a1" }));
      expect(doneButton).not.toBeDisabled();
    });
  });
});
