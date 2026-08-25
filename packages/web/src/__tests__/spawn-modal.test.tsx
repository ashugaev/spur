import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpawnModal, type SpawnModalMode } from "@/components/SpawnModal";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";

function makeVoiceInput(overrides: Partial<UseVoiceInput> = {}): UseVoiceInput {
  return {
    canUseVoice: false,
    clearVoiceError: vi.fn(),
    cancelRecording: vi.fn(),
    confirmDraft: vi.fn(),
    discardRetainedTake: vi.fn(),
    dismissModal: vi.fn(),
    hasRetainedTake: false,
    openDraft: vi.fn(),
    playRetainedTake: vi.fn(),
    recording: false,
    retainedTakePlaying: false,
    retryRetainedTake: vi.fn(),
    setVoiceDraft: vi.fn(),
    stopAndSend: vi.fn(),
    toggleRecording: vi.fn(),
    voiceBusy: null,
    voiceDraft: "",
    voiceError: null,
    voiceModalOpen: false,
    ...overrides,
  };
}

const spawnMode: SpawnModalMode = {
  kind: "spawn",
  project: { value: "", onChange: vi.fn(), options: [{ id: "p1", label: "Project One" }] },
  model: {
    value: null,
    onChange: vi.fn(),
    spawnDefaults: { model: null, worktree: null, loading: false, error: null },
    carry: null,
    onResolvedChange: vi.fn(),
  },
  branch: { value: "", onChange: vi.fn() },
  workspaceMode: { value: "worktree", onChange: vi.fn() },
  planMode: { value: false, onChange: vi.fn() },
  selfDestruct: { value: false, onChange: vi.fn() },
  steps: { items: [], onUpdate: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn() },
};

const respawnMode: SpawnModalMode = {
  kind: "respawn",
  model: {
    value: null,
    onChange: vi.fn(),
    spawnDefaults: { model: null, worktree: null, loading: false, error: null },
    carry: null,
    onResolvedChange: vi.fn(),
  },
};

const deskMode: SpawnModalMode = {
  kind: "desk",
  model: {
    value: null,
    onChange: vi.fn(),
    spawnDefaults: { model: null, worktree: null, loading: false, error: null },
    carry: null,
    onResolvedChange: vi.fn(),
  },
  branch: { value: "", onChange: vi.fn() },
  planMode: { value: false, onChange: vi.fn() },
  steps: { items: [], onUpdate: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn() },
};

function renderModal(mode: SpawnModalMode, overrides: Record<string, unknown> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const props = {
    mode,
    title: "Modal",
    onClose,
    canClose: true,
    onSubmit,
    submitting: false,
    submitLabel: "Go",
    submitBusyAriaLabel: "Going",
    submitDisabled: false,
    showCancel: false,
    agent: "claude" as const,
    onAgentChange: vi.fn(),
    agentAriaLabel: "Agent",
    prompt: "",
    onPromptChange: vi.fn(),
    promptRef: createRef<HTMLTextAreaElement>(),
    promptPlaceholder: "Prompt",
    promptMinHeightClass: "min-h-24",
    clearLabel: "Clear",
    attachments: [],
    onAddFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    voice: makeVoiceInput(),
    slashEndpoint: null,
    history: { entries: [], onSelect: vi.fn() },
    ...overrides,
  };
  render(<SpawnModal {...props} />);
  return { onSubmit, onClose };
}

