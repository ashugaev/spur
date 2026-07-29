import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationView } from "@/components/ConversationView";
import type { TranscriptEntry } from "@/lib/types";

describe("ConversationView", () => {
  it("renders nothing when there are no entries or messages", () => {
    const { container } = render(
      <ConversationView
        entries={[]}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a message entry as a chat bubble", () => {
    const entries: TranscriptEntry[] = [
      { kind: "message", role: "user", text: "Fix the auth bug", timestampMs: 1 },
      { kind: "message", role: "assistant", text: "On it.", timestampMs: 2 },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={60_000}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /dialog/i })).toBeInTheDocument();
    expect(screen.getByText("Fix the auth bug")).toBeInTheDocument();
    expect(screen.getByText("On it.")).toBeInTheDocument();
  });

  it("renders a tool entry as a compact secondary row", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool",
        name: "Bash",
        callId: "call-1",
        inputSummary: "git status",
        output: "nothing to commit",
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("git status")).toBeInTheDocument();
    expect(screen.getByText("nothing to commit")).toBeInTheDocument();
  });

  it("labels tool input and output with in:/out: prefixes", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool",
        name: "Bash",
        callId: "call-1",
        inputSummary: "git status",
        output: "nothing to commit",
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText("in:")).toBeInTheDocument();
    expect(screen.getByText("out:")).toBeInTheDocument();
  });

  it("renders a reasoning entry as a muted row", () => {
    const entries: TranscriptEntry[] = [
      { kind: "reasoning", text: "Considering the best approach", timestampMs: 1 },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText("Considering the best approach")).toBeInTheDocument();
  });

  it("renders a claude single-select question as a numbered list when read only (non-claude agent)", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Confirm action",
        prompt: "Delete the branch?",
        options: [
          { label: "Yes", index: 1 },
          { label: "No", index: 2 },
        ],
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="codex"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText("Confirm action")).toBeInTheDocument();
    expect(screen.getByText("Delete the branch?")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getByText(/reply from the message box/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Answer options")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /yes/i })).not.toBeInTheDocument();
  });

  it("renders a question entry without options as header/prompt only", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Approve?",
        prompt: "Type y or n in the terminal",
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText("Approve?")).toBeInTheDocument();
    expect(screen.getByText("Type y or n in the terminal")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders claude single-select options as clickable buttons and submits the chosen index", () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}));
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Confirm action",
        prompt: "Delete the branch?",
        options: [
          { label: "Yes", index: 1 },
          { label: "No", index: 2 },
        ],
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={onAnswer}
      />,
    );

    const yesButton = screen.getByRole("button", { name: /yes/i });
    const noButton = screen.getByRole("button", { name: /no/i });
    fireEvent.click(yesButton);

    expect(onAnswer).toHaveBeenCalledWith(1);
    expect(yesButton).toBeDisabled();
    expect(noButton).toBeDisabled();
    expect(screen.getByText(/answering/i)).toBeInTheDocument();
  });

  it("moves a question from pending to answered when onAnswer resolves, keeping buttons disabled", async () => {
    let resolveAnswer: (() => void) | undefined;
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Confirm action",
        prompt: "Delete the branch?",
        options: [
          { label: "Yes", index: 1 },
          { label: "No", index: 2 },
        ],
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={onAnswer}
      />,
    );

    const yesButton = screen.getByRole("button", { name: /yes/i });
    fireEvent.click(yesButton);
    expect(screen.getByText(/answering/i)).toBeInTheDocument();

    resolveAnswer?.();
    await screen.findByText("Answered: Yes");

    expect(screen.getByRole("button", { name: /yes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /no/i })).toBeDisabled();
  });

  it("moves a question from pending to error when onAnswer rejects, re-enabling buttons for retry", async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error("network error"));
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Confirm action",
        prompt: "Delete the branch?",
        options: [
          { label: "Yes", index: 1 },
          { label: "No", index: 2 },
        ],
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={onAnswer}
      />,
    );

    const yesButton = screen.getByRole("button", { name: /yes/i });
    fireEvent.click(yesButton);
    expect(screen.getByText(/answering/i)).toBeInTheDocument();

    await screen.findByText(/couldn't send/i);

    expect(screen.getByRole("button", { name: /yes/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /no/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/answering/i)).toBeInTheDocument();

    await screen.findByText(/couldn't send/i);
  });

  it("gives answer option buttons a focus-visible affordance and disabled opacity convention", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Confirm action",
        prompt: "Delete the branch?",
        options: [{ label: "Yes", index: 1 }],
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    const yesButton = screen.getByRole("button", { name: /yes/i });
    expect(yesButton.className).toContain("focus-visible:border-[var(--color-accent)]");
    expect(yesButton.className).toContain("focus-visible:text-[var(--color-text-primary)]");
    expect(yesButton.className).toContain("disabled:opacity-50");
  });

  it("keeps the static list for a claude multi-select question", () => {
    const onAnswer = vi.fn();
    const entries: TranscriptEntry[] = [
      {
        kind: "question",
        header: "Pick reviewers",
        prompt: "Select all that apply",
        options: [
          { label: "Alice", index: 1 },
          { label: "Bob", index: 2 },
        ],
        multiSelect: true,
        timestampMs: 1,
      },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={onAnswer}
      />,
    );

    expect(screen.queryByRole("button", { name: /alice/i })).not.toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/reply from the message box/i)).toBeInTheDocument();
  });

  it("falls back to rendering messages as bubbles when entries is empty", () => {
    render(
      <ConversationView
        entries={[]}
        messages={[
          { role: "user", text: "Original prompt", timestampMs: 1 },
          { role: "assistant", text: "First reply", timestampMs: 2 },
        ]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText("Original prompt")).toBeInTheDocument();
    expect(screen.getByText("First reply")).toBeInTheDocument();
  });

  it("shows the pending assistant indicator when isWorking is true", () => {
    render(
      <ConversationView
        entries={[{ kind: "message", role: "user", text: "Go", timestampMs: 1 }]}
        messages={[]}
        durationMs={0}
        isWorking
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Assistant is responding")).toHaveTextContent("...");
  });

  it("does not show the pending indicator when isWorking is false", () => {
    render(
      <ConversationView
        entries={[{ kind: "message", role: "user", text: "Go", timestampMs: 1 }]}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Assistant is responding")).not.toBeInTheDocument();
  });

  it("still renders the pending row when isWorking is true and there are no entries", () => {
    render(
      <ConversationView
        entries={[]}
        messages={[]}
        durationMs={0}
        isWorking
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Assistant is responding")).toBeInTheDocument();
  });

  it("renders a message entry without truncating long text", () => {
    const longText = "a".repeat(600);
    const entries: TranscriptEntry[] = [
      { kind: "message", role: "assistant", text: longText, timestampMs: 1 },
    ];
    render(
      <ConversationView
        entries={entries}
        messages={[]}
        durationMs={0}
        isWorking={false}
        agent="claude"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText(longText)).toBeInTheDocument();
  });
});
