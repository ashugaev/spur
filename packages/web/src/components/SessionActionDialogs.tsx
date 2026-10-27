"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import { AgentSelect } from "@/components/AgentSelect";
import { BusyContent } from "@/components/BusyContent";
import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";
import { ModelReasoningField } from "@/components/ModelReasoningField";
import { RecoverActionDialog } from "@/components/RecoverActionDialog";
import { SpawnModal } from "@/components/SpawnModal";
import { SwitchAuthDialog } from "@/components/SwitchAuthDialog";
import { VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { useInputHistory } from "@/hooks/useInputHistory";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import {
  fileAttachmentsFromFiles,
  mergeAttachmentsWithinLimit,
  type FileAttachment,
} from "@/lib/file-attachments";
import { errorMessage, readApiErrorMessage } from "@/lib/json-payload";
import {
  initialReasoningIntent,
  serializeReasoningIntent,
  type ReasoningIntent,
} from "@/lib/reasoning-effort";
import { useResolvedSpawnDefaults } from "@/lib/spawn-defaults";
import { buildDeskSpawnPayload, buildRespawnSessionPayload } from "@/lib/spawn-payload";
import {
  isPrimarySubmitHotkey,
  isVoiceToggleHotkey,
  PRIMARY_SUBMIT_HINT,
} from "@/lib/submit-hotkeys";
import {
  isTerminalSession,
  toDashboardSession,
  type DashboardSession,
  type SessionNotRestorablePayload,
  type SpurSessionView,
} from "@/lib/types";

const DESK_SPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:desk-spawn-prompt";
const RESPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:respawn-prompt";

export function artifactUrl(sessionId: string, artifactId: string): string {
  const encodedPath = artifactId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodedPath}`;
}

export function buildLocalRecoverPayload(session: DashboardSession): SessionNotRestorablePayload {
  const availableActions: SessionNotRestorablePayload["availableActions"] = ["force_kill"];
  if (!isTerminalSession(session)) {
    availableActions.push("respawn");
  }
  return {
    code: "session_not_restorable",
    sessionId: session.id,
    reason: `Session ${session.id} is not restorable`,
    availableActions,
  };
}

export type SessionDialogBusy = "handoff" | "respawn" | null;

interface SessionActionDialogsOptions {
  /** Live row for the open dialog's session, so polls refresh it. */
  resolve: (sessionId: string) => DashboardSession | null;
  showErrorToast: (message: string) => void;
  /** A handoff, respawn, or desk spawn created this session. */
  onCreated: (created: SpurSessionView) => void;
  /** Switch auth returned the updated row. */
  onUpdated: (row: SpurSessionView) => void;
  /** Recover's force kill; resolves true once the session is killed. */
  onForceKill: (session: DashboardSession) => Promise<boolean>;
  /** Busy state owned by the page, such as a pending lifecycle action. */
  pageBusy: boolean;
  /** Rows come from the list endpoint, which omits artifacts and Claude accounts. */
  loadFull?: boolean;
  /** Mirrors handoff/respawn busy into the page's own busy state. */
  onBusyChange?: (busy: SessionDialogBusy) => void;
}

/** Handoff, Edit & Respawn, Desk agent, Switch auth, and Recover: shared by detail and dashboard. */
export function useSessionActionDialogs({
  resolve,
  showErrorToast,
  onCreated,
  onUpdated,
  onForceKill,
  pageBusy,
  loadFull = false,
  onBusyChange,
}: SessionActionDialogsOptions) {
  // Snapshot from open time; the live row wins while the page still lists it,
  // unless the snapshot is a pinned full read.
  const [target, setTargetState] = useState<DashboardSession | null>(null);
  const [pinned, setPinned] = useState(false);
  const loadRequestRef = useRef(0);
  const setTarget = (next: DashboardSession, full = false) => {
    loadRequestRef.current += 1;
    setTargetState(next);
    setPinned(full);
  };
  const session = target ? (pinned ? target : (resolve(target.id) ?? target)) : null;
  const sessionKey = session?.id ?? "";
  const [busy, setBusyState] = useState<SessionDialogBusy>(null);
  const setBusy = (next: SessionDialogBusy) => {
    setBusyState(next);
    onBusyChange?.(next);
  };

  const [recoverPayload, setRecoverPayload] = useState<SessionNotRestorablePayload | null>(null);

  const [switchAuthOpen, setSwitchAuthOpen] = useState(false);
  const [switchAuthPending, setSwitchAuthPending] = useState(false);
  const [switchAuthError, setSwitchAuthError] = useState<string | null>(null);

  const [respawnOpen, setRespawnOpen] = useState(false);
  const [respawnPrompt, setRespawnPrompt] = useState("");
  const [respawnAgent, setRespawnAgent] = useState<AgentName | null>(null);
  const [respawnModel, setRespawnModel] = useState<string | null>(null);
  const [respawnReasoningIntent, setRespawnReasoningIntent] = useState<ReasoningIntent>(
    initialReasoningIntent(false),
  );
  // Settled/unsettled model resolution, reported by ModelSelect itself.
  // Submit gates on this, not on `respawnModel === null` — a settled-empty
  // catalog also has a null model but is a valid, submittable state.
  const [respawnModelResolved, setRespawnModelResolved] = useState(false);
  const [respawnAttachments, setRespawnAttachments] = useState<FileAttachment[]>([]);
  const [respawnStartupAttachmentIds, setRespawnStartupAttachmentIds] = useState<string[]>([]);

  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffNotes, setHandoffNotes] = useState("");
  const [handoffAgent, setHandoffAgent] = useState<AgentName | null>(null);
  const [handoffModel, setHandoffModel] = useState<string | null>(null);
  const [handoffReasoningIntent, setHandoffReasoningIntent] = useState<ReasoningIntent>(
    initialReasoningIntent(false),
  );
  const [handoffModelResolved, setHandoffModelResolved] = useState(false);
  // projectId is empty while the owning modal is closed, so no request fires
  // until it is actually open.
  const respawnSpawnDefaults = useResolvedSpawnDefaults(
    respawnOpen && session ? session.projectId : "",
    respawnAgent ?? "claude",
  );
  const handoffSpawnDefaults = useResolvedSpawnDefaults(
    handoffOpen && session ? session.projectId : "",
    handoffAgent ?? "claude",
  );

  const [deskSpawnOpen, setDeskSpawnOpen] = useState(false);
  const [deskSpawnPrompt, setDeskSpawnPrompt] = useState("");
  const [deskSpawnAgent, setDeskSpawnAgent] = useState<AgentName>("claude");
  const [deskSpawnModel, setDeskSpawnModel] = useState<string | null>(null);
  const [deskSpawnReasoningIntent, setDeskSpawnReasoningIntent] = useState<ReasoningIntent>(
    initialReasoningIntent(false),
  );
  const [deskSpawnModelResolved, setDeskSpawnModelResolved] = useState(false);
  const deskSpawnDefaults = useResolvedSpawnDefaults(
    deskSpawnOpen && session ? session.projectId : "",
    deskSpawnAgent,
  );
  const [deskSpawnBranch, setDeskSpawnBranch] = useState("");
  const [deskSpawnPlanMode, setDeskSpawnPlanMode] = useState(false);
  const [deskSpawnSteps, setDeskSpawnSteps] = useState<{ id: number; value: string }[]>([]);
  const [deskSpawnAttachments, setDeskSpawnAttachments] = useState<FileAttachment[]>([]);
  const [deskSpawning, setDeskSpawning] = useState(false);
  const deskSpawningRef = useRef(false);
  const deskSpawnPromptRef = useRef<HTMLTextAreaElement>(null);
  const deskSpawnStepIdRef = useRef(0);
  const deskSpawnHistory = useInputHistory(DESK_SPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const deskSpawnVoice = useVoiceInput({
    contextKey: `desk-spawn:${sessionKey}`,
    onTranscribed: (text) =>
      setDeskSpawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const respawningRef = useRef(false);
  const respawnPromptRef = useRef<HTMLTextAreaElement>(null);
  const respawnHistory = useInputHistory(RESPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const respawnVoice = useVoiceInput({
    contextKey: `respawn:${sessionKey}`,
    onTranscribed: (text) =>
      setRespawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const handoffNotesRef = useRef<HTMLTextAreaElement>(null);
  const handoffVoice = useVoiceInput({
    contextKey: `handoff:${sessionKey}`,
    onTranscribed: (text) =>
      setHandoffNotes((current) => (current.trim() ? `${current}\n${text}` : text)),
  });

  const respawnVoiceDismiss = respawnVoice.dismissModal;
  useEffect(() => {
    if (respawnOpen) return;
    respawnVoiceDismiss();
  }, [respawnOpen, respawnVoiceDismiss]);

  const handoffVoiceDismiss = handoffVoice.dismissModal;
  useEffect(() => {
    if (handoffOpen) return;
    handoffVoiceDismiss();
  }, [handoffOpen, handoffVoiceDismiss]);

  const startupArtifacts = useMemo(() => {
    const startupAttachmentIds = session?.startupAttachmentIds ?? [];
    return (
      session?.artifacts.filter((artifact) => startupAttachmentIds.includes(artifact.id)) ?? []
    );
  }, [session]);
  const prLink = session?.links.find((link) => link.label === "pr");

  const addFiles = (setter: typeof setRespawnAttachments) => (files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((entries) => {
        if (entries.length === 0) return;
        let rejectedMessage: string | null = null;
        setter((prev) => {
          const result = mergeAttachmentsWithinLimit(prev, entries);
          rejectedMessage = result.rejectedMessage;
          return result.attachments;
        });
        if (rejectedMessage) showErrorToast(rejectedMessage);
      })
      .catch(() => {});
  };

  /**
   * List rows omit artifacts. With `loadFull`, Respawn reads the full session
   * first and pins that snapshot.
   */
  const loadTarget = async (target: DashboardSession): Promise<DashboardSession | null> => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(target.id)}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, "Failed to load Spur session"));
      const full = toDashboardSession(
        (await response.json()) as SpurSessionView,
        target.projectName,
      );
      return full;
    } catch (loadError) {
      showErrorToast(errorMessage(loadError, "Failed to load Spur session"));
      return null;
    }
  };

  // Synchronous for an already-full row, so the detail page opens in the same tick.
  const withFullTarget = async (
    listed: DashboardSession,
    apply: (target: DashboardSession) => void,
  ) => {
    const request = ++loadRequestRef.current;
    if (!loadFull) return apply(listed);
    const target = await loadTarget(listed);
    // A newer open superseded this read; never open late or twice.
    if (target && request === loadRequestRef.current) apply(target);
  };

  const openRespawn = (listed: DashboardSession) => withFullTarget(listed, applyRespawn);
  const applyRespawn = (target: DashboardSession) => {
    setTarget(target, loadFull);
    setRespawnPrompt(target.prompt);
    setRespawnStartupAttachmentIds(target.startupAttachmentIds ?? []);
    setRespawnAttachments([]);
    setRespawnAgent(target.agent);
    // Not target.model directly: that would seed an unfiltered value ahead
    // of ModelSelect's resolver, bypassing the isListed() check the `carry`
    // rung otherwise applies. Passing carry lets the resolver re-derive the
    // same value, filtered.
    setRespawnModel(null);
    setRespawnReasoningIntent(initialReasoningIntent(true, target.reasoningEffort));
    setRespawnOpen(true);
  };

  const openHandoff = (target: DashboardSession) => {
    setTarget(target);
    setHandoffNotes("");
    const defaultAgent =
      AGENT_OPTIONS.find((candidate) => candidate !== target.agent) ?? target.agent;
    setHandoffAgent(defaultAgent);
    setHandoffModel(null);
    setHandoffReasoningIntent(
      initialReasoningIntent(defaultAgent === target.agent, target.reasoningEffort),
    );
    setHandoffOpen(true);
  };

  const openDeskSpawn = (target: DashboardSession) => {
    setTarget(target);
    setDeskSpawnAgent(target.agent);
    setDeskSpawnModel(null);
    setDeskSpawnReasoningIntent(initialReasoningIntent(false));
    setDeskSpawnModelResolved(false);
    setDeskSpawnPrompt("");
    setDeskSpawnBranch(target.branch ?? "");
    setDeskSpawnPlanMode(false);
    setDeskSpawnSteps([]);
    setDeskSpawnAttachments([]);
    setDeskSpawnOpen(true);
  };

  const openSwitchAuth = (target: DashboardSession) => {
    setTarget(target);
    setSwitchAuthError(null);
    setSwitchAuthOpen(true);
  };

  const openRecover = (target: DashboardSession, payload = buildLocalRecoverPayload(target)) => {
    setTarget(target);
    setRecoverPayload(payload);
  };

  // The page's kill handler already toasted a failure.
  const forceKill = (target: DashboardSession) => onForceKill(target).catch(() => false);

  const handleRecoverForceKill = async () => {
    if (!session) return;
    if (await forceKill(session)) setRecoverPayload(null);
  };

  const handleRecoverRespawn = async () => {
    if (!session) return;
    const target = session;
    if (!(await forceKill(target))) return;
    setRecoverPayload(null);
    await openRespawn(target);
  };

  const handleRespawn = async () => {
    if (respawningRef.current || !session || !respawnAgent) return;
    const target = session;
    const agent = respawnAgent;
    const submitRespawn = async (forceKillSource: boolean) => {
      const nextPrompt = respawnPrompt.trim();
      const payload = buildRespawnSessionPayload(
        {
          prompt: nextPrompt,
          agent,
          model: respawnModel,
          reasoningIntent: respawnReasoningIntent,
          attachments: respawnAttachments,
          startupAttachmentIds: respawnStartupAttachmentIds,
        },
        target.agent,
        forceKillSource,
      );
      const response = await fetch(`/api/sessions/${encodeURIComponent(target.id)}/respawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to respawn session"));
      }
      const data = (await response.json()) as SpurSessionView;
      respawnHistory.saveEntry(nextPrompt);
      setRespawnOpen(false);
      onCreated(data);
    };

    respawningRef.current = true;
    setBusy("respawn");
    try {
      await submitRespawn(false);
    } catch (respawnFirstError) {
      const msg = errorMessage(respawnFirstError, "Failed to respawn session");
      const prefix = "Kill confirmation required";
      if (
        msg.startsWith(prefix) &&
        window.confirm(
          `${msg}\n\nRespawn anyway and discard the old session worktree (including uncommitted changes or unpushed commits)?`,
        )
      ) {
        try {
          await submitRespawn(true);
        } catch (respawnForceError) {
          showErrorToast(errorMessage(respawnForceError, "Failed to respawn session"));
        }
      } else {
        showErrorToast(msg);
      }
    } finally {
      respawningRef.current = false;
      setBusy(null);
    }
  };

  const handleSwitchAuth = async (accountId: string, force: boolean) => {
    if (!session) return;
    setSwitchAuthPending(true);
    setSwitchAuthError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/switch-auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(force ? { accountId, force: true } : { accountId }),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to switch Claude account"));
      }
      onUpdated((await response.json()) as SpurSessionView);
      setSwitchAuthOpen(false);
    } catch (switchAuthErr) {
      setSwitchAuthError(errorMessage(switchAuthErr, "Failed to switch Claude account"));
    } finally {
      setSwitchAuthPending(false);
    }
  };

  const handleHandoff = async () => {
    if (!session || !handoffAgent) return;
    setBusy("handoff");
    try {
      const payload: Record<string, unknown> = { agent: handoffAgent };
      // Only the settled-empty-catalog case omits `model`; every other model
      // state (including a manual pick or a resolved default) sends it.
      if (handoffModel !== null) payload.model = handoffModel;
      const reasoningEffort = serializeReasoningIntent(handoffReasoningIntent);
      if (reasoningEffort !== undefined) payload.reasoningEffort = reasoningEffort;
      const notes = handoffNotes.trim();
      if (notes) payload.notes = notes;
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to hand off session"));
      }
      const data = (await response.json()) as SpurSessionView;
      setHandoffOpen(false);
      onCreated(data);
    } catch (handoffError) {
      showErrorToast(errorMessage(handoffError, "Failed to hand off session"));
    } finally {
      setBusy(null);
    }
  };

  const handleDeskSpawn = async () => {
    if (!session || deskSpawningRef.current) return;
    const nextPrompt = deskSpawnPrompt.trim();
    deskSpawningRef.current = true;
    setDeskSpawning(true);
    try {
      const payload = buildDeskSpawnPayload(
        {
          prompt: nextPrompt,
          agent: deskSpawnAgent,
          model: deskSpawnModel,
          reasoningIntent: deskSpawnReasoningIntent,
          attachments: deskSpawnAttachments,
          branch: deskSpawnBranch,
          planMode: deskSpawnPlanMode,
          steps: deskSpawnSteps,
        },
        session,
      );

      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to spawn desk agent"));
      }
      const created = (await response.json()) as SpurSessionView;
      deskSpawnHistory.saveEntry(nextPrompt);
      setDeskSpawnOpen(false);
      onCreated(created);
    } catch (deskError) {
      showErrorToast(errorMessage(deskError, "Failed to spawn desk agent"));
    } finally {
      deskSpawningRef.current = false;
      setDeskSpawning(false);
    }
  };

  const addDeskSpawnStep = () => {
    deskSpawnStepIdRef.current += 1;
    setDeskSpawnSteps((current) => [...current, { id: deskSpawnStepIdRef.current, value: "" }]);
  };
  const removeDeskSpawnStep = (id: number) => {
    setDeskSpawnSteps((current) => current.filter((step) => step.id !== id));
  };
  const updateDeskSpawnStep = (id: number, value: string) => {
    setDeskSpawnSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, value } : step)),
    );
  };

  const dialogs: ReactNode = session ? (
    <>
      {recoverPayload ? (
        <RecoverActionDialog
          busy={pageBusy || busy !== null || Boolean(session.lifecyclePending)}
          canForceKill={!isTerminalSession(session)}
          onCancel={() => setRecoverPayload(null)}
          onForceKill={() => void handleRecoverForceKill()}
          onRespawn={() => void handleRecoverRespawn()}
          payload={recoverPayload}
        />
      ) : null}
      {switchAuthOpen ? (
        <SwitchAuthDialog
          accounts={(session.claudeAccounts ?? []).filter((account) => account.authenticated)}
          activeAccountId={session.activeClaudeAccountId ?? null}
          status={switchAuthPending ? "pending" : switchAuthError ? "error" : "idle"}
          errorMessage={switchAuthError}
          onConfirm={(accountId, force) => void handleSwitchAuth(accountId, force)}
          onCancel={() => setSwitchAuthOpen(false)}
        />
      ) : null}
      {handoffOpen && handoffAgent ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="handoff-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
          onClick={(event) => {
            if (event.target === event.currentTarget && busy !== "handoff") {
              setHandoffOpen(false);
            }
          }}
        >
          <div
            className="flex w-full max-h-[calc(100vh-1rem)] flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:p-5"
            onKeyDown={(event) => {
              if (isVoiceToggleHotkey(event)) {
                event.preventDefault();
                handoffVoice.toggleRecording();
                return;
              }
              if (isPrimarySubmitHotkey(event)) {
                event.preventDefault();
                void handleHandoff();
              }
            }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2
                id="handoff-modal-title"
                className="font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]"
              >
                Handoff
              </h2>
              <button
                className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                disabled={busy === "handoff"}
                onClick={() => setHandoffOpen(false)}
                type="button"
              >
                ✕
              </button>
            </div>
            {prLink ? (
              <div
                className="mb-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--color-text-secondary)]"
                role="note"
              >
                This session links a PR ({prLink.url}). The handoff prompt asks the new agent to
                re-check PR state and CI before closing out.
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              <div className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--color-text-secondary)]">
                Spur builds the main handoff prompt from this session&apos;s task, links, branch,
                and workspace. Add optional notes below.
              </div>
              <div className="flex flex-wrap gap-2">
                <AgentSelect
                  ariaLabel="Handoff agent"
                  onChange={(next) => {
                    setHandoffAgent(next);
                    setHandoffModel(null);
                    setHandoffReasoningIntent(
                      next === session.agent ? { kind: "clear" } : initialReasoningIntent(false),
                    );
                  }}
                  value={handoffAgent}
                />
                <div className="contents">
                  <ModelReasoningField
                    submitting={busy === "handoff"}
                    agent={handoffAgent}
                    ariaLabel="Handoff model"
                    carry={{ agent: session.agent, model: session.model }}
                    onChange={setHandoffModel}
                    onValidityChange={setHandoffModelResolved}
                    lifecycle
                    reasoningLabel="Handoff reasoning"
                    reasoningIntent={handoffReasoningIntent}
                    onReasoningChange={setHandoffReasoningIntent}
                    projectReasoningEffort={handoffSpawnDefaults.reasoningEffort}
                    spawnDefaults={handoffSpawnDefaults}
                    value={handoffModel}
                  />
                </div>
              </div>
              <FileAttachmentTextarea
                ariaLabel="Handoff notes"
                attachments={[]}
                clearLabel="Clear handoff notes"
                minHeightClass="min-h-[8rem]"
                onAddFiles={() => {}}
                onChange={setHandoffNotes}
                onRemoveAttachment={() => {}}
                placeholder={voicePlaceholder("Optional notes for the next agent...", handoffVoice)}
                textareaRef={handoffNotesRef}
                value={handoffNotes}
                voice={handoffVoice}
              />
              {handoffVoice.voiceError ? (
                <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-[var(--color-chip-error-text)]">
                  {handoffVoice.voiceError}
                </div>
              ) : null}
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1 text-[10px] text-[var(--color-text-tertiary)]">
                  {handoffVoice.voiceBusy && !handoffVoice.recording ? (
                    <VoiceStatusHint voice={handoffVoice} />
                  ) : null}
                </span>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)] disabled:opacity-50"
                    disabled={busy === "handoff"}
                    onClick={() => setHandoffOpen(false)}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    aria-busy={busy === "handoff" || undefined}
                    aria-label={busy === "handoff" ? "Handing off session" : undefined}
                    className="inline-flex items-center gap-2 bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                    disabled={busy === "handoff" || !handoffModelResolved}
                    onClick={() => void handleHandoff()}
                    type="button"
                  >
                    <BusyContent busy={busy === "handoff"}>
                      <span>Handoff</span>
                      <span
                        aria-hidden="true"
                        className="ml-2 whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-inverse)]/70"
                      >
                        {PRIMARY_SUBMIT_HINT}
                      </span>
                    </BusyContent>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {respawnOpen && respawnAgent ? (
        <SpawnModal
          agent={respawnAgent}
          agentAriaLabel="Respawn agent"
          attachments={respawnAttachments}
          canClose={busy !== "respawn"}
          clearLabel="Clear respawn prompt"
          history={{ entries: respawnHistory.entries, onSelect: setRespawnPrompt }}
          mode={{
            kind: "respawn",
            model: {
              value: respawnModel,
              reasoningIntent: respawnReasoningIntent,
              onReasoningChange: setRespawnReasoningIntent,
              onChange: setRespawnModel,
              spawnDefaults: respawnSpawnDefaults,
              carry: { agent: session.agent, model: session.model },
              onResolvedChange: setRespawnModelResolved,
            },
            artifactSlot:
              startupArtifacts.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    Keep existing images
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {startupArtifacts.map((artifact) => {
                      const selected = respawnStartupAttachmentIds.includes(artifact.id);
                      return (
                        <button
                          key={artifact.id}
                          className={`relative border ${selected ? "border-[var(--color-accent)]" : "border-[var(--color-border-default)]"}`}
                          onClick={() =>
                            setRespawnStartupAttachmentIds((current) =>
                              current.includes(artifact.id)
                                ? current.filter((id) => id !== artifact.id)
                                : [...current, artifact.id],
                            )
                          }
                          type="button"
                        >
                          <img
                            alt={artifact.name}
                            className="h-9 w-9 object-cover"
                            src={artifactUrl(session.id, artifact.id)}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null,
            noteSlot: prLink ? (
              <div
                className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--color-text-secondary)]"
                role="note"
              >
                <div>
                  This session links a PR ({prLink.url}). Respawn drops the replaced worktree after
                  success—confirm merges or updates first if needed.
                </div>
              </div>
            ) : null,
          }}
          onAddFiles={addFiles(setRespawnAttachments)}
          onAgentChange={(next) => {
            setRespawnAgent(next);
            setRespawnModel(null);
            setRespawnReasoningIntent(
              next === session.agent ? { kind: "clear" } : initialReasoningIntent(false),
            );
          }}
          onClose={() => setRespawnOpen(false)}
          onPromptChange={setRespawnPrompt}
          onRemoveAttachment={(index) =>
            setRespawnAttachments((current) =>
              current.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          onSubmit={() => void handleRespawn()}
          prompt={respawnPrompt}
          promptPlaceholder="Initial message..."
          promptRef={respawnPromptRef}
          showCancel
          slashEndpoint={`/api/projects/${encodeURIComponent(session.projectId)}/slash-commands?agent=${encodeURIComponent(respawnAgent)}`}
          submitBusyAriaLabel="Respawning session"
          submitDisabled={
            busy === "respawn" ||
            !respawnModelResolved ||
            (!respawnPrompt.trim() &&
              respawnStartupAttachmentIds.length === 0 &&
              respawnAttachments.length === 0)
          }
          submitLabel="Respawn"
          submitting={busy === "respawn"}
          title="Edit & Respawn"
          voice={respawnVoice}
        />
      ) : null}
      {deskSpawnOpen ? (
        <SpawnModal
          agent={deskSpawnAgent}
          agentAriaLabel="Desk spawn agent"
          attachments={deskSpawnAttachments}
          canClose={!deskSpawning}
          clearLabel="Clear desk agent prompt"
          history={{ entries: deskSpawnHistory.entries, onSelect: setDeskSpawnPrompt }}
          mode={{
            kind: "desk",
            model: {
              value: deskSpawnModel,
              reasoningIntent: deskSpawnReasoningIntent,
              onReasoningChange: setDeskSpawnReasoningIntent,
              onChange: setDeskSpawnModel,
              spawnDefaults: deskSpawnDefaults,
              carry: { agent: session.agent, model: session.model },
              onResolvedChange: setDeskSpawnModelResolved,
            },
            branch: { value: deskSpawnBranch, onChange: setDeskSpawnBranch },
            planMode: { value: deskSpawnPlanMode, onChange: setDeskSpawnPlanMode },
            steps: {
              items: deskSpawnSteps,
              onUpdate: updateDeskSpawnStep,
              onAdd: addDeskSpawnStep,
              onRemove: removeDeskSpawnStep,
            },
          }}
          onAddFiles={addFiles(setDeskSpawnAttachments)}
          onAgentChange={(next) => {
            setDeskSpawnAgent(next);
            setDeskSpawnModel(null);
            setDeskSpawnReasoningIntent(initialReasoningIntent(false));
            setDeskSpawnModelResolved(false);
          }}
          onClose={() => setDeskSpawnOpen(false)}
          onPromptChange={setDeskSpawnPrompt}
          onRemoveAttachment={(index) =>
            setDeskSpawnAttachments((current) =>
              current.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          onSubmit={() => void handleDeskSpawn()}
          prompt={deskSpawnPrompt}
          promptAriaLabel="Desk agent prompt"
          promptPlaceholder="First message"
          promptRef={deskSpawnPromptRef}
          showCancel
          slashEndpoint={`/api/projects/${encodeURIComponent(session.projectId)}/slash-commands?agent=${encodeURIComponent(deskSpawnAgent)}`}
          submitBusyAriaLabel="Spawning desk agent"
          submitDisabled={deskSpawning || !deskSpawnModelResolved}
          submitLabel="Spawn"
          submitting={deskSpawning}
          title="Desk agent"
          voice={deskSpawnVoice}
        />
      ) : null}
    </>
  ) : null;

  return {
    busy,
    deskSpawning,
    openHandoff,
    openRespawn,
    openDeskSpawn,
    openSwitchAuth,
    openRecover,
    closeRecover: () => setRecoverPayload(null),
    dialogs,
  };
}