describe("SpawnModal", () => {
  it("spawn mode renders project, workspace, self-destruct, steps, and prompt", () => {
    renderModal(spawnMode);
    expect(screen.getByLabelText("Spawn project")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("branch name")).toBeInTheDocument();
    expect(screen.getByLabelText("workspace mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Plan")).toBeInTheDocument();
    expect(screen.getByLabelText("Self-destruct")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Step" })).toBeInTheDocument();
  });

  it("insets the fullscreen mobile panel on all sides by the display safe area", () => {
    renderModal(spawnMode);
    const panel = screen.getByRole("dialog").firstElementChild;
    expect(panel).not.toBeNull();
    const className = panel?.className ?? "";
    expect(className).toContain("pt-[max(1rem,var(--safe-top))]");
    expect(className).toContain("pb-[max(1rem,var(--safe-bottom))]");
    expect(className).toContain("pl-[max(1rem,var(--safe-left))]");
    expect(className).toContain("pr-[max(1rem,var(--safe-right))]");
    expect(className).not.toMatch(/(^|\s)p-4(\s|$)/);
    expect(className).toContain("sm:p-5");
  });

  it("explains the disabled project select instead of showing a blank box when no projects are configured", () => {
    renderModal({
      ...spawnMode,
      project: { value: "", onChange: vi.fn(), options: [] },
    });
    expect(screen.getByLabelText("Spawn project")).toBeDisabled();
    expect(screen.getByText("No projects configured yet.")).toBeInTheDocument();
  });

  it("spawn mode selects expose only concrete options, never a Default/Select placeholder", () => {
    renderModal(spawnMode);
    const projectOptions = screen.getByLabelText("Spawn project").querySelectorAll("option");
    expect(projectOptions).toHaveLength(
      spawnMode.kind === "spawn" ? spawnMode.project.options.length : 0,
    );
    expect([...projectOptions].map((option) => option.textContent)).toEqual(["Project One"]);

    const workspaceOptions = [
      ...screen.getByLabelText("workspace mode").querySelectorAll("option"),
    ].map((option) => option.textContent);
    expect(workspaceOptions).toEqual(["Worktree", "Shared"]);
  });

  it("spawn mode renders no session mode combobox when sessionMode is undefined", () => {
    renderModal(spawnMode);
    expect(screen.queryByRole("combobox", { name: "Spawn session mode" })).not.toBeInTheDocument();
  });

  it("spawn mode renders the session mode combobox with options and fires onChange", () => {
    const onChange = vi.fn();
    renderModal({
      ...spawnMode,
      sessionMode: {
        value: "manager",
        onChange,
        options: [
          { value: "manager", label: "manager" },
          { value: "council", label: "council" },
        ],
      },
    });
    const select = screen.getByRole("combobox", { name: "Spawn session mode" });
    expect(select).toHaveValue("manager");
    fireEvent.change(select, { target: { value: "council" } });
    expect(onChange).toHaveBeenCalledWith("council");
  });

  it("respawn and desk modes render no session mode combobox", () => {
    renderModal(respawnMode);
    expect(screen.queryByRole("combobox", { name: "Spawn session mode" })).not.toBeInTheDocument();
    renderModal(deskMode);
    expect(screen.queryByRole("combobox", { name: "Spawn session mode" })).not.toBeInTheDocument();
  });

  it("respawn mode renders agent + model + prompt only", () => {
    renderModal(respawnMode);
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Spawn project")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("workspace mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Self-destruct")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("branch name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Step" })).not.toBeInTheDocument();
  });

  it("desk mode renders agent + model + branch + plan + steps but no project", () => {
    renderModal(deskMode);
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("branch name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Step" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Spawn project")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Desk spawn model")).toBeInTheDocument();
    expect(screen.queryByLabelText("Spawn model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Respawn model")).not.toBeInTheDocument();
  });

  it("does not submit via primary hotkey when submitDisabled", () => {
    const { onSubmit } = renderModal(respawnMode, {
      promptAriaLabel: "Prompt input",
      submitDisabled: true,
    });
    const textarea = screen.getByLabelText("Prompt input");
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits via primary hotkey with focus in the prompt textarea (container handler)", () => {
    const { onSubmit } = renderModal(respawnMode, { promptAriaLabel: "Prompt input" });
    const textarea = screen.getByLabelText("Prompt input");
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders a single footer with slash, history, cancel, and submit", () => {
    renderModal(deskMode, { showCancel: true, slashEndpoint: "/api/x" });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Go/ })).toBeInTheDocument();
  });

  it("disables close and cancel and gates backdrop click when canClose is false", () => {
    const { onClose } = renderModal(spawnMode, { canClose: false, showCancel: true });
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(document.querySelector(".fixed.inset-0") as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on backdrop click when canClose is true", () => {
    const { onClose } = renderModal(spawnMode);
    fireEvent.click(document.querySelector(".fixed.inset-0") as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner and accessible verb on the submit button while submitting", () => {
    renderModal(deskMode, { submitting: true, submitDisabled: true });
    const submitButton = screen.getByRole("button", { name: "Going" });
    expect(submitButton.querySelector(".voice-spinner")).not.toBeNull();
    expect(screen.getByText("Go").parentElement).toHaveClass("invisible");
    expect(submitButton).toHaveAttribute("aria-busy", "true");
    expect(submitButton).toBeDisabled();
  });

  it("panel is full-screen on small mobile with tall prompt textarea", () => {
    renderModal(spawnMode, {
      promptAriaLabel: "Prompt input",
      promptMinHeightClass: "min-h-[24rem]",
    });
    const panel = document.querySelector(".fixed.inset-0")?.firstElementChild;
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass("h-[100dvh]");
    expect(panel).toHaveClass("w-screen");
    expect(panel).toHaveClass("sm:max-w-lg");
    expect(screen.getByLabelText("Prompt input")).toHaveClass("min-h-[24rem]");
  });
});
