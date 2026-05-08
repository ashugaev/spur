"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageAttachmentTextarea } from "@/components/ImageAttachmentTextarea";
import { InputHistoryButton } from "@/components/InputHistory";
import { SessionLinkBadge } from "@/components/SessionLinkBadge";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { useInputHistory } from "@/hooks/useInputHistory";
import { ActivityDot } from "@/components/ActivityDot";
import { TerminalModal } from "@/components/TerminalModal";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  getSessionSubtitle,
  getSessionTitle,
  truncateMiddle,
} from "@/lib/format";
import { isReviewLinkLabel, reviewProviderFromUrl } from "@/lib/link-icons";
import {
  buildDashboardPath,
  buildSessionPath,
  getTerminalQuerySessionId,
  withTerminalQuery,
} from "@/lib/project-routes";
import {
  encodeImageAttachments,
  imageAttachmentsFromFiles,
  type ImageAttachment,
} from "@/lib/image-attachments";
import {
  isPrimarySubmitHotkey,
  isVoiceToggleHotkey,
  PRIMARY_SUBMIT_HINT,
} from "@/lib/submit-hotkeys";
import {
  canComplete,
  canPause,
  canRespawn,
  canSendMessage,
  hasServiceProblems,
  isRestorable,
  isTerminalSession,
  toDashboardSession,
  type ConversationResponse,
  type DashboardSession,
  type SpurSessionView,
} from "@/lib/types";

function displayLinkLabel(label: string, url: string): string {
  if (label === "github-pr") return "github pr";
  if (label === "gitlab-pr") return "gitlab mr";
  if (label === "pr") {
    return reviewProviderFromUrl(url) === "gitlab" ? "gitlab mr" : "github pr";
  }
  return label;
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
      <path d="M4 3.25v9.5L12 8 4 3.25Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
      <path d="M4 4h8v8H4z" />
    </svg>
  );
}

function ArtifactFileIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 24 24"
    >
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 16 16"
    >
      <path
        d="M5.25 5.25V3.5A1.25 1.25 0 0 1 6.5 2.25h6A1.25 1.25 0 0 1 13.75 3.5v6a1.25 1.25 0 0 1-1.25 1.25H10.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path
        d="M3.5 5.25h6A1.25 1.25 0 0 1 10.75 6.5v6A1.25 1.25 0 0 1 9.5 13.75h-6A1.25 1.25 0 0 1 2.25 12.5v-6A1.25 1.25 0 0 1 3.5 5.25Z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function ArtifactDownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d="M12 4v12" />
      <path d="m6 12 6 6 6-6" />
      <path d="M4 20h16" />
    </svg>
  );
}

function ArtifactPreviewIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
      <path d="M4 3.25v9.5L12 8 4 3.25Z" />
    </svg>
  );
}

function ArtifactImagePreviewIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
    >
      <path d="M2.5 5V2.5H5" />
      <path d="M11 2.5h2.5V5" />
      <path d="M13.5 11v2.5H11" />
      <path d="M5 13.5H2.5V11" />
      <path d="M5.5 5.5h5v5h-5z" />
    </svg>
  );
}

function ArtifactCloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path d="M3 3l10 10M13 3 3 13" />
    </svg>
  );
}

const POLL_INTERVAL_MS = 4_000;
const SESSION_MESSAGE_HISTORY_STORAGE_KEY = "spur:input-history:session-message";
const HARD_WRAP_TEXT_CLASS = "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]";

interface LogEntry {
  timestamp: string;
  event: string;
  level: string;
  message?: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

type ArtifactPreviewState = "loading" | "ready" | "error";
type ArtifactCategory = "agent" | "attached" | "system";

type SessionArtifact = DashboardSession["artifacts"][number];

function artifactUrl(sessionId: string, artifactId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

function artifactExtension(name: string): string {
  const ext = name.split(".").pop();
  return ext ? ext.toUpperCase() : "FILE";
}

function overlayButtonClass(primary = false): string {
  return [
    "inline-flex h-8 w-8 items-center justify-center border transition",
    primary
      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)]"
      : "border-[var(--color-border-strong)] bg-[var(--color-bg-base)] text-[var(--color-text-primary)] hover:bg-[var(--color-hover-overlay)]",
  ].join(" ");
}

