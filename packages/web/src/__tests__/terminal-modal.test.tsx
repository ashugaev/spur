import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({
    onClose,
    title,
    model,
  }: {
    onClose: () => void;
    title?: string;
    model?: string;
  }) => (
    <div data-testid="direct-terminal" data-model={model} data-title={title}>
      <button onClick={onClose} type="button">
        close
      </button>
    </div>
  ),
}));

import { TerminalModal } from "@/components/TerminalModal";
import type { DashboardSession } from "@/lib/types";

function makeSession(): DashboardSession {
  return {
    id: "sess-1",
    projectId: "proj",
    projectName: "Project",
    agent: "claude",
    title: "My session",
    prompt: "",
    startupAttachmentIds: [],
    branch: null,
    worktree: false,
    tmuxSession: "tmux-1",
    status: "running",
    state: "working",
    createdAt: "",
    updatedAt: "",
    lastActivityAt: "",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "",
    services: [],
    artifacts: [],
    queuedMessages: { messages: [], awaitingPrompt: false },
    sidecars: [],
    links: [],
    hasServiceIssues: false,
    deskKey: "",
  } as DashboardSession;
}

describe("TerminalModal", () => {
  it("renders the mocked DirectTerminal", () => {
    render(<TerminalModal session={makeSession()} onClose={() => undefined} />);
    expect(screen.getByTestId("direct-terminal")).toBeInTheDocument();
  });

  it("renders a dialog with the session id in its aria label", () => {
    render(<TerminalModal session={makeSession()} onClose={() => undefined} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Terminal sess-1");
  });

  it("invokes onClose when the close action fires", () => {
    const onClose = vi.fn();
    render(<TerminalModal session={makeSession()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("passes the session model through to DirectTerminal", () => {
    const session = { ...makeSession(), model: "claude-model-id" };
    render(<TerminalModal session={session} onClose={() => undefined} />);
    expect(screen.getByTestId("direct-terminal")).toHaveAttribute("data-model", "claude-model-id");
  });

  it("omits the model attribute when the session has no model", () => {
    render(<TerminalModal session={makeSession()} onClose={() => undefined} />);
    expect(screen.getByTestId("direct-terminal")).not.toHaveAttribute("data-model");
  });
});
