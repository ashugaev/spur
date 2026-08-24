"use client";

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentName } from "@/lib/agents";
import { normalizeBranchName } from "@/lib/branch-name";
import {
  encodeFileAttachments,
  fileAttachmentsFromFiles,
  type FileAttachment,
} from "@/lib/file-attachments";
import type { SpawnOverrides } from "@/lib/types";

type EncodedFileAttachment = ReturnType<typeof encodeFileAttachments>[number];

export interface SpawnComposerStep {
  id: number;
  value: string;
}

export type SpawnWorkspaceMode = "default" | "worktree" | "shared";

export interface SpawnSessionPayload {
  projectId: string;
  prompt: string;
  agent: AgentName;
  model?: string;
  attachments?: EncodedFileAttachment[];
  branch?: string;
  planMode?: true;
  selfDestruct?: {
    enabled: true;
    conditions?: string;
  };
  steps?: string[];
  overrides?: SpawnOverrides;
}

export interface RespawnSessionPayload {
  prompt: string;
  startupAttachmentIds: string[];
  attachments?: EncodedFileAttachment[];
  forceKillSource?: true;
  agent?: AgentName;
  model?: string;
}

export interface DeskSpawnPayload {
  projectId: string;
  prompt: string;
  agent: AgentName;
  model?: string;
  reuseWorkspaceSessionId: string;
  overrides: { worktree: boolean };
  attachments?: EncodedFileAttachment[];
  branch?: string;
  planMode?: true;
  steps?: string[];
}

export interface SpawnComposerOpenDefaults {
  agent?: AgentName;
  model?: string | null;
  projectId?: string;
  prompt?: string;
  branch?: string;
  workspaceMode?: SpawnWorkspaceMode;
  defaultBranch?: string;
  startupAttachmentIds?: string[];
}

export type SpawnComposerKind = "spawn" | "respawn" | "desk";

export interface SpawnComposerState {
  agent: AgentName;
  attachments: FileAttachment[];
  branch: string;
  defaultBranch: string;
  model: string | null;
  planMode: boolean;
  projectId: string;
  prompt: string;
  selfDestruct: boolean;
  selfDestructConditions: string;
  startupAttachmentIds: string[];
  steps: SpawnComposerStep[];
  workspaceMode: SpawnWorkspaceMode;
}

export interface SpawnComposer extends SpawnComposerState {
  kind: SpawnComposerKind;
  open: boolean;
  addFiles: (files: FileList | File[] | null) => void;
  addStep: () => void;
  close: () => void;
  openWithDefaults: (defaults?: SpawnComposerOpenDefaults) => void;
  removeAttachment: (index: number) => void;
  removeStep: (id: number) => void;
  resetAfterSubmit: (preserve?: SpawnComposerOpenDefaults) => void;
  setAgent: (next: AgentName) => void;
  setAttachments: Dispatch<SetStateAction<FileAttachment[]>>;
  setBranch: Dispatch<SetStateAction<string>>;
  setDefaultBranch: Dispatch<SetStateAction<string>>;
  setModel: (next: string | null) => void;
  setOpen: (next: boolean) => void;
  setPlanMode: (next: boolean) => void;
  setProjectId: Dispatch<SetStateAction<string>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSelfDestruct: (next: boolean) => void;
  setSelfDestructConditions: Dispatch<SetStateAction<string>>;
  setStartupAttachmentIds: Dispatch<SetStateAction<string[]>>;
  setWorkspaceMode: (next: SpawnWorkspaceMode) => void;
  updateStep: (id: number, value: string) => void;
}

function filteredSteps(steps: readonly SpawnComposerStep[]): string[] {
  return steps.map((step) => step.value.trim()).filter((step) => step.length > 0);
}

export function buildSpawnOverrides(
  workspaceMode: SpawnWorkspaceMode,
  defaultBranch: string,
): SpawnOverrides | undefined {
  if (workspaceMode === "worktree") {
    const trimmed = defaultBranch.trim();
    return trimmed ? { worktree: true, defaultBranch: trimmed } : { worktree: true };
  }
  if (workspaceMode === "shared") return { worktree: false };
  return undefined;
}

export function buildSpawnSessionPayload(composer: SpawnComposerState): SpawnSessionPayload {
  const payload: SpawnSessionPayload = {
    projectId: composer.projectId.trim(),
    prompt: composer.prompt.trim(),
    agent: composer.agent,
  };
  if (composer.model !== null) payload.model = composer.model;

  const attachments = encodeFileAttachments(composer.attachments);
  if (attachments.length > 0) payload.attachments = attachments;

  const branch = normalizeBranchName(composer.branch);
  if (branch) payload.branch = branch;
  if (composer.planMode) payload.planMode = true;
  if (composer.selfDestruct) {
    const conditions = composer.selfDestructConditions.trim();
    payload.selfDestruct = conditions ? { enabled: true, conditions } : { enabled: true };
  }

  const steps = filteredSteps(composer.steps);
  if (steps.length > 0) payload.steps = steps;

  const overrides = buildSpawnOverrides(composer.workspaceMode, composer.defaultBranch);
  if (overrides) payload.overrides = overrides;
  return payload;
}

