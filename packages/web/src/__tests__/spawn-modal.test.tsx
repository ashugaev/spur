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
  model: { value: null, onChange: vi.fn() },
  branch: { value: "", onChange: vi.fn() },
  workspaceMode: { value: "default", onChange: vi.fn() },
  planMode: { value: false, onChange: vi.fn() },
  selfDestruct: { value: false, onChange: vi.fn() },
  steps: { items: [], onUpdate: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn() },
};

const respawnMode: SpawnModalMode = {
  kind: "respawn",
  model: { value: null, onChange: vi.fn() },
};

const deskMode: SpawnModalMode = {
  kind: "desk",
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
    submitBusyLabel: "Going...",
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

  it("respawn mode renders agent + model + prompt only", () => {
    renderModal(respawnMode);
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Spawn project")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("workspace mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Self-destruct")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("branch name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Step" })).not.toBeInTheDocument();
  });

  it("desk mode renders agent + branch + plan + steps but no model or project", () => {
    renderModal(deskMode);
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("branch name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Step" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Spawn project")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Spawn model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Respawn model")).not.toBeInTheDocument();
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
    const closeButton = screen.getByRole("button", { name: "✕" });
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
});
