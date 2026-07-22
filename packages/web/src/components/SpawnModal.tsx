"use client";

import type { ReactNode, RefObject } from "react";
import { AgentSelect } from "@/components/AgentSelect";
import { ModelSelect } from "@/components/ModelSelect";
import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";
import { IconCloseButton } from "@/components/IconCloseButton";
import { Spinner } from "@/components/icons/Spinner";
import { InputHistoryButton } from "@/components/InputHistory";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { INPUT_CLASS } from "@/design/classes";
import type { InputHistoryEntry } from "@/hooks/useInputHistory";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";
import type { AgentName } from "@/lib/agents";
import type { FileAttachment } from "@/lib/file-attachments";
import { insertTextAtCursor } from "@/lib/textarea";
import {
  isPrimarySubmitHotkey,
  isVoiceToggleHotkey,
  PRIMARY_SUBMIT_HINT,
} from "@/lib/submit-hotkeys";

export interface FieldControl<T> {
  value: T;
  onChange: (next: T) => void;
  onBlur?: () => void;
}

export interface ToggleControl {
  value: boolean;
  onChange: (next: boolean) => void;
}

export interface StepsControl {
  items: { id: number; value: string }[];
  onUpdate: (id: number, value: string) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
}

export interface HistoryControl {
  entries: InputHistoryEntry[];
  onSelect: (value: string) => void;
}

interface ProjectControl {
  value: string;
  onChange: (next: string) => void;
  options: { id: string; label: string }[];
}

export interface SpawnMembersControl {
  items: { id: number; agent: AgentName }[];
  onAdd: () => void;
  onUpdate: (id: number, agent: AgentName) => void;
  onRemove: (id: number) => void;
}

export type SpawnModalMode =
  | {
      kind: "spawn";
      project: ProjectControl;
      model: FieldControl<string | null>;
      branch: FieldControl<string>;
      workspaceMode: FieldControl<"default" | "worktree" | "shared">;
      planMode: ToggleControl;
      selfDestruct: ToggleControl;
      steps: StepsControl;
      members: SpawnMembersControl;
      branchNotesSlot?: ReactNode;
      selfDestructSlot?: ReactNode;
      baseBranchSlot?: ReactNode;
    }
  | {
      kind: "respawn";
      model: FieldControl<string | null>;
      noteSlot?: ReactNode;
      artifactSlot?: ReactNode;
    }
  | {
      kind: "desk";
      branch: FieldControl<string>;
      planMode: ToggleControl;
      steps: StepsControl;
    };

interface SpawnModalProps {
  mode: SpawnModalMode;
  // Chrome
  title: string;
  onClose: () => void;
  canClose: boolean;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
  submitBusyLabel: string;
  submitDisabled: boolean;
  showCancel: boolean;
  // Agent
  agent: AgentName;
  onAgentChange: (next: AgentName) => void;
  agentAriaLabel: string;
  // Prompt
  prompt: string;
  onPromptChange: (next: string) => void;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  promptPlaceholder: string;
  promptMinHeightClass: string;
  promptAriaLabel?: string;
  clearLabel: string;
  attachments: FileAttachment[];
  onAddFiles: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (index: number) => void;
  // Footer shared
  voice: UseVoiceInput;
  slashEndpoint: string | null;
  history: HistoryControl;
}

