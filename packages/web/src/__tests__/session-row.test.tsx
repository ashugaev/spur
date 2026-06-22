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
    runningSidecarNames: [],
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

  it("shows exact running sidecar names from the row marker", () => {
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
        session={makeSession({ runningSidecarNames: ["isolated-ui", "preview"] })}
        onCompleteSession={onCompleteSession}
        onRestoreSession={onRestoreSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Running sidecars for api-a1"));

    expect(screen.getByText("Running Sidecars")).toBeInTheDocument();
    expect(screen.getByText("isolated-ui")).toBeInTheDocument();
    expect(screen.getByText("preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start sidecar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop sidecar/i })).not.toBeInTheDocument();
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