function ArtifactCard({
  artifact,
  artifactHref,
  previewState,
  onPreview,
  onPreviewError,
  onPreviewReady,
}: {
  artifact: SessionArtifact;
  artifactHref: string;
  previewState: ArtifactPreviewState;
  onPreview: (artifact: SessionArtifact) => void;
  onPreviewError: (artifactId: string) => void;
  onPreviewReady: (artifactId: string) => void;
}) {
  const previewable = artifact.kind === "image" || artifact.kind === "video";
  const PreviewIcon = artifact.kind === "video" ? ArtifactPreviewIcon : ArtifactImagePreviewIcon;

  return (
    <article className="group border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
      <div
        className={`relative isolate h-32 overflow-hidden border-b border-[var(--color-border-default)] bg-[var(--color-terminal-bg)] ${
          previewable ? "cursor-zoom-in" : ""
        }`}
        onClick={() => {
          if (previewable) onPreview(artifact);
        }}
      >
        {artifact.kind === "image" ? (
          <>
            <img
              alt={artifact.name}
              className={`pointer-events-none h-full w-full object-cover transition duration-150 ${previewState === "ready" ? "opacity-100" : "opacity-0"}`}
              onError={() => onPreviewError(artifact.id)}
              onLoad={() => onPreviewReady(artifact.id)}
              src={artifactHref}
            />
            {previewState !== "ready" ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-terminal-bg)] px-3 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                {previewState === "error" ? "Preview unavailable" : "Loading preview"}
              </div>
            ) : null}
          </>
        ) : null}
        {artifact.kind === "video" ? (
          <>
            <video
              aria-label={`${artifact.name} preview`}
              className={`pointer-events-none h-full w-full object-cover transition duration-150 ${previewState === "ready" ? "opacity-100" : "opacity-0"}`}
              muted
              onError={() => onPreviewError(artifact.id)}
              onLoadedData={() => onPreviewReady(artifact.id)}
              preload="metadata"
              src={artifactHref}
            />
            {previewState !== "ready" ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-terminal-bg)] px-3 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                {previewState === "error" ? "Preview unavailable" : "Loading preview"}
              </div>
            ) : null}
          </>
        ) : null}
        {artifact.kind === "download" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-tertiary)]">
            <ArtifactFileIcon />
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
              {artifactExtension(artifact.name)}
            </span>
          </div>
        ) : null}

        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[color:var(--color-modal-backdrop)] opacity-0 transition duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          {previewable ? (
            <button
              aria-label={`Preview ${artifact.name}`}
              className={overlayButtonClass(true)}
              onClick={(event) => {
                event.stopPropagation();
                onPreview(artifact);
              }}
              type="button"
            >
              <PreviewIcon />
            </button>
          ) : null}
          <a
            aria-label={`Download ${artifact.name}`}
            className={overlayButtonClass(false)}
            download={artifact.name}
            href={artifactHref}
            onClick={(event) => event.stopPropagation()}
          >
            <ArtifactDownloadIcon />
          </a>
        </div>
      </div>

      <div className="flex flex-col gap-1 px-3 py-2">
        <div
          className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[var(--color-text-primary)]"
          title={artifact.name}
        >
          {artifact.name}
        </div>
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--color-text-tertiary)]">
          {formatBytes(artifact.size)} · {artifact.kind} · {formatRelativeTime(artifact.updatedAt)}
        </div>
      </div>
    </article>
  );
}

function ArtifactLightbox({
  artifact,
  artifactHref,
  previewState,
  onClose,
  onPreviewError,
  onPreviewReady,
}: {
  artifact: SessionArtifact | null;
  artifactHref: string | null;
  previewState: ArtifactPreviewState;
  onClose: () => void;
  onPreviewError: (artifactId: string) => void;
  onPreviewReady: (artifactId: string) => void;
}) {
  if (!artifact || !artifactHref) return null;

  return (
    <div
      aria-label={`Artifact preview ${artifact.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--color-modal-backdrop)] p-2 backdrop-blur-sm sm:p-3"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="flex h-full w-full flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
              {artifact.name}
            </h2>
            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {formatBytes(artifact.size)} · {artifact.kind} ·{" "}
              {formatRelativeTime(artifact.updatedAt)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              className="inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
              download={artifact.name}
              href={artifactHref}
            >
              <ArtifactDownloadIcon />
              Download
            </a>
            <button
              aria-label="Close artifact preview"
              className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)]"
              onClick={onClose}
              type="button"
            >
              <ArtifactCloseIcon />
            </button>
          </div>
        </div>

        <div
          className="relative flex min-h-0 flex-1 items-center justify-center border border-[var(--color-border-default)] bg-[var(--color-terminal-bg)] p-3 sm:p-4"
          onClick={(event) => event.stopPropagation()}
        >
          {previewState !== "ready" ? (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {previewState === "error" ? "Preview unavailable" : "Loading preview"}
            </div>
          ) : null}
          {artifact.kind === "image" ? (
            <img
              alt={artifact.name}
              className={`max-h-full max-w-full object-contain ${previewState === "ready" ? "opacity-100" : "opacity-0"}`}
              onError={() => onPreviewError(artifact.id)}
              onLoad={() => onPreviewReady(artifact.id)}
              src={artifactHref}
            />
          ) : (
            <video
              aria-label={`${artifact.name} player`}
              autoPlay
              className={`max-h-full max-w-full ${previewState === "ready" ? "opacity-100" : "opacity-0"}`}
              controls
              onError={() => onPreviewError(artifact.id)}
              onLoadedData={() => onPreviewReady(artifact.id)}
              preload="metadata"
              src={artifactHref}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface DialogMessage {
  key: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

function insertTextAtCursor(
  element: HTMLTextAreaElement | null,
  value: string,
  setValue: (value: string) => void,
) {
  if (!element) {
    setValue(value);
    return;
  }
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? element.value.length;
  const next = `${element.value.slice(0, start)}${value}${element.value.slice(end)}`;
  setValue(next);
  queueMicrotask(() => {
    element.focus();
    const cursor = start + value.length;
    element.setSelectionRange(cursor, cursor);
  });
}

interface ToastState {
  id: number;
  tone: "success" | "error";
  title: string;
  detail?: string;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable.");
  }

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Clipboard is unavailable.");
    }
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}

function ToastBanner({ toast }: { toast: ToastState }) {
  const toneClass =
    toast.tone === "success"
      ? "border-[var(--color-status-ready)] bg-[var(--color-bg-surface)] text-[var(--color-text-primary)]"
      : "border-[var(--color-status-error)] bg-[var(--color-chip-error-bg)] text-[var(--color-chip-error-text)]";

  return (
    <div
      aria-live="polite"
      className={`pointer-events-auto min-w-72 max-w-sm border px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.35)] ${toneClass}`}
      role="status"
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.12em]">
        {toast.tone === "success" ? "Copied" : "Copy failed"}
      </div>
      <div className="mt-1 text-sm font-medium">{toast.title}</div>
      {toast.detail ? (
        <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{toast.detail}</div>
      ) : null}
    </div>
  );
}

function readLogDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function formatLogEventLabel(event: string): string {
  return event.replaceAll(".", " ");
}

function formatStateLabel(state: string): string {
  return state.replaceAll("_", " ");
}

function logRowAccent(level: string): string {
  if (level === "error") return "border-l-[var(--color-status-error)]";
  if (level === "warn") return "border-l-[var(--color-status-attention)]";
  return "border-l-[var(--color-status-working)]";
}

function logBadgeClass(level: string): string {
  if (level === "error") {
    return "border-[var(--color-status-error)] text-[var(--color-status-error)]";
  }
  if (level === "warn") {
    return "border-[var(--color-status-attention)] text-[var(--color-status-attention)]";
  }
  return "border-[var(--color-border-strong)] text-[var(--color-text-secondary)]";
}

function LogEntryRow({
  entry,
  sessionId,
  visibleArtifactIds,
}: {
  entry: LogEntry;
  sessionId: string;
  visibleArtifactIds: ReadonlySet<string>;
}) {
  const fromState = readLogDetail(entry.details, "fromState");
  const toState = readLogDetail(entry.details, "toState");
  const source = readLogDetail(entry.details, "source");
  const historyArtifactId = readLogDetail(entry.details, "historyArtifactId");
  const serviceId = readLogDetail(entry.details, "serviceId");
  const sidecarName = readLogDetail(entry.details, "sidecarName");
  const isStateTransition =
    entry.event === "session.state.transition" && Boolean(fromState) && Boolean(toState);
  const runtimeLabel =
    entry.event === "service.output"
      ? serviceId
        ? `service ${serviceId}`
        : "service"
      : entry.event === "sidecar.output"
        ? sidecarName
          ? `sidecar ${sidecarName}`
          : "sidecar"
        : null;
  const showHistorySnapshot =
    historyArtifactId !== null && visibleArtifactIds.has(historyArtifactId);

  return (
    <article
      className={`border-l-2 border-y border-r border-[var(--color-border-default)] bg-[var(--color-bg-surface)] ${logRowAccent(entry.level)}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        <span>{formatAbsoluteTime(entry.timestamp)}</span>
        <span className={`border px-2 py-0.5 ${logBadgeClass(entry.level)}`}>{entry.level}</span>
        <span className="border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-text-secondary)]">
          {runtimeLabel ?? formatLogEventLabel(entry.event)}
        </span>
        {source ? (
          <span className="border border-[var(--color-border-default)] px-2 py-0.5">
            source {source}
          </span>
        ) : null}
      </div>

      {isStateTransition ? (
        <div className="flex flex-wrap items-center gap-3 px-3 py-3">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Status transition
          </div>
          <div className="flex items-center gap-2 font-bold uppercase text-[var(--color-text-primary)]">
            <span className="border border-[var(--color-border-default)] px-2 py-1 text-[var(--color-text-secondary)]">
              {formatStateLabel(fromState ?? "")}
            </span>
            <span className="text-[var(--color-status-working)]">-&gt;</span>
            <span className="border border-[var(--color-status-working)] px-2 py-1">
              {formatStateLabel(toState ?? "")}
            </span>
          </div>
          {showHistorySnapshot ? (
            <a
              className="ml-auto border border-[var(--color-border-strong)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
              download={historyArtifactId}
              href={artifactUrl(sessionId, historyArtifactId)}
            >
              History snapshot
            </a>
          ) : null}
        </div>
      ) : (
        <div className="px-3 py-3">
          {entry.message ? (
            <pre
              className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5"
              style={{
                color: LOG_LEVEL_COLORS[entry.level] ?? "var(--color-text-primary)",
              }}
            >
              {entry.message}
            </pre>
          ) : (
            <div className="text-[var(--color-text-tertiary)]">No message payload.</div>
          )}
        </div>
      )}
    </article>
  );
}