function StepsSection({ steps }: { steps: StepsControl }) {
  return (
    <div>
      <div className="max-h-48 space-y-2 overflow-y-auto">
        {steps.items.map((step, index) => (
          <div className="flex gap-2" key={step.id}>
            <input
              aria-label={`step ${index + 1}`}
              className={`min-w-0 flex-1 ${INPUT_CLASS}`}
              onChange={(event) => steps.onUpdate(step.id, event.target.value)}
              placeholder={`Step ${index + 1}`}
              value={step.value}
            />
            <button
              className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
              onClick={() => steps.onRemove(step.id)}
              type="button"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        className="mt-2 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-xs font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
        onClick={steps.onAdd}
        type="button"
      >
        + Step
      </button>
    </div>
  );
}

function ModeFields({
  mode,
  agent,
  onAgentChange,
  agentAriaLabel,
}: {
  mode: SpawnModalMode;
  agent: AgentName;
  onAgentChange: (next: AgentName) => void;
  agentAriaLabel: string;
}) {
  if (mode.kind === "spawn") {
    return (
      <>
        <div className="flex gap-2">
          <select
            aria-label="Spawn project"
            className={`flex-1 ${INPUT_CLASS}`}
            onChange={(event) => mode.project.onChange(event.target.value)}
            value={mode.project.value}
          >
            <option value="">Select project</option>
            {mode.project.options.map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
          <AgentSelect ariaLabel={agentAriaLabel} onChange={onAgentChange} value={agent} />
          <div className="min-w-40 flex-1">
            <ModelSelect
              agent={agent}
              ariaLabel="Spawn model"
              onChange={mode.model.onChange}
              value={mode.model.value}
            />
          </div>
          <button
            className="whitespace-nowrap border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
            onClick={mode.members.onAdd}
            type="button"
          >
            + Member
          </button>
        </div>
        {mode.members.items.length > 0 ? (
          <div className="max-h-32 space-y-2 overflow-y-auto">
            {mode.members.items.map((member, index) => (
              <div className="flex gap-2" key={member.id}>
                <AgentSelect
                  ariaLabel={`member ${index + 2} agent`}
                  onChange={(next) => mode.members.onUpdate(member.id, next)}
                  value={member.agent}
                />
                <button
                  className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                  onClick={() => mode.members.onRemove(member.id)}
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {mode.members.items.length === 0 ? (
            <input
              aria-label="branch name"
              className={`min-w-40 flex-1 ${INPUT_CLASS}`}
              onBlur={mode.branch.onBlur}
              onChange={(event) => mode.branch.onChange(event.target.value)}
              placeholder="Branch name"
              value={mode.branch.value}
            />
          ) : (
            <div className="min-w-40 flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-tertiary)]">
              grouped sessions use auto branches
            </div>
          )}
          <select
            aria-label="workspace mode"
            className={INPUT_CLASS}
            onChange={(event) =>
              mode.workspaceMode.onChange(event.target.value as "default" | "worktree" | "shared")
            }
            value={mode.workspaceMode.value}
          >
            <option value="default">Default</option>
            <option value="worktree">Worktree</option>
            <option disabled={mode.members.items.length > 0} value="shared">
              Shared
            </option>
          </select>
          <label className="flex items-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 cursor-pointer">
            <input
              aria-label="Plan"
              checked={mode.planMode.value}
              className="accent-[var(--color-accent)]"
              onChange={(event) => mode.planMode.onChange(event.target.checked)}
              type="checkbox"
            />
            <span className="text-xs font-bold uppercase text-[var(--color-text-primary)]">
              Plan
            </span>
          </label>
          <label className="flex items-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 cursor-pointer">
            <input
              aria-label="Self-destruct"
              checked={mode.selfDestruct.value}
              className="accent-[var(--color-accent)]"
              onChange={(event) => mode.selfDestruct.onChange(event.target.checked)}
              type="checkbox"
            />
            <span className="font-bold uppercase text-[var(--color-text-primary)]">
              Self-destruct
            </span>
          </label>
        </div>
        {mode.branchNotesSlot}
        {mode.selfDestructSlot}
        {mode.baseBranchSlot}
        <StepsSection steps={mode.steps} />
      </>
    );
  }

  if (mode.kind === "respawn") {
    return (
      <div className="flex gap-2">
        <AgentSelect ariaLabel={agentAriaLabel} onChange={onAgentChange} value={agent} />
        <div className="min-w-40 flex-1">
          <ModelSelect
            agent={agent}
            ariaLabel="Respawn model"
            onChange={mode.model.onChange}
            value={mode.model.value}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-2">
        <AgentSelect ariaLabel={agentAriaLabel} onChange={onAgentChange} value={agent} />
        <input
          aria-label="branch name"
          className={`min-w-0 flex-1 ${INPUT_CLASS}`}
          onChange={(event) => mode.branch.onChange(event.target.value)}
          placeholder="Branch name"
          value={mode.branch.value}
        />
        <label className="flex cursor-pointer items-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2">
          <input
            checked={mode.planMode.value}
            className="accent-[var(--color-accent)]"
            onChange={(event) => mode.planMode.onChange(event.target.checked)}
            type="checkbox"
          />
          <span className="font-bold uppercase text-[var(--color-text-primary)]">Plan</span>
        </label>
      </div>
      <StepsSection steps={mode.steps} />
    </>
  );
}

export function SpawnModal({
  mode,
  title,
  onClose,
  canClose,
  onSubmit,
  submitting,
  submitLabel,
  submitBusyLabel,
  submitDisabled,
  showCancel,
  agent,
  onAgentChange,
  agentAriaLabel,
  prompt,
  onPromptChange,
  promptRef,
  promptPlaceholder,
  promptMinHeightClass,
  promptAriaLabel,
  clearLabel,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  voice,
  slashEndpoint,
  history,
}: SpawnModalProps) {
  const noteSlot = mode.kind === "respawn" ? mode.noteSlot : undefined;
  const artifactSlot = mode.kind === "respawn" ? mode.artifactSlot : undefined;

  return (
    <div
      aria-labelledby="spawn-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && canClose) onClose();
      }}
    >
      <div
        className="flex h-[100dvh] max-h-[100dvh] w-screen flex-col overflow-hidden bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:border sm:border-[var(--color-border-default)] sm:p-5"
        onKeyDown={(event) => {
          if (isVoiceToggleHotkey(event)) {
            event.preventDefault();
            voice.toggleRecording();
            return;
          }
          if (isPrimarySubmitHotkey(event) && !submitDisabled) {
            event.preventDefault();
            onSubmit();
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="text-sm font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]"
            id="spawn-modal-title"
          >
            {title}
          </h2>
          <IconCloseButton label="Close" onClick={onClose} disabled={!canClose} />
        </div>
        {noteSlot ? <div className="mb-3">{noteSlot}</div> : null}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <ModeFields
            agent={agent}
            agentAriaLabel={agentAriaLabel}
            mode={mode}
            onAgentChange={onAgentChange}
          />
          <FileAttachmentTextarea
            ariaLabel={promptAriaLabel}
            attachments={attachments}
            clearLabel={clearLabel}
            minHeightClass={promptMinHeightClass}
            onAddFiles={onAddFiles}
            onChange={onPromptChange}
            onRemoveAttachment={onRemoveAttachment}
            placeholder={voicePlaceholder(promptPlaceholder, voice)}
            textareaRef={promptRef}
            value={prompt}
            voice={voice}
          />
          {voice.voiceError ? (
            <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]">
              {voice.voiceError}
            </div>
          ) : null}
          {artifactSlot}
        </div>
        <div className="mt-3 flex shrink-0 items-center justify-between">
          <span className="text-[10px] text-[var(--color-text-tertiary)]">
            <VoiceStatusHint voice={voice} />
          </span>
          <div className="flex items-center gap-2">
            <SlashSuggestions
              endpoint={slashEndpoint}
              onSelect={(entry) =>
                insertTextAtCursor(promptRef.current, entry.insertText, onPromptChange)
              }
            />
            <InputHistoryButton entries={history.entries} onSelect={history.onSelect} />
            {showCancel ? (
              <button
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canClose}
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
            ) : null}
            <button
              className="inline-flex min-w-32 items-center justify-center gap-2 bg-[var(--color-accent)] px-4 py-2 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitDisabled}
              onClick={onSubmit}
              type="button"
            >
              {submitting ? <Spinner className="h-3 w-3" strokeWidth={1.5} /> : null}
              <span>{submitting ? submitBusyLabel : submitLabel}</span>
              {!submitting ? (
                <span
                  aria-hidden="true"
                  className="whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-tertiary)]"
                >
                  {PRIMARY_SUBMIT_HINT}
                </span>
              ) : null}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