export function buildRespawnSessionPayload(
  composer: SpawnComposerState,
  sourceAgent: AgentName,
  forceKillSource: boolean,
): RespawnSessionPayload {
  const payload: RespawnSessionPayload = {
    prompt: composer.prompt.trim(),
    startupAttachmentIds: composer.startupAttachmentIds,
  };
  const attachments = encodeFileAttachments(composer.attachments);
  if (attachments.length > 0) payload.attachments = attachments;
  if (forceKillSource) payload.forceKillSource = true;
  if (composer.agent !== sourceAgent) payload.agent = composer.agent;
  if (composer.model !== null) payload.model = composer.model;
  return payload;
}

export function buildDeskSpawnPayload(
  composer: SpawnComposerState,
  session: { id: string; projectId: string; worktree: boolean },
): DeskSpawnPayload {
  const payload: DeskSpawnPayload = {
    projectId: session.projectId,
    prompt: composer.prompt.trim(),
    agent: composer.agent,
    reuseWorkspaceSessionId: session.id,
    overrides: { worktree: session.worktree },
  };
  if (composer.model !== null) payload.model = composer.model;
  const attachments = encodeFileAttachments(composer.attachments);
  if (attachments.length > 0) payload.attachments = attachments;
  const branch = composer.branch.trim();
  if (branch) payload.branch = branch;
  if (composer.planMode) payload.planMode = true;
  const steps = filteredSteps(composer.steps);
  if (steps.length > 0) payload.steps = steps;
  return payload;
}

export function useSpawnComposer(kind: SpawnComposerKind, defaultAgent: AgentName): SpawnComposer {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgentState] = useState<AgentName>(defaultAgent);
  const [model, setModel] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [selfDestruct, setSelfDestruct] = useState(false);
  const [selfDestructConditions, setSelfDestructConditions] = useState("");
  const [steps, setSteps] = useState<SpawnComposerStep[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<SpawnWorkspaceMode>("default");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [startupAttachmentIds, setStartupAttachmentIds] = useState<string[]>([]);
  const stepIdRef = useRef(0);

  const setAgent = useCallback((next: AgentName) => {
    setAgentState(next);
    setModel(null);
  }, []);

  const applyDefaults = useCallback(
    (defaults?: SpawnComposerOpenDefaults) => {
      setProjectId(defaults?.projectId ?? "");
      setPrompt(defaults?.prompt ?? "");
      setAgentState(defaults?.agent ?? defaultAgent);
      setModel(defaults?.model ?? null);
      setBranch(defaults?.branch ?? "");
      setPlanMode(false);
      setSelfDestruct(false);
      setSelfDestructConditions("");
      setSteps([]);
      setWorkspaceMode(defaults?.workspaceMode ?? "default");
      setDefaultBranch(defaults?.defaultBranch ?? "");
      setAttachments([]);
      setStartupAttachmentIds(defaults?.startupAttachmentIds ?? []);
    },
    [defaultAgent],
  );

  const openWithDefaults = useCallback(
    (defaults?: SpawnComposerOpenDefaults) => {
      applyDefaults(defaults);
      setOpen(true);
    },
    [applyDefaults],
  );

  const resetAfterSubmit = useCallback(
    (preserve?: SpawnComposerOpenDefaults) => {
      applyDefaults(preserve);
      setOpen(false);
    },
    [applyDefaults],
  );

  const close = useCallback(() => setOpen(false), []);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((entries) => {
        if (entries.length === 0) return;
        setAttachments((current) => [...current, ...entries]);
      })
      .catch(() => {});
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const addStep = useCallback(() => {
    stepIdRef.current += 1;
    setSteps((current) => [...current, { id: stepIdRef.current, value: "" }]);
  }, []);

  const removeStep = useCallback((id: number) => {
    setSteps((current) => current.filter((step) => step.id !== id));
  }, []);

  const updateStep = useCallback((id: number, value: string) => {
    setSteps((current) => current.map((step) => (step.id === id ? { ...step, value } : step)));
  }, []);

  return {
    agent,
    attachments,
    branch,
    defaultBranch,
    kind,
    model,
    open,
    planMode,
    projectId,
    prompt,
    selfDestruct,
    selfDestructConditions,
    startupAttachmentIds,
    steps,
    workspaceMode,
    addFiles,
    addStep,
    close,
    openWithDefaults,
    removeAttachment,
    removeStep,
    resetAfterSubmit,
    setAgent,
    setAttachments,
    setBranch,
    setDefaultBranch,
    setModel,
    setOpen,
    setPlanMode,
    setProjectId,
    setPrompt,
    setSelfDestruct,
    setSelfDestructConditions,
    setStartupAttachmentIds,
    setWorkspaceMode,
    updateStep,
  };
}