const LOG_LEVEL_COLORS: Record<string, string> = {
  info: "var(--color-text-secondary)",
  warn: "var(--color-status-attention)",
  error: "var(--color-status-error)",
};

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SessionDetailProps {
  sessionId: string;
  projectId?: string;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallback;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(text) as unknown;
      if (typeof payload === "object" && payload !== null && "error" in payload) {
        return String((payload as { error?: unknown }).error ?? fallback);
      }
    } catch {
      return fallback;
    }
  }

  return text;
}

export function SessionDetail({ sessionId, projectId }: SessionDetailProps) {
  const router = useRouter();
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const messageHistory = useInputHistory(SESSION_MESSAGE_HISTORY_STORAGE_KEY);
  const voice = useVoiceInput({
    contextKey: `session:${sessionId}`,
    onTranscribed: (text) =>
      setMessage((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const [locationSearch, setLocationSearch] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [respawnOpen, setRespawnOpen] = useState(false);
  const [respawnPrompt, setRespawnPrompt] = useState("");
  const [respawnAttachments, setRespawnAttachments] = useState<ImageAttachment[]>([]);
  const [respawnStartupAttachmentIds, setRespawnStartupAttachmentIds] = useState<string[]>([]);
  const [conversation, setConversation] = useState<ConversationResponse | null>(null);
  const [artifactPreviewStates, setArtifactPreviewStates] = useState<
    Record<string, ArtifactPreviewState>
  >({});
  const [selectedArtifact, setSelectedArtifact] = useState<SessionArtifact | null>(null);
  const [artifactCategory, setArtifactCategory] = useState<ArtifactCategory>("agent");
  const [toast, setToast] = useState<ToastState | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastDialogTailRef = useRef<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Failed to load session"));
      }
      const payload = (await response.json()) as SpurSessionView;
      const nextSession = toDashboardSession(payload);
      setSession(nextSession);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load session");
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
    const timer = setInterval(() => {
      void loadSession();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadSession]);

  const loadConversation = useCallback(async () => {
    if (!session || session.agent !== "claude") {
      setConversation(null);
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversation`, {
        cache: "no-store",
      });
      if (res.ok) {
        setConversation((await res.json()) as ConversationResponse);
      } else {
        setConversation(null);
      }
    } catch {
      setConversation(null);
    }
  }, [session?.agent, sessionId]);

  useEffect(() => {
    void loadConversation();
    const timer = setInterval(() => void loadConversation(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadConversation]);

  useEffect(() => {
    const lastMessage = conversation?.messages.at(-1);
    const nextDialogTail =
      conversation?.state === "working"
        ? `pending:${lastMessage?.timestampMs ?? "none"}:${lastMessage?.role ?? "none"}:${lastMessage?.text ?? ""}`
        : lastMessage?.role === "assistant"
          ? `assistant:${lastMessage.timestampMs}:${lastMessage.text}`
          : null;
    if (!nextDialogTail || nextDialogTail === lastDialogTailRef.current) {
      return;
    }
    lastDialogTailRef.current = nextDialogTail;
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [conversation]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncSearch = () => setLocationSearch(window.location.search);
    syncSearch();
    window.addEventListener("popstate", syncSearch);
    return () => {
      window.removeEventListener("popstate", syncSearch);
    };
  }, []);

  useEffect(() => {
    setArtifactCategory("agent");
  }, [sessionId]);

  useEffect(() => {
    if (!session) return;
    setArtifactPreviewStates((current) => {
      const next: Record<string, ArtifactPreviewState> = {};
      for (const artifact of session.artifacts) {
        next[artifact.id] = current[artifact.id] ?? "loading";
      }
      return next;
    });
  }, [session]);

  useEffect(() => {
    if (!selectedArtifact) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedArtifact(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedArtifact]);

  const handleAction = async (
    action: "send" | "pause" | "restore" | "complete" | "kill",
    body?: Record<string, unknown>,
  ) => {
    if (
      action === "kill" &&
      !window.confirm(`Kill session ${sessionId}? This forces cleanup even with local changes.`)
    ) {
      return;
    }

    setBusyAction(action);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
      if (action === "send") {
        const submittedMessage =
          body && typeof body["message"] === "string" ? body["message"].trim() : "";
        if (submittedMessage) {
          messageHistory.saveEntry(submittedMessage);
        }
        setMessage("");
        setAttachments([]);
      }
      await loadSession();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Failed to ${action} session`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRespawn = async () => {
    setBusyAction("respawn");
    try {
      const payload: Record<string, unknown> = {
        prompt: respawnPrompt.trim(),
        startupAttachmentIds: respawnStartupAttachmentIds,
      };
      const encodedAttachments = encodeImageAttachments(respawnAttachments);
      if (encodedAttachments.length > 0) payload.attachments = encodedAttachments;
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/respawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as SpurSessionView;
      setRespawnOpen(false);
      router.push(buildSessionPath(data.id, projectId));
    } catch (respawnError) {
      setError(respawnError instanceof Error ? respawnError.message : "Failed to respawn session");
    } finally {
      setBusyAction(null);
    }
  };

  const handleSidecarAction = async (sidecarName: string, action: "start" | "stop") => {
    setBusyAction(`sidecar:${action}:${sidecarName}`);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/sidecars/${encodeURIComponent(sidecarName)}/${action}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as SpurSessionView;
      setSession(toDashboardSession(payload));
      setError(null);
    } catch (sidecarError) {
      setError(
        sidecarError instanceof Error
          ? sidecarError.message
          : `Failed to ${action} sidecar ${sidecarName}`,
      );
    } finally {
      setBusyAction(null);
    }
  };

  const openLogs = async () => {
    setLogsOpen(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/logs`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (Array.isArray(data)) {
        setLogEntries(data as LogEntry[]);
      }
    } catch {
      // Non-critical.
    }
  };

  const addImageFiles = (files: FileList | null) => {
    void imageAttachmentsFromFiles(files)
      .then((entries) => setAttachments((prev) => [...prev, ...entries]))
      .catch(() => {});
  };

  const addRespawnImageFiles = (files: FileList | null) => {
    void imageAttachmentsFromFiles(files)
      .then((entries) => setRespawnAttachments((prev) => [...prev, ...entries]))
      .catch(() => {});
  };

  const doSend = async (options?: { queue?: boolean; interrupt?: boolean }) => {
    const trimmed = message.trim();
    if (busyAction !== null || (!trimmed && attachments.length === 0)) return;
    const encoded = encodeImageAttachments(attachments);
    const body: Record<string, unknown> = { message: trimmed };
    if (encoded.length > 0) body.attachments = encoded;
    if (options?.queue !== undefined) body.queue = options.queue;
    if (options?.interrupt !== undefined) body.interrupt = options.interrupt;
    await handleAction("send", body);
  };

  const title = useMemo(
    () => (session ? getSessionTitle(session) : sessionId),
    [session, sessionId],
  );
  const subtitle = useMemo(() => (session ? getSessionSubtitle(session) : null), [session]);
  const displayState = useMemo(() => {
    if (!session) return undefined;
    if (session.state === "error" || session.state === "killed" || session.state === "stopped") {
      return session.state;
    }
    if (session.agent === "claude" && conversation?.state === "working") return "working";
    return session.state;
  }, [conversation?.state, session]);
  const dialogMessages = useMemo<DialogMessage[]>(
    () =>
      conversation
        ? [
            ...conversation.messages.map((msg) => ({
              key: `${msg.timestampMs}:${msg.role}:${msg.text}`,
              role: msg.role,
              text: msg.text,
            })),
            ...(conversation.state === "working"
              ? [
                  {
                    key: "pending-assistant-response",
                    role: "assistant" as const,
                    text: "...",
                    pending: true,
                  },
                ]
              : []),
          ]
        : [],
    [conversation],
  );
  const requestedTerminalSessionId = useMemo(
    () => getTerminalQuerySessionId(new URLSearchParams(locationSearch)),
    [locationSearch],
  );
  const sidecarLinkLabels = useMemo(
    () => new Set((session?.sidecars ?? []).map((sc) => sc.name)),
    [session],
  );
  const selectedArtifactHref =
    session && selectedArtifact ? artifactUrl(session.id, selectedArtifact.id) : null;
  const agentArtifacts = useMemo(
    () =>
      session?.artifacts.filter(
        (artifact) => artifact.origin !== "automatic" && artifact.addedByUser !== true,
      ) ?? [],
    [session],
  );
  const attachedArtifacts = useMemo(
    () =>
      session?.artifacts.filter(
        (artifact) => artifact.origin !== "automatic" && artifact.addedByUser === true,
      ) ?? [],
    [session],
  );
  const systemArtifacts = useMemo(
    () => session?.artifacts.filter((artifact) => artifact.origin === "automatic") ?? [],
    [session],
  );
  const visibleArtifacts = useMemo(
    () =>
      artifactCategory === "attached"
        ? attachedArtifacts
        : artifactCategory === "system"
          ? systemArtifacts
          : agentArtifacts,
    [artifactCategory, agentArtifacts, attachedArtifacts, systemArtifacts],
  );
  const visibleArtifactIds = useMemo(
    () => new Set(visibleArtifacts.map((artifact) => artifact.id)),
    [visibleArtifacts],
  );
  const startupArtifacts = useMemo(() => {
    const startupAttachmentIds = session?.startupAttachmentIds ?? [];
    return (
      session?.artifacts.filter((artifact) => startupAttachmentIds.includes(artifact.id)) ?? []
    );
  }, [session]);
  const visibleLinks = useMemo(
    () => session?.links.filter((link) => !sidecarLinkLabels.has(link.label)) ?? [],
    [session, sidecarLinkLabels],
  );
  const workspaceAccessItems = session?.workspaceAccess?.items ?? [];

  useEffect(() => {
    if (!selectedArtifact || !session) return;
    if (!visibleArtifacts.some((artifact) => artifact.id === selectedArtifact.id)) {
      setSelectedArtifact(null);
    }
  }, [selectedArtifact, session, visibleArtifacts]);

  useEffect(() => {
    const activeCount =
      artifactCategory === "attached"
        ? attachedArtifacts.length
        : artifactCategory === "system"
          ? systemArtifacts.length
          : agentArtifacts.length;
    if (artifactCategory !== "agent" && activeCount === 0) {
      setArtifactCategory("agent");
    }
  }, [artifactCategory, agentArtifacts.length, attachedArtifacts.length, systemArtifacts.length]);

  const canAttach =
    session && session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);
  const isSessionTerminal = Boolean(
    session &&
    (requestedTerminalSessionId === session.id ||
      (requestedTerminalSessionId !== null &&
        requestedTerminalSessionId.startsWith(`${session.id}--`))),
  );
  const terminalOpen = Boolean(canAttach && isSessionTerminal);

  const openRespawnEditor = useCallback(() => {
    if (!session) return;
    setRespawnPrompt(session.prompt);
    setRespawnStartupAttachmentIds(session.startupAttachmentIds ?? []);
    setRespawnAttachments([]);
    setRespawnOpen(true);
  }, [session]);

  useEffect(() => {
    if (!requestedTerminalSessionId || !session || typeof window === "undefined") return;
    if (isSessionTerminal && canAttach) return;

    const query = withTerminalQuery(window.location.search, null);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query}${window.location.hash}`,
    );
    setLocationSearch(window.location.search);
  }, [canAttach, isSessionTerminal, requestedTerminalSessionId, session]);

  const syncTerminalFilter = (terminalSessionId: string | null) => {
    if (typeof window === "undefined") return;
    const query = withTerminalQuery(window.location.search, terminalSessionId);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${query}${window.location.hash}`,
    );
    setLocationSearch(window.location.search);
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const copyWorkspaceAccessValue = useCallback(async (label: string, value: string) => {
    try {
      await copyTextToClipboard(value);
      setToast({
        id: Date.now(),
        tone: "success",
        title: `${label} copied`,
        detail: value.length > 96 ? `${value.slice(0, 96)}...` : value,
      });
    } catch (copyError) {
      setToast({
        id: Date.now(),
        tone: "error",
        title: `Couldn't copy ${label}`,
        detail: copyError instanceof Error ? copyError.message : "Clipboard is unavailable.",
      });
    }
  }, []);

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-4 sm:px-5 lg:px-6">
      <Link
        className="inline-flex items-center gap-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildDashboardPath(projectId)}
      >
        ← Back
      </Link>

      {error || voice.voiceError ? (
        <div className="mt-3 border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-3 py-2 text-[var(--color-chip-error-text)]">
          {error || voice.voiceError}
        </div>
      ) : null}

      {session ? (
        <>
          {/* Header */}
          <header className="mt-4 border-b-2 border-[var(--color-accent)] pb-4">
            <div className="flex flex-wrap items-center gap-2 text-[var(--color-text-tertiary)] uppercase tracking-[0.1em]">
              <span>{session.projectName}</span>
              <span>•</span>
              <span>{session.agent}</span>
              <span>•</span>
              <span className="font-mono">{session.id}</span>
            </div>

            <h1 className="mt-2 text-xl font-bold tracking-[-0.02em] text-[var(--color-text-primary)] uppercase sm:text-2xl">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-1 max-w-3xl text-[var(--color-text-secondary)]">{subtitle}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {displayState ? <ActivityDot activity={displayState} /> : null}
              {session.branch ? (
                <span className="border border-[var(--color-border-default)] px-2 py-0.5 font-mono text-[var(--color-text-secondary)]">
                  {session.branch}
                </span>
              ) : null}
              {session.links
                .filter((l) => l.label === "tracker" || isReviewLinkLabel(l.label))
                .map((link) => (
                  <SessionLinkBadge
                    key={`${link.label}-${link.url}`}
                    link={link}
                    variant="detail"
                  />
                ))}
              {!session.runtimeAlive && !isTerminalSession(session) ? (
                <span className="border border-[var(--color-chip-error-border)] px-2 py-0.5 text-[var(--color-chip-error-text)]">
                  offline
                </span>
              ) : null}
              {hasServiceProblems(session) ? (
                <span className="border border-[var(--color-chip-warn-border)] px-2 py-0.5 text-[var(--color-chip-warn-text)]">
                  service issue
                </span>
              ) : null}
            </div>
          </header>

          {/* Actions bar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] py-3">
            {canAttach ? (
              <button
                type="button"
                className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
                onClick={() => syncTerminalFilter(session.id)}
              >
                Terminal
              </button>
            ) : null}
            {canPause(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleAction("pause")}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              >
                {busyAction === "pause" ? "Pausing..." : "Pause"}
              </button>
            ) : null}
            {isRestorable(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleAction("restore")}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              >
                {busyAction === "restore" ? "Restoring..." : "Restore"}
              </button>
            ) : null}
            {canComplete(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleAction("complete")}
                className="border border-[var(--color-status-ready)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-ready)] transition hover:bg-[var(--color-status-ready)]/10 disabled:opacity-50"
              >
                {busyAction === "complete" ? "Completing..." : "Complete"}
              </button>
            ) : null}
            {!isTerminalSession(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleAction("kill", { force: true })}
                className="border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-status-error)]/10 disabled:opacity-50"
              >
                {busyAction === "kill" ? "Killing..." : "Kill"}
              </button>
            ) : null}
            {canRespawn(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={openRespawnEditor}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              >
                {busyAction === "respawn" ? "Respawning..." : "Edit & Respawn"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void openLogs()}
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
            >
              Logs
            </button>
          </div>

          {/* Content */}
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
            <div className="space-y-4">
              {/* Conversation dialog - Claude only */}
              {session.agent === "claude" && conversation?.messages.length ? (
                <section>
                  <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Dialog
                    <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                    {conversation.durationMs > 0 ? (
                      <span className="font-normal normal-case tracking-normal">
                        {formatDuration(conversation.durationMs)}
                      </span>
                    ) : null}
                  </h2>
                  <div
                    ref={dialogRef}
                    className="flex max-h-80 flex-col gap-2 overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3"
                  >
                    {dialogMessages.map((msg) => (
                      <div
                        key={msg.key}
                        aria-label={msg.pending ? "Assistant is responding" : undefined}
                        className={`min-w-0 max-w-[85%] px-3 py-2 text-sm ${
                          msg.role === "user"
                            ? "ml-auto border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]"
                            : msg.pending
                              ? "mr-auto border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-text-tertiary)]"
                              : "mr-auto border border-[var(--color-border-default)] text-[var(--color-text-secondary)]"
                        }`}
                      >
                        <div
                          className={`${HARD_WRAP_TEXT_CLASS} ${msg.pending ? "animate-pulse tracking-[0.3em]" : ""}`}
                        >
                          {msg.pending
                            ? msg.text
                            : msg.text.length > 500
                              ? msg.text.slice(0, 500) + "..."
                              : msg.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* Queued messages */}
              {session.queuedMessages.messages.length > 0 ||
              session.queuedMessages.awaitingPrompt ? (
                <section>
                  <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Queued messages
                    <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                  </h2>
                  {session.queuedMessages.messages.length > 0 ? (
                    <ol aria-label="Queued messages list" className="space-y-2">
                      {session.queuedMessages.messages.map((queuedMessage, index) => (
                        <li
                          key={`${session.id}:queued:${index}:${queuedMessage}`}
                          className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2"
                        >
                          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                            #{index + 1}
                          </div>
                          <div
                            className={`mt-1 ${HARD_WRAP_TEXT_CLASS} text-sm text-[var(--color-text-secondary)]`}
                          >
                            {queuedMessage}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {session.queuedMessages.awaitingPrompt ? (
                    <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                      Awaiting agent prompt. Queued messages will send automatically when the agent
                      is ready.
                    </p>
                  ) : null}
                </section>
              ) : null}

              {/* Message */}
              <section>
                <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  Message
                  <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                </h2>
                {canSendMessage(session) ? (
                  <div className="space-y-2">
                    <ImageAttachmentTextarea
                      attachments={attachments}
                      minHeightClass="min-h-24"
                      onAddFiles={addImageFiles}
                      onChange={setMessage}
                      onKeyDown={(event) => {
                        if (isVoiceToggleHotkey(event)) {
                          event.preventDefault();
                          voice.toggleRecording();
                          return;
                        }
                        if (isPrimarySubmitHotkey(event)) {
                          event.preventDefault();
                          void doSend({ queue: false, interrupt: true });
                        }
                      }}
                      onRemoveAttachment={(index) =>
                        setAttachments((current) =>
                          current.filter((_, currentIndex) => currentIndex !== index),
                        )
                      }
                      placeholder={voicePlaceholder("Message to the running agent...", voice)}
                      textareaRef={messageRef}
                      value={message}
                      voice={voice}
                    />
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 text-[10px] text-[var(--color-text-tertiary)]">
                        {voice.voiceBusy && !voice.recording ? (
                          <VoiceStatusHint voice={voice} />
                        ) : null}
                      </span>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <SlashSuggestions
                          endpoint={
                            session
                              ? `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`
                              : null
                          }
                          onSelect={(entry) =>
                            insertTextAtCursor(messageRef.current, entry.insertText, setMessage)
                          }
                        />
                        <InputHistoryButton
                          entries={messageHistory.entries}
                          onSelect={setMessage}
                        />
                        <button
                          type="button"
                          disabled={
                            busyAction !== null || (!message.trim() && attachments.length === 0)
                          }
                          onClick={() => void doSend({ queue: true })}
                          className="inline-flex items-center border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                        >
                          <span>{busyAction === "send" ? "Queueing..." : "Queue"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={
                            busyAction !== null || (!message.trim() && attachments.length === 0)
                          }
                          onClick={() => void doSend({ queue: false, interrupt: true })}
                          className="inline-flex items-center bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                        >
                          <span>{busyAction === "send" ? "Sending..." : "Send now"}</span>
                          {busyAction !== "send" ? (
                            <span
                              aria-hidden="true"
                              className="ml-2 whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-tertiary)]"
                            >
                              {PRIMARY_SUBMIT_HINT}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="py-2 text-[var(--color-text-secondary)]">
                    Not accepting input. Restore to continue.
                  </p>
                )}
              </section>

              {/* Links */}
              {visibleLinks.length > 0 ? (
                <section>
                  <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Links
                    <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {visibleLinks.map((link) => (
                      <a
                        key={`${session.id}-${link.label}-${link.url}`}
                        className="border border-[var(--color-border-default)] px-2.5 py-1 text-[var(--color-accent)] hover:no-underline"
                        href={link.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {displayLinkLabel(link.label, link.url)}
                      </a>
                    ))}
                  </div>
                </section>
              ) : null}

              {session.artifacts.length > 0 ? (
                <section>
                  <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Artifacts
                    <span className="text-[var(--color-text-secondary)]">
                      {visibleArtifacts.length}
                    </span>
                    <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                  </h2>
                  {attachedArtifacts.length > 0 || systemArtifacts.length > 0 ? (
                    <div
                      aria-label="Artifact category"
                      className="mb-3 inline-flex border border-[var(--color-border-default)]"
                      role="tablist"
                    >
                      {(
                        [
                          ["agent", `Agent (${agentArtifacts.length})`],
                          ...(attachedArtifacts.length > 0
                            ? ([["attached", `Attached (${attachedArtifacts.length})`]] as const)
                            : []),
                          ...(systemArtifacts.length > 0
                            ? ([["system", `System (${systemArtifacts.length})`]] as const)
                            : []),
                        ] as ReadonlyArray<readonly [ArtifactCategory, string]>
                      ).map(([value, label]) => {
                        const active = artifactCategory === value;
                        return (
                          <button
                            key={value}
                            aria-pressed={active}
                            className={`border-r border-[var(--color-border-default)] px-3 py-1.5 font-bold uppercase tracking-[0.12em] last:border-r-0 ${
                              active
                                ? "bg-[var(--color-accent)] text-[var(--color-text-inverse)]"
                                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)]"
                            }`}
                            onClick={() => setArtifactCategory(value)}
                            type="button"
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {visibleArtifacts.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {visibleArtifacts.map((artifact) => {
                        const artifactHref = artifactUrl(session.id, artifact.id);
                        const previewState = artifactPreviewStates[artifact.id] ?? "loading";
                        return (
                          <ArtifactCard
                            key={`${session.id}-${artifact.id}`}
                            artifact={artifact}
                            artifactHref={artifactHref}
                            onPreview={setSelectedArtifact}
                            onPreviewError={(artifactId) =>
                              setArtifactPreviewStates((current) => ({
                                ...current,
                                [artifactId]: "error",
                              }))
                            }
                            onPreviewReady={(artifactId) =>
                              setArtifactPreviewStates((current) => ({
                                ...current,
                                [artifactId]: "ready",
                              }))
                            }
                            previewState={previewState}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <p className="py-2 text-[var(--color-text-secondary)]">
                      {artifactCategory === "attached"
                        ? "No attached artifacts yet."
                        : artifactCategory === "system"
                          ? "No system artifacts yet."
                          : "No agent artifacts yet."}
                    </p>
                  )}
                </section>
              ) : null}

              {/* Services */}
              {session.services.length > 0 ? (
                <section>
                  <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Services
                    <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                  </h2>
                  {session.services.map((service) => (
                    <div
                      key={`${session.id}-${service.serviceId}`}
                      className="data-row flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] px-2 py-2"
                    >
                      <div>
                        <span className="font-mono text-[var(--color-text-primary)]">
                          {service.serviceId}
                        </span>
                        <span className="ml-2 text-[var(--color-text-tertiary)]">
                          {service.command}
                        </span>
                      </div>
                      <span className="text-[var(--color-text-secondary)]">
                        {service.state}
                        {typeof service.port === "number" ? ` :${service.port}` : ""}
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}
            </div>

            {/* Runtime sidebar */}
            <section>
              <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                Runtime
                <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
              </h2>
              <dl className="space-y-2 text-[var(--color-text-secondary)]">
                {[
                  ["Created", formatAbsoluteTime(session.createdAt)],
                  ["Last activity", formatRelativeTime(session.lastActivityAt)],
                  ["Worktree", session.worktree ? "isolated" : "shared"],
                  ["Agent runtime", session.runtimeAlive ? "alive" : "offline"],
                  ["Workspace", session.workspaceExists ? "present" : "missing"],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] py-1.5"
                  >
                    <dt className="text-[var(--color-text-tertiary)]">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  Worktree path
                </div>
                <div className="mt-1 font-mono text-[var(--color-text-secondary)]">
                  {truncateMiddle(session.worktreePath, 60)}
                </div>
              </div>

              {workspaceAccessItems.length > 0 ? (
                <div className="mt-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    Workspace Access
                  </div>
                  <div className="mt-2 space-y-2">
                    {workspaceAccessItems.map((item) => (
                      <div
                        key={`${item.kind}:${item.label}:${item.value}`}
                        className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)]">
                              {item.label}
                            </div>
                          </div>
                          {item.kind === "link" ? (
                            <a
                              aria-label={`Open ${item.label}`}
                              className="border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
                              href={item.value}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open
                            </a>
                          ) : (
                            <button
                              aria-label={`Copy ${item.label}`}
                              type="button"
                              className="inline-flex h-7 w-7 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-primary)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] active:scale-[0.97]"
                              onClick={() => void copyWorkspaceAccessValue(item.label, item.value)}
                            >
                              <CopyIcon />
                            </button>
                          )}
                        </div>
                        <code className="mt-2 block whitespace-pre-wrap break-all font-mono text-[var(--color-text-secondary)]">
                          {item.value}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {session.error ? (
                <div className="mt-3 border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-2 text-[var(--color-chip-error-text)]">
                  {session.error}
                </div>
              ) : null}
            </section>

            {/* Sidecars */}
            {session.sidecars.length > 0 ? (
              <section>
                <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  Sidecars
                  <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                </h2>
                <div className="space-y-2">
                  {session.sidecars.map((sc) => {
                    const sidecarOpenUrl = sc.alive
                      ? session.links.find((link) => link.label === sc.name)?.url
                      : undefined;
                    return (
                      <div
                        key={sc.name}
                        className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${sc.alive ? "bg-[var(--color-chip-alive)]" : "bg-[var(--color-text-tertiary)]"}`}
                          />
                          <span className="text-[var(--color-text-secondary)]">{sc.name}</span>
                          <span className="text-[var(--color-text-tertiary)]">
                            {sc.alive ? "alive" : "offline"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {sc.alive && canAttach ? (
                            <button
                              type="button"
                              className="border border-[var(--color-border-strong)] px-2 py-0.5 text-xs font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
                              onClick={() => syncTerminalFilter(`${session.id}--${sc.name}`)}
                            >
                              Terminal
                            </button>
                          ) : null}
                          {sidecarOpenUrl ? (
                            <a
                              className="border border-[var(--color-border-strong)] px-2 py-0.5 text-xs font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
                              href={sidecarOpenUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open
                            </a>
                          ) : null}
                          <button
                            aria-label={`${sc.alive ? "Stop" : "Start"} sidecar ${sc.name}`}
                            className="inline-flex h-6 w-6 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={busyAction !== null}
                            onClick={() =>
                              void handleSidecarAction(sc.name, sc.alive ? "stop" : "start")
                            }
                            type="button"
                          >
                            {sc.alive ? <StopIcon /> : <PlayIcon />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>

          {/* Logs modal */}
          {logsOpen ? (
            <div
              className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg-base)]"
              role="dialog"
              aria-label={`Logs ${session.id}`}
            >
              <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border-default)] px-4 py-3">
                <div>
                  <div className="font-bold uppercase text-[var(--color-text-primary)]">
                    Logs {session.id}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    Spur orchestrator events and runtime output
                  </div>
                </div>
                <button
                  type="button"
                  className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                  onClick={() => setLogsOpen(false)}
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-4">
                {logEntries.length === 0 ? (
                  <div className="flex h-full items-center justify-center border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 text-center text-[var(--color-text-tertiary)]">
                    No Spur log entries yet.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {logEntries.map((entry, i) => (
                      <LogEntryRow
                        key={`${entry.timestamp}-${entry.event}-${i}`}
                        entry={entry}
                        sessionId={session.id}
                        visibleArtifactIds={visibleArtifactIds}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {/* Terminal modal */}
          {terminalOpen && canAttach ? (
            <TerminalModal
              onClose={() => syncTerminalFilter(null)}
              session={session}
              tmuxSessionOverride={
                requestedTerminalSessionId !== session.id
                  ? (requestedTerminalSessionId ?? undefined)
                  : undefined
              }
              titleSuffix={
                requestedTerminalSessionId !== session.id
                  ? requestedTerminalSessionId?.replace(`${session.id}--`, "")
                  : undefined
              }
            />
          ) : null}
          {respawnOpen && session ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
              onClick={(event) => {
                if (event.target === event.currentTarget && busyAction !== "respawn") {
                  setRespawnOpen(false);
                }
              }}
            >
              <div className="flex w-full max-h-[calc(100vh-1rem)] flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
                    Edit & Respawn
                  </h2>
                  <button
                    className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                    disabled={busyAction === "respawn"}
                    onClick={() => setRespawnOpen(false)}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <ImageAttachmentTextarea
                    attachments={respawnAttachments}
                    minHeightClass="min-h-[10rem]"
                    onAddFiles={addRespawnImageFiles}
                    onChange={setRespawnPrompt}
                    onRemoveAttachment={(index) =>
                      setRespawnAttachments((current) =>
                        current.filter((_, currentIndex) => currentIndex !== index),
                      )
                    }
                    placeholder="Edit the initial message..."
                    value={respawnPrompt}
                  />
                  {startupArtifacts.length > 0 ? (
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
                  ) : null}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
                      disabled={busyAction === "respawn"}
                      onClick={() => setRespawnOpen(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                      disabled={
                        busyAction === "respawn" ||
                        (!respawnPrompt.trim() &&
                          respawnStartupAttachmentIds.length === 0 &&
                          respawnAttachments.length === 0)
                      }
                      onClick={() => void handleRespawn()}
                      type="button"
                    >
                      {busyAction === "respawn" ? "Respawning..." : "Respawn"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <ArtifactLightbox
            artifact={selectedArtifact}
            artifactHref={selectedArtifactHref}
            onClose={() => setSelectedArtifact(null)}
            onPreviewError={(artifactId) =>
              setArtifactPreviewStates((current) => ({
                ...current,
                [artifactId]: "error",
              }))
            }
            onPreviewReady={(artifactId) =>
              setArtifactPreviewStates((current) => ({
                ...current,
                [artifactId]: "ready",
              }))
            }
            previewState={
              selectedArtifact
                ? (artifactPreviewStates[selectedArtifact.id] ?? "loading")
                : "loading"
            }
          />
        </>
      ) : error ? (
        <div className="mt-5 max-w-xl border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-3 py-3 text-[var(--color-chip-error-text)]">
          <p>Unable to load this session.</p>
          <button
            type="button"
            onClick={() => void loadSession()}
            className="mt-3 border border-[var(--color-chip-error-border)] px-3 py-1.5 font-bold uppercase text-[var(--color-chip-error-text)] transition hover:bg-[var(--color-status-error)]/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <p className="mt-5 text-[var(--color-text-secondary)]">Loading session...</p>
      )}
      {toast ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50">
          <ToastBanner toast={toast} />
        </div>
      ) : null}
    </main>
  );
}
