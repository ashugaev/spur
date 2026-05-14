import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionRow } from "@/components/SessionRow.js";
import type { DashboardSession } from "@/lib/types.js";

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
    links: [
      { label: "tracker", url: "https://jira.example.com/browse/WEBDEV-4617" },
      { label: "github-pr", url: "https://github.com/test/repo/pull/42" },
    ],
    hasServiceIssues: false,
    ...overrides,
  };
}

describe("SessionRow", () => {
  it("hides tracker and PR badges while keeping the merge action", () => {
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

    render(<SessionRow session={makeSession()} />);

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Remove row link strip" })).toHaveAttribute(
      "href",
      "/sessions/api-a1",
    );
    expect(screen.queryByRole("link", { name: /WEBDEV-4617/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "#42" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge PR for api-a1" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open web terminal for api-a1" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the done action when PR state is merged", () => {
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

    render(<SessionRow session={makeSession()} />);

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Mark api-a1 as done" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WEBDEV-4617/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "#42" })).not.toBeInTheDocument();
  });
});
