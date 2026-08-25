import type { AgentName } from "@/lib/agents";
import { normalizeBranchName } from "@/lib/branch-name";
import {
  assertAttachmentsWithinLimit,
  encodeFileAttachments,
  type FileAttachment,
} from "@/lib/file-attachments";
import type { SpawnOverrides, WorkspaceMode } from "@/lib/types";

type EncodedFileAttachment = ReturnType<typeof encodeFileAttachments>[number];

export interface SpawnStep {
  id: number;
  value: string;
}

interface ComposerFields {
  agent: AgentName;
  attachments: FileAttachment[];
  model: string | null;
  prompt: string;
}

export interface SpawnPayloadFields extends ComposerFields {
  branch: string;
  defaultBranch: string;
  mode: string | null;
  planMode: boolean;
  projectId: string;
  selfDestruct: boolean;
  selfDestructConditions: string;
  steps: SpawnStep[];
  trackerUrl: string | null;
  workspaceMode: WorkspaceMode;
}

export interface RespawnPayloadFields extends ComposerFields {
  startupAttachmentIds: string[];
}

export interface DeskSpawnPayloadFields extends ComposerFields {
  branch: string;
  planMode: boolean;
  steps: SpawnStep[];
}

export interface SpawnSessionPayload {
  projectId: string;
  prompt: string;
  agent: AgentName;
  model?: string;
  mode?: string;
  attachments?: EncodedFileAttachment[];
  branch?: string;
  planMode?: true;
  selfDestruct?: {
    enabled: true;
    conditions?: string;
  };
  steps?: string[];
  overrides: SpawnOverrides;
  slots?: { links: [{ label: "tracker"; url: string }] };
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

function filteredSteps(steps: readonly SpawnStep[]): string[] {
  return steps.map((step) => step.value.trim()).filter((step) => step.length > 0);
}

function encodedAttachments(attachments: FileAttachment[]): EncodedFileAttachment[] {
  const encoded = encodeFileAttachments(attachments);
  assertAttachmentsWithinLimit(encoded);
  return encoded;
}

export function buildSpawnOverrides(
  workspaceMode: WorkspaceMode,
  defaultBranch: string,
): SpawnOverrides {
  if (workspaceMode === "worktree") {
    const trimmed = defaultBranch.trim();
    return trimmed ? { worktree: true, defaultBranch: trimmed } : { worktree: true };
  }
  return { worktree: false };
}

export function buildSpawnSessionPayload(fields: SpawnPayloadFields): SpawnSessionPayload {
  const payload: SpawnSessionPayload = {
    projectId: fields.projectId.trim(),
    prompt: fields.prompt.trim(),
    agent: fields.agent,
    overrides: buildSpawnOverrides(fields.workspaceMode, fields.defaultBranch),
  };
  if (fields.model !== null) payload.model = fields.model;
  if (fields.mode) payload.mode = fields.mode;

  const attachments = encodedAttachments(fields.attachments);
  if (attachments.length > 0) payload.attachments = attachments;

  const branch = normalizeBranchName(fields.branch);
  if (branch) payload.branch = branch;
  if (fields.planMode) payload.planMode = true;
  if (fields.selfDestruct) {
    const conditions = fields.selfDestructConditions.trim();
    payload.selfDestruct = conditions ? { enabled: true, conditions } : { enabled: true };
  }

  const steps = filteredSteps(fields.steps);
  if (steps.length > 0) payload.steps = steps;
  if (fields.trackerUrl) {
    payload.slots = { links: [{ label: "tracker", url: fields.trackerUrl }] };
  }
  return payload;
}

export function buildRespawnSessionPayload(
  fields: RespawnPayloadFields,
  sourceAgent: AgentName,
  forceKillSource: boolean,
): RespawnSessionPayload {
  const payload: RespawnSessionPayload = {
    prompt: fields.prompt.trim(),
    startupAttachmentIds: fields.startupAttachmentIds,
  };
  const attachments = encodedAttachments(fields.attachments);
  if (attachments.length > 0) payload.attachments = attachments;
  if (forceKillSource) payload.forceKillSource = true;
  if (fields.agent !== sourceAgent) payload.agent = fields.agent;
  if (fields.model !== null) payload.model = fields.model;
  return payload;
}

export function buildDeskSpawnPayload(
  fields: DeskSpawnPayloadFields,
  session: { id: string; projectId: string; worktree: boolean },
): DeskSpawnPayload {
  const payload: DeskSpawnPayload = {
    projectId: session.projectId,
    prompt: fields.prompt.trim(),
    agent: fields.agent,
    reuseWorkspaceSessionId: session.id,
    overrides: { worktree: session.worktree },
  };
  if (fields.model !== null) payload.model = fields.model;
  const attachments = encodedAttachments(fields.attachments);
  if (attachments.length > 0) payload.attachments = attachments;
  const branch = fields.branch.trim();
  if (branch) payload.branch = branch;
  if (fields.planMode) payload.planMode = true;
  const steps = filteredSteps(fields.steps);
  if (steps.length > 0) payload.steps = steps;
  return payload;
}
