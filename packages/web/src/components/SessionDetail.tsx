"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import { AgentSelect } from "@/components/AgentSelect";
import { ModelSelect } from "@/components/ModelSelect";
import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";
import { InputHistoryButton } from "@/components/InputHistory";
import { GithubRateLimitDialog } from "@/components/GithubRateLimitDialog";
import { OpenPrActionDialog } from "@/components/OpenPrActionDialog";
import { RecoverActionDialog } from "@/components/RecoverActionDialog";
import { SessionLinkBadge } from "@/components/SessionLinkBadge";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { SpawnModal } from "@/components/SpawnModal";
import { TagEditor } from "@/components/TagEditor";
import { TagsContext, type TagChange } from "@/components/TagsContext";
import { useTagCatalog } from "@/hooks/useTagCatalog";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { StopSquareIcon, VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { useInputHistory } from "@/hooks/useInputHistory";
import { ActivityDot } from "@/components/ActivityDot";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { TerminalModal } from "@/components/TerminalModal";
import { ToastViewport } from "@/components/Toast";
import { Spinner } from "@/components/icons/Spinner";
import { IconCloseButton } from "@/components/IconCloseButton";
import { INPUT_CLASS } from "@/design/classes";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  getSessionTitle,
  truncateMiddle,
} from "@/lib/format";
import { parseSessionPromptView } from "@/lib/session-prompt";
import { isReviewLinkLabel, reviewProviderFromUrl } from "@/lib/link-icons";
import {
  buildDashboardPath,
  buildSessionPath,
  getTerminalQuerySessionId,
  withTerminalQuery,
} from "@/lib/project-routes";
import {
  encodeFileAttachments,
  fileAttachmentsFromFiles,
  type FileAttachment,
} from "@/lib/file-attachments";
import { errorMessage, readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { insertTextAtCursor } from "@/lib/textarea";
import { useToasts } from "@/hooks/useToasts";
import {
  isPrimarySubmitHotkey,
  isVoiceToggleHotkey,
  PRIMARY_SUBMIT_HINT,
} from "@/lib/submit-hotkeys";
import {
  canComplete,
  canHandoff,
  canPause,
  canRecover,
  canRespawn,
  canSendMessage,
  hasServiceProblems,
  isGithubPrCheckUnavailablePayload,
  isOpenPrActionRequiredPayload,
  isRestorable,
  isSessionNotRestorablePayload,
  isTerminalSession,
  toDashboardSession,
  type ConversationResponse,
  type DashboardSession,
  type GithubPrCheckUnavailablePayload,
  type OpenPrAction,
  type OpenPrActionRequiredPayload,
  type SessionNotRestorablePayload,
  type SpurSidecarPortConflict,
  type SpurSessionView,
} from "@/lib/types";
import { formatIntervalDuration, formatWakeCountdown, getWakeSummary } from "@/lib/wake-format";

function buildLocalRecoverPayload(session: DashboardSession): SessionNotRestorablePayload {
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

function displayLinkLabel(label: string, url: string): string {
  if (label === "github-pr") return "github pr";
  if (label === "gitlab-pr") return "gitlab mr";
  if (label === "pr") {
    return reviewProviderFromUrl(url) === "gitlab" ? "gitlab mr" : "github pr";
  }
  return label;
}

function splitSessionLinks(
  links: DashboardSession["links"],
  sidecarLinkLabels: Set<string>,
): {
  surfacedLinks: DashboardSession["links"];
  visibleLinks: DashboardSession["links"];
} {
  const surfacedLinks: DashboardSession["links"] = [];
  const visibleLinks: DashboardSession["links"] = [];
  const surfacedUrls = new Set<string>();

  for (const link of links) {
    if (link.label === "tracker" || isReviewLinkLabel(link.label)) {
      if (!surfacedUrls.has(link.url)) {
        surfacedLinks.push(link);
        surfacedUrls.add(link.url);
      }
      continue;
    }
    if (!sidecarLinkLabels.has(link.label) && !surfacedUrls.has(link.url)) {
      visibleLinks.push(link);
    }
  }

  return { surfacedLinks, visibleLinks };
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
      <path d="M4 3.25v9.5L12 8 4 3.25Z" />
    </svg>
  );
}

function WakeIcon({ recurring }: { recurring: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
      {recurring ? <path d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8" /> : null}
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

function CopyIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
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

function PromptSectionCopyButton({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (label: string, value: string) => void | Promise<void>;
}) {
  const copyLabel = label.toLowerCase();
  return (
    <button
      aria-label={`Copy ${copyLabel}`}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-tertiary)] opacity-70 transition hover:text-[var(--color-text-secondary)] hover:opacity-100 active:scale-[0.97]"
      onClick={() => void onCopy(label, value)}
      title={`Copy ${copyLabel}`}
      type="button"
    >
      <CopyIcon className="h-3 w-3" />
    </button>
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

function ArtifactPreviousIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 16 16"
    >
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

function ArtifactNextIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 16 16"
    >
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function ArtifactZoomInIcon() {
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
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
      <path d="M7 5v4M5 7h4" />
    </svg>
  );
}

function ArtifactZoomOutIcon() {
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
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
      <path d="M5 7h4" />
    </svg>
  );
}

function ArtifactZoomResetIcon() {
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
    </svg>
  );
}

const POLL_INTERVAL_MS = 4_000;
const SESSION_MESSAGE_HISTORY_STORAGE_KEY = "spur:input-history:session-message";
const DESK_SPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:desk-spawn-prompt";
const RESPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:respawn-prompt";
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
type TextArtifactPreviewState = ArtifactPreviewState | "oversize";
type ArtifactSwipeStart = {
  pointerId: number;
  x: number;
  y: number;
};

const COPY_TEXT_LABELS = {
  idle: "Copy",
  copying: "Copying...",
  copied: "Copied",
  error: "Copy failed",
} as const;

const TEXT_ARTIFACT_MAX_BYTES = 1024 * 1024;
const ARTIFACT_LIGHTBOX_SWIPE_THRESHOLD_PX = 48;
const ARTIFACT_LIGHTBOX_INTERACTIVE_SELECTOR =
  "a,button,input,textarea,select,video,pre,[data-artifact-lightbox-interactive]";

type SessionArtifact = DashboardSession["artifacts"][number];

function artifactUrl(sessionId: string, artifactId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

function artifactExtension(name: string): string {
  const ext = name.split(".").pop();
  return ext ? ext.toUpperCase() : "FILE";
}

function artifactKindLabel(artifact: SessionArtifact): string {
  if (artifact.addedByUser && artifact.kind === "image") return "Attached Image";
  if (artifact.addedByUser) return "Attached";
  if (artifact.origin === "automatic") return "System";
  return artifact.kind;
}

function isArtifactLightboxInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(ARTIFACT_LIGHTBOX_INTERACTIVE_SELECTOR) !== null;
}

function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
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
  variant = "compact",
  onPreview,
  onPreviewError,
  onPreviewReady,
}: {
  artifact: SessionArtifact;
  artifactHref: string;
  previewState: ArtifactPreviewState;
  variant?: "compact" | "attachedImage";
  onPreview: (artifactId: string) => void;
  onPreviewError: (artifactId: string) => void;
  onPreviewReady: (artifactId: string) => void;
}) {
  const PreviewIcon =
    artifact.kind === "video"
      ? ArtifactPreviewIcon
      : artifact.kind === "image"
        ? ArtifactImagePreviewIcon
        : ArtifactFileIcon;
  const polishedAttachedImage = variant === "attachedImage" && artifact.kind === "image";
  const frameClass = polishedAttachedImage ? "h-48 sm:h-56" : "h-32";
  const mediaFitClass = polishedAttachedImage ? "object-contain p-2" : "object-cover";

  return (
    <article
      aria-label={`${artifactKindLabel(artifact)} artifact ${artifact.name}`}
      className={`group border bg-[var(--color-bg-surface)] ${
        polishedAttachedImage
          ? "border-[var(--color-border-strong)]"
          : "border-[var(--color-border-default)]"
      }`}
    >
      <div
        className={`relative isolate ${frameClass} cursor-zoom-in overflow-hidden border-b border-[var(--color-border-default)] bg-[var(--color-terminal-bg)]`}
        onClick={() => {
          onPreview(artifact.id);
        }}
      >
        {artifact.kind === "image" ? (
          <>
            <img
              alt={artifact.name}
              className={`pointer-events-none h-full w-full ${mediaFitClass} transition duration-150 ${previewState === "ready" ? "opacity-100" : "opacity-0"}`}
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
        {artifact.kind !== "image" && artifact.kind !== "video" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-tertiary)]">
            <ArtifactFileIcon />
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
              {artifactExtension(artifact.name)}
            </span>
          </div>
        ) : null}

        {polishedAttachedImage ? (
          <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
            <span className="border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)]">
              Attached Image
            </span>
            <span className="border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
              {artifactExtension(artifact.name)}
            </span>
          </div>
        ) : null}

        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[color:var(--color-modal-backdrop)] opacity-0 transition duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <button
            aria-label={`Preview ${artifact.name}`}
            className={overlayButtonClass(true)}
            onClick={(event) => {
              event.stopPropagation();
              onPreview(artifact.id);
            }}
            type="button"
          >
            <PreviewIcon />
          </button>
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
        {polishedAttachedImage ? (
          <div className="flex flex-wrap gap-1.5">
            <span className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
              {formatBytes(artifact.size)}
            </span>
            <span className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {formatRelativeTime(artifact.updatedAt)}
            </span>
          </div>
        ) : (
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--color-text-tertiary)]">
            {formatBytes(artifact.size)} · {artifact.kind} ·{" "}
            {formatRelativeTime(artifact.updatedAt)}
          </div>
        )}
      </div>
    </article>
  );
}

const ARTIFACT_IMAGE_MIN_SCALE = 1;
const ARTIFACT_IMAGE_MAX_SCALE = 5;
const ARTIFACT_IMAGE_ZOOM_STEP = 1.5;

type ArtifactImageGesture =
  | { mode: "pinch"; startDistance: number; startScale: number }
  | {
      mode: "pan";
      pointerId: number;
      startX: number;
      startY: number;
      startTranslateX: number;
      startTranslateY: number;
    };

function ArtifactImageViewer({
  artifact,
  artifactHref,
  previewState,
  onPreviewError,
  onPreviewReady,
}: {
  artifact: SessionArtifact;
  artifactHref: string;
  previewState: ArtifactPreviewState;
  onPreviewError: (artifactId: string) => void;
  onPreviewReady: (artifactId: string) => void;
}) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<ArtifactImageGesture | null>(null);

  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    setIsGesturing(false);
    pointersRef.current.clear();
    gestureRef.current = null;
  }, [artifact.id]);

  const clampTranslate = (next: { x: number; y: number }, nextScale: number) => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!bounds) return next;
    const maxX = (bounds.width * (nextScale - 1)) / 2;
    const maxY = (bounds.height * (nextScale - 1)) / 2;
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  };

  const applyScale = (rawScale: number) => {
    const nextScale = Math.min(
      ARTIFACT_IMAGE_MAX_SCALE,
      Math.max(ARTIFACT_IMAGE_MIN_SCALE, rawScale),
    );
    setScale(nextScale);
    setTranslate((current) =>
      nextScale === 1 ? { x: 0, y: 0 } : clampTranslate(current, nextScale),
    );
  };

  const pointerDistance = () => {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      gestureRef.current = {
        mode: "pinch",
        startDistance: pointerDistance(),
        startScale: scale,
      };
      setIsGesturing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
      return;
    }
    if (pointersRef.current.size === 1 && scale > 1) {
      gestureRef.current = {
        mode: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTranslateX: translate.x,
        startTranslateY: translate.y,
      };
      setIsGesturing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.mode === "pinch" && pointersRef.current.size >= 2) {
      if (gesture.startDistance > 0) {
        applyScale((gesture.startScale * pointerDistance()) / gesture.startDistance);
      }
      event.stopPropagation();
      return;
    }
    if (gesture.mode === "pan" && gesture.pointerId === event.pointerId) {
      setTranslate(
        clampTranslate(
          {
            x: gesture.startTranslateX + (event.clientX - gesture.startX),
            y: gesture.startTranslateY + (event.clientY - gesture.startY),
          },
          scale,
        ),
      );
      event.stopPropagation();
    }
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const wasGesturing = gestureRef.current !== null;
    pointersRef.current.delete(event.pointerId);
    if (gestureRef.current?.mode === "pinch" && pointersRef.current.size < 2) {
      const remaining = [...pointersRef.current.entries()][0];
      gestureRef.current =
        remaining && scale > 1
          ? {
              mode: "pan",
              pointerId: remaining[0],
              startX: remaining[1].x,
              startY: remaining[1].y,
              startTranslateX: translate.x,
              startTranslateY: translate.y,
            }
          : null;
    }
    if (pointersRef.current.size === 0) {
      gestureRef.current = null;
      setIsGesturing(false);
    }
    if (wasGesturing) event.stopPropagation();
  };

  return (
    <>
      <div
        ref={wrapperRef}
        className="flex h-full w-full items-center justify-center overflow-hidden [touch-action:none]"
        onClick={(event) => {
          if (scale > 1) event.stopPropagation();
        }}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
      >
        <img
          alt={artifact.name}
          className={`max-h-full max-w-full object-contain ${previewState === "ready" ? "opacity-100" : "opacity-0"} ${scale > 1 ? "cursor-grab" : ""}`}
          draggable={false}
          onError={() => onPreviewError(artifact.id)}
          onLoad={() => onPreviewReady(artifact.id)}
          src={artifactHref}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transition: isGesturing ? "none" : "transform 150ms ease-out",
          }}
        />
      </div>
      <div
        className="absolute bottom-3 right-3 z-10 flex flex-col gap-1"
        data-artifact-lightbox-interactive
      >
        <button
          aria-label="Zoom in"
          className={overlayButtonClass()}
          disabled={scale >= ARTIFACT_IMAGE_MAX_SCALE}
          onClick={() => applyScale(scale * ARTIFACT_IMAGE_ZOOM_STEP)}
          type="button"
        >
          <ArtifactZoomInIcon />
        </button>
        <button
          aria-label="Zoom out"
          className={overlayButtonClass()}
          disabled={scale <= ARTIFACT_IMAGE_MIN_SCALE}
          onClick={() => applyScale(scale / ARTIFACT_IMAGE_ZOOM_STEP)}
          type="button"
        >
          <ArtifactZoomOutIcon />
        </button>
        <button
          aria-label="Reset zoom"
          className={overlayButtonClass()}
          disabled={scale === ARTIFACT_IMAGE_MIN_SCALE}
          onClick={() => applyScale(1)}
          type="button"
        >
          <ArtifactZoomResetIcon />
        </button>
      </div>
    </>
  );
}

function ArtifactLightbox({
  artifact,
  artifactHref,
  previewState,
  canGoPrevious,
  canGoNext,
  onClose,
  onPrevious,
  onNext,
  onPreviewError,
  onPreviewReady,
}: {
  artifact: SessionArtifact | null;
  artifactHref: string | null;
  previewState: ArtifactPreviewState;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onPreviewError: (artifactId: string) => void;
  onPreviewReady: (artifactId: string) => void;
}) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textPreviewState, setTextPreviewState] = useState<TextArtifactPreviewState>("loading");
  const [copyState, setCopyState] = useState<keyof typeof COPY_TEXT_LABELS>("idle");
  const swipeStartRef = useRef<ArtifactSwipeStart | null>(null);
  const suppressNextPreviewClickRef = useRef(false);

  useEffect(() => {
    setTextContent(null);
    setTextPreviewState("loading");
    setCopyState("idle");

    if (!artifact || !artifactHref || artifact.kind !== "text") {
      return;
    }

    if (artifact.size > TEXT_ARTIFACT_MAX_BYTES) {
      setTextPreviewState("oversize");
      onPreviewReady(artifact.id);
      return;
    }

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(artifactHref, { signal: controller.signal });
        if (!response.ok) {
          throw new Error("Failed to load artifact");
        }
        const text = await response.text();
        if (controller.signal.aborted) {
          return;
        }
        setTextContent(text);
        setTextPreviewState("ready");
        onPreviewReady(artifact.id);
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        setTextPreviewState("error");
        onPreviewError(artifact.id);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [artifact?.id, artifact?.kind, artifact?.size, artifactHref]);

  if (!artifact || !artifactHref) return null;

  const previewStatusMessage =
    artifact.kind === "text"
      ? textPreviewState === "loading"
        ? "Loading preview"
        : textPreviewState === "error"
          ? "Preview unavailable"
          : null
      : artifact.kind === "image" || artifact.kind === "video"
        ? previewState !== "ready"
          ? previewState === "error"
            ? "Preview unavailable"
            : "Loading preview"
          : null
        : null;

  const handleCopyText = async () => {
    if (!textContent || copyState === "copying") return;
    setCopyState("copying");
    try {
      await copyTextToClipboard(textContent);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const finishSwipe = (pointerId: number, x: number, y: number) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;

    if (!start || start.pointerId !== pointerId) return;

    const deltaX = x - start.x;
    const deltaY = y - start.y;
    if (
      Math.abs(deltaX) < ARTIFACT_LIGHTBOX_SWIPE_THRESHOLD_PX ||
      Math.abs(deltaX) <= Math.abs(deltaY)
    ) {
      return;
    }

    suppressNextPreviewClickRef.current = true;
    if (deltaX < 0) {
      onNext();
      return;
    }
    onPrevious();
  };

  const handlePreviewClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();

    if (suppressNextPreviewClickRef.current) {
      suppressNextPreviewClickRef.current = false;
      return;
    }

    if (isArtifactLightboxInteractiveTarget(event.target) || hasActiveTextSelection()) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const isLeftHalf = event.clientX < bounds.left + bounds.width / 2;
    if (isLeftHalf) {
      onPrevious();
      return;
    }
    onNext();
  };

  const handlePreviewPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button > 0 || isArtifactLightboxInteractiveTarget(event.target)) {
      swipeStartRef.current = null;
      return;
    }

    swipeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const handlePreviewPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    finishSwipe(event.pointerId, event.clientX, event.clientY);
  };

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
            <h2 className="truncate font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
              {artifact.name}
            </h2>
            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {formatBytes(artifact.size)} · {artifact.kind} ·{" "}
              {formatRelativeTime(artifact.updatedAt)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {artifact.kind === "text" && textPreviewState === "ready" && textContent ? (
              <button
                aria-label={`Copy ${artifact.name}`}
                className="inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                disabled={copyState === "copying"}
                onClick={() => void handleCopyText()}
                type="button"
              >
                <CopyIcon />
                {COPY_TEXT_LABELS[copyState]}
              </button>
            ) : null}
            <a
              aria-label={`Download ${artifact.name}`}
              className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
              download={artifact.name}
              href={artifactHref}
            >
              <ArtifactDownloadIcon />
            </a>
            <IconCloseButton label="Close artifact preview" onClick={onClose} />
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 sm:gap-3">
          <button
            aria-label="Previous artifact"
            className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGoPrevious}
            onClick={onPrevious}
            type="button"
          >
            <ArtifactPreviousIcon />
          </button>
          <div
            aria-label="Artifact preview surface"
            className="relative flex h-full min-h-0 min-w-0 items-center justify-center self-stretch overflow-auto border border-[var(--color-border-default)] bg-[var(--color-terminal-bg)] p-3 [touch-action:pan-y] sm:p-4"
            onClick={handlePreviewClick}
            onPointerCancel={() => {
              swipeStartRef.current = null;
            }}
            onPointerDown={handlePreviewPointerDown}
            onPointerUp={handlePreviewPointerUp}
          >
            {previewStatusMessage ? (
              <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                {previewStatusMessage}
              </div>
            ) : null}
            {artifact.kind === "image" ? (
              <ArtifactImageViewer
                artifact={artifact}
                artifactHref={artifactHref}
                onPreviewError={onPreviewError}
                onPreviewReady={onPreviewReady}
                previewState={previewState}
              />
            ) : artifact.kind === "video" ? (
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
            ) : artifact.kind === "text" ? (
              <>
                {textPreviewState === "oversize" ? (
                  <div className="px-4 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    File exceeds 1 MiB preview limit. Download to view the full content.
                  </div>
                ) : null}
                {textPreviewState === "ready" && textContent ? (
                  <pre className="h-full w-full self-stretch overflow-auto whitespace-pre-wrap break-words font-mono text-[var(--color-text-primary)]">
                    {textContent}
                  </pre>
                ) : null}
              </>
            ) : (
              <div className="flex max-w-md flex-col items-center gap-4 text-center text-[var(--color-text-secondary)]">
                <div className="flex h-16 w-16 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-primary)]">
                  <ArtifactFileIcon />
                </div>
                <div
                  className={`max-w-full font-mono text-[var(--color-text-primary)] ${HARD_WRAP_TEXT_CLASS}`}
                >
                  {artifact.name}
                </div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  {artifactExtension(artifact.name)} · {artifact.mimeType}
                </div>
                <a
                  className="inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
                  download={artifact.name}
                  href={artifactHref}
                >
                  <ArtifactDownloadIcon />
                  Download File
                </a>
              </div>
            )}
          </div>
          <button
            aria-label="Next artifact"
            className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGoNext}
            onClick={onNext}
            type="button"
          >
            <ArtifactNextIcon />
          </button>
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

function readLogDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readLogAttachments(details: Record<string, unknown> | undefined): Array<{
  id: string;
  name: string;
}> {
  const value = details?.["attachments"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      "name" in item &&
      typeof item.id === "string" &&
      typeof item.name === "string"
    ) {
      return [{ id: item.id, name: item.name }];
    }
    return [];
  });
}

function formatLogEventLabel(event: string): string {
  return event.replaceAll(".", " ").replaceAll("_", " ");
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
  const inputKind = readLogDetail(entry.details, "inputKind");
  const inputText = readLogDetail(entry.details, "text") ?? entry.message ?? "";
  const inputAttachments = readLogAttachments(entry.details);
  const isStateTransition =
    entry.event === "session.state.transition" && Boolean(fromState) && Boolean(toState);
  const isUserInput = entry.event === "session.input.received";
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
      ) : isUserInput ? (
        <div className="px-3 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            <span className="border border-[var(--color-status-working)] px-2 py-0.5 text-[var(--color-status-working)]">
              User input
            </span>
            {inputKind ? (
              <span className="border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-text-secondary)]">
                {formatLogEventLabel(inputKind)}
              </span>
            ) : null}
          </div>
          {inputText ? (
            <pre className="whitespace-pre-wrap break-words border-l-2 border-[var(--color-status-working)] pl-3 font-mono text-[11px] leading-5 text-[var(--color-text-primary)]">
              {inputText}
            </pre>
          ) : null}
          {inputAttachments.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {inputAttachments.map((attachment) => (
                <span
                  className="border border-[var(--color-border-default)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]"
                  key={attachment.id}
                >
                  Attachment {attachment.name}
                </span>
              ))}
            </div>
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

function isSidecarPortConflict(value: unknown): value is SpurSidecarPortConflict {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<SpurSidecarPortConflict>;
  return (
    payload.code === "sidecar_port_busy" &&
    typeof payload.sidecarName === "string" &&
    Array.isArray(payload.candidates)
  );
}

async function readSidecarPortConflict(
  response: Response,
): Promise<SpurSidecarPortConflict | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    const payload = JSON.parse(text) as unknown;
    return isSidecarPortConflict(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function SessionDetail({ sessionId, projectId }: SessionDetailProps) {
  const router = useRouter();
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [openPrAction, setOpenPrAction] = useState<{
    action: "complete" | "kill";
    body?: Record<string, unknown>;
    payload: OpenPrActionRequiredPayload;
  } | null>(null);
  const [prCheckUnavailable, setPrCheckUnavailable] = useState<{
    action: "complete" | "kill";
    body?: Record<string, unknown>;
    payload: GithubPrCheckUnavailablePayload;
  } | null>(null);
  const [recoverPayload, setRecoverPayload] = useState<SessionNotRestorablePayload | null>(null);
  const sendingRef = useRef(false);
  const [sidecarPortConflict, setSidecarPortConflict] = useState<SpurSidecarPortConflict | null>(
    null,
  );
  const [selectedClearPort, setSelectedClearPort] = useState<number | null>(null);
  const messageHistory = useInputHistory(SESSION_MESSAGE_HISTORY_STORAGE_KEY);
  const voice = useVoiceInput({
    contextKey: `session:${sessionId}`,
    onTranscribed: (text) =>
      setMessage((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const [locationSearch, setLocationSearch] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [respawnOpen, setRespawnOpen] = useState(false);
  const [respawnPrompt, setRespawnPrompt] = useState("");
  const [respawnAgent, setRespawnAgent] = useState<AgentName | null>(null);
  const [respawnModel, setRespawnModel] = useState<string | null>(null);
  const [respawnAttachments, setRespawnAttachments] = useState<FileAttachment[]>([]);
  const [respawnStartupAttachmentIds, setRespawnStartupAttachmentIds] = useState<string[]>([]);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffNotes, setHandoffNotes] = useState("");
  const [handoffAgent, setHandoffAgent] = useState<AgentName | null>(null);
  const [handoffModel, setHandoffModel] = useState<string | null>(null);
  const [deskSpawnOpen, setDeskSpawnOpen] = useState(false);
  const [deskSpawnPrompt, setDeskSpawnPrompt] = useState("");
  const [deskSpawnAgent, setDeskSpawnAgent] = useState<AgentName>("claude");
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
    contextKey: `desk-spawn:${sessionId}`,
    onTranscribed: (text) =>
      setDeskSpawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const respawningRef = useRef(false);
  const respawnPromptRef = useRef<HTMLTextAreaElement>(null);
  const respawnHistory = useInputHistory(RESPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const respawnVoice = useVoiceInput({
    contextKey: `respawn:${sessionId}`,
    onTranscribed: (text) =>
      setRespawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const handoffNotesRef = useRef<HTMLTextAreaElement>(null);
  const handoffVoice = useVoiceInput({
    contextKey: `handoff:${sessionId}`,
    onTranscribed: (text) =>
      setHandoffNotes((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const [conversation, setConversation] = useState<ConversationResponse | null>(null);
  const [artifactPreviewStates, setArtifactPreviewStates] = useState<
    Record<string, ArtifactPreviewState>
  >({});
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactCategory, setArtifactCategory] = useState<ArtifactCategory>("agent");
  const { toasts, showSuccessToast, showErrorToast, dismissToast } = useToasts();
  const [showAllDeskMembers, setShowAllDeskMembers] = useState(false);
  const sessionRef = useRef<DashboardSession | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;
  const loadRequestIdRef = useRef(0);
  const lastLoadErrorToastRef = useRef<{ id: number; message: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastDialogTailRef = useRef<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const respawnModalPrLink = session?.links.find((link) => link.label === "pr");

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const dismissLoadErrorToast = useCallback(() => {
    const current = lastLoadErrorToastRef.current;
    if (!current) return;
    dismissToast(current.id);
    lastLoadErrorToastRef.current = null;
  }, [dismissToast]);

  useEffect(() => {
    setSession((current) => (current?.id === sessionId ? current : null));
    sessionRef.current = sessionRef.current?.id === sessionId ? sessionRef.current : null;
    setError(null);
    setConversation(null);
    dismissLoadErrorToast();
  }, [dismissLoadErrorToast, sessionId]);

  const loadSession = useCallback(async () => {
    const requestedSessionId = sessionId;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(requestedSessionId)}`, {
        cache: "no-store",
      });
      if (
        requestId !== loadRequestIdRef.current ||
        currentSessionIdRef.current !== requestedSessionId
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(await readApiError(response, "Failed to load session"));
      }
      const payload = (await response.json()) as SpurSessionView;
      if (
        requestId !== loadRequestIdRef.current ||
        currentSessionIdRef.current !== requestedSessionId
      ) {
        return;
      }
      const nextSession = toDashboardSession(payload);
      setSession(nextSession);
      setError(null);
      dismissLoadErrorToast();
    } catch (loadError) {
      if (
        requestId !== loadRequestIdRef.current ||
        currentSessionIdRef.current !== requestedSessionId
      ) {
        return;
      }
      const message = errorMessage(loadError, "Failed to load session");
      if (sessionRef.current?.id !== requestedSessionId) {
        setSession(null);
        setError(message);
        return;
      }
      if (lastLoadErrorToastRef.current?.message === message) return;
      dismissLoadErrorToast();
      const id = showErrorToast(message);
      lastLoadErrorToastRef.current = { id, message };
    }
  }, [dismissLoadErrorToast, sessionId, showErrorToast]);

  const tagCatalog = useTagCatalog();
  const applyTags = useCallback(
    async (targetSessionId: string, change: TagChange) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/tags`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(change),
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, "Failed to update tags"));
        }
        await loadSession();
      } catch (tagError) {
        showErrorToast(errorMessage(tagError, "Failed to update tags"));
      }
    },
    [loadSession, showErrorToast],
  );
  const tagsContextValue = useMemo(
    () => ({ catalog: tagCatalog, applyTags }),
    [tagCatalog, applyTags],
  );

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
    setShowAllDeskMembers(false);
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

  const handleAction = async (
    action: "send" | "pause" | "restore" | "complete" | "kill",
    body?: Record<string, unknown>,
    options: { skipKillConfirm?: boolean } = {},
  ) => {
    if (
      action === "kill" &&
      !options.skipKillConfirm &&
      !window.confirm(`Kill session ${sessionId}? This forces cleanup even with local changes.`)
    ) {
      return false;
    }

    setBusyAction(action);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        if (
          (action === "complete" || action === "kill") &&
          isOpenPrActionRequiredPayload(payload)
        ) {
          setOpenPrAction({ action, body, payload });
          return false;
        }
        if (
          (action === "complete" || action === "kill") &&
          isGithubPrCheckUnavailablePayload(payload)
        ) {
          setPrCheckUnavailable({ action, body, payload });
          return false;
        }
        if (action === "restore" && isSessionNotRestorablePayload(payload)) {
          setRecoverPayload(payload);
          setError(null);
          return false;
        }
        throw new Error(responseErrorMessage(payload, `Failed to ${action} session`));
      }
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
      return true;
    } catch (actionError) {
      showErrorToast(errorMessage(actionError, `Failed to ${action} session`));
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenPrAction = async (prAction: OpenPrAction) => {
    if (!openPrAction) return;
    const body = {
      ...(openPrAction.body ?? {}),
      prAction,
    };
    const completed = await handleAction(openPrAction.action, body, { skipKillConfirm: true });
    if (completed) {
      setOpenPrAction(null);
      setRecoverPayload(null);
    }
  };

  const handlePrCheckSkip = async () => {
    if (!prCheckUnavailable) return;
    const body = {
      ...(prCheckUnavailable.body ?? {}),
      skipPrCheck: true,
    };
    const done = await handleAction(prCheckUnavailable.action, body, { skipKillConfirm: true });
    if (done) {
      setPrCheckUnavailable(null);
    }
  };

  const handlePrCheckRetry = async () => {
    if (!prCheckUnavailable) return;
    const done = await handleAction(prCheckUnavailable.action, prCheckUnavailable.body, {
      skipKillConfirm: true,
    });
    if (done) {
      setPrCheckUnavailable(null);
    }
  };

  const handleRecoverForceKill = async () => {
    const ok = await handleAction("kill", { force: true }, { skipKillConfirm: true });
    if (ok) setRecoverPayload(null);
  };

  const handleRecoverRespawn = async () => {
    const ok = await handleAction("kill", { force: true }, { skipKillConfirm: true });
    if (!ok) return;
    setRecoverPayload(null);
    openRespawnEditor();
  };

  const handleRespawn = async () => {
    if (respawningRef.current) return;
    const submitRespawn = async (forceKillSource: boolean) => {
      const nextPrompt = respawnPrompt.trim();
      const payload: Record<string, unknown> = {
        prompt: nextPrompt,
        startupAttachmentIds: respawnStartupAttachmentIds,
      };
      const encodedAttachments = encodeFileAttachments(respawnAttachments);
      if (encodedAttachments.length > 0) payload.attachments = encodedAttachments;
      if (forceKillSource) payload.forceKillSource = true;
      if (session && respawnAgent && respawnAgent !== session.agent) payload.agent = respawnAgent;
      if (respawnModel !== null) payload.model = respawnModel;
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/respawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as SpurSessionView;
      respawnHistory.saveEntry(nextPrompt);
      setRespawnOpen(false);
      router.push(buildSessionPath(data.id, projectId));
    };

    respawningRef.current = true;
    setBusyAction("respawn");
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
      setBusyAction(null);
    }
  };

  const openHandoffEditor = useCallback(() => {
    if (!session) return;
    setHandoffNotes("");
    const defaultAgent =
      AGENT_OPTIONS.find((candidate) => candidate !== session.agent) ?? session.agent;
    setHandoffAgent(defaultAgent);
    setHandoffModel(null);
    setHandoffOpen(true);
  }, [session]);

  const handleHandoff = async () => {
    if (!session || !handoffAgent) return;
    setBusyAction("handoff");
    try {
      const payload: Record<string, unknown> = { agent: handoffAgent };
      if (handoffModel !== null) payload.model = handoffModel;
      const notes = handoffNotes.trim();
      if (notes) payload.notes = notes;
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Failed to hand off session"));
      }
      const data = (await response.json()) as SpurSessionView;
      setHandoffOpen(false);
      router.push(buildSessionPath(data.id, projectId));
    } catch (handoffError) {
      showErrorToast(errorMessage(handoffError, "Failed to hand off session"));
    } finally {
      setBusyAction(null);
    }
  };

  const openDeskSpawn = () => {
    if (!session) return;
    setDeskSpawnAgent(session.agent);
    setDeskSpawnPrompt("");
    setDeskSpawnBranch(session.branch ?? "");
    setDeskSpawnPlanMode(false);
    setDeskSpawnSteps([]);
    setDeskSpawnAttachments([]);
    setDeskSpawnOpen(true);
  };

  const handleDeskSpawn = async () => {
    if (!session || deskSpawningRef.current) return;
    const nextPrompt = deskSpawnPrompt.trim();
    const filteredSteps = deskSpawnSteps
      .map((step) => step.value.trim())
      .filter((step) => step.length > 0);
    const encodedAttachments = encodeFileAttachments(deskSpawnAttachments);
    deskSpawningRef.current = true;
    setDeskSpawning(true);
    try {
      const payload: Record<string, unknown> = {
        projectId: session.projectId,
        prompt: nextPrompt,
        agent: deskSpawnAgent,
        reuseWorkspaceSessionId: session.id,
        overrides: { worktree: session.worktree },
      };
      if (encodedAttachments.length > 0) payload.attachments = encodedAttachments;
      if (deskSpawnBranch.trim()) payload.branch = deskSpawnBranch.trim();
      if (deskSpawnPlanMode) payload.planMode = true;
      if (filteredSteps.length > 0) payload.steps = filteredSteps;

      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Failed to spawn desk agent"));
      }
      const created = (await response.json()) as SpurSessionView;
      deskSpawnHistory.saveEntry(nextPrompt);
      setDeskSpawnOpen(false);
      router.push(buildSessionPath(created.id, projectId));
    } catch (deskError) {
      showErrorToast(errorMessage(deskError, "Failed to spawn desk agent"));
    } finally {
      deskSpawningRef.current = false;
      setDeskSpawning(false);
    }
  };

  const handleSidecarAction = async (
    sidecarName: string,
    action: "start" | "stop",
    clearPort?: number,
  ) => {
    setBusyAction(`sidecar:${action}:${sidecarName}`);
    try {
      const init: RequestInit =
        clearPort === undefined
          ? { method: "POST" }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ clearPort }),
            };
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/sidecars/${encodeURIComponent(sidecarName)}/${action}`,
        init,
      );
      if (!response.ok) {
        if (action === "start" && response.status === 409) {
          const conflict = await readSidecarPortConflict(response.clone());
          if (conflict) {
            setSidecarPortConflict(conflict);
            setSelectedClearPort(conflict.candidates[0]?.port ?? null);
            return;
          }
        }
        throw new Error(await readApiError(response, `Failed to ${action} sidecar ${sidecarName}`));
      }
      const payload = (await response.json()) as SpurSessionView;
      setSession(toDashboardSession(payload));
      setSidecarPortConflict(null);
      setSelectedClearPort(null);
    } catch (sidecarError) {
      showErrorToast(errorMessage(sidecarError, `Failed to ${action} sidecar ${sidecarName}`));
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

  const addFiles = (files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((entries) => setAttachments((prev) => [...prev, ...entries]))
      .catch(() => {});
  };

  const addRespawnFiles = (files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((entries) => setRespawnAttachments((prev) => [...prev, ...entries]))
      .catch(() => {});
  };

  const addDeskSpawnFiles = (files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((entries) => setDeskSpawnAttachments((prev) => [...prev, ...entries]))
      .catch(() => {});
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

  const doSend = async (options?: { queue?: boolean; interrupt?: boolean }) => {
    const trimmed = message.trim();
    if (busyAction !== null || (!trimmed && attachments.length === 0)) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      const encoded = encodeFileAttachments(attachments);
      const body: Record<string, unknown> = { message: trimmed };
      if (encoded.length > 0) body.attachments = encoded;
      if (options?.queue !== undefined) body.queue = options.queue;
      if (options?.interrupt !== undefined) body.interrupt = options.interrupt;
      await handleAction("send", body);
    } finally {
      sendingRef.current = false;
    }
  };

  const title = useMemo(
    () => (session ? getSessionTitle(session) : sessionId),
    [session, sessionId],
  );

  useEffect(() => {
    if (session || error) {
      document.title = title;
    }
  }, [error, session, title]);

  const promptView = useMemo(() => (session ? parseSessionPromptView(session) : null), [session]);

  const displayState = useMemo(() => {
    if (!session) return undefined;
    if (session.state === "error" || session.state === "killed" || session.state === "stopped") {
      return session.state;
    }
    if (session.agent === "claude" && conversation?.state === "working") return "working";
    return session.state;
  }, [conversation?.state, session]);
  const wakeSummary = session ? getWakeSummary(session) : null;
  const wakeDueAt = wakeSummary?.dueAt;
  const [wakeNowMs, setWakeNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!wakeDueAt) return undefined;
    const timer = window.setInterval(() => setWakeNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [wakeDueAt]);
  const wakeCountdown = wakeSummary ? formatWakeCountdown(wakeSummary.dueAt, wakeNowMs) : null;
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
  const allArtifacts = session?.artifacts ?? [];
  const selectedArtifactIndex = selectedArtifactId
    ? allArtifacts.findIndex((artifact) => artifact.id === selectedArtifactId)
    : -1;
  const selectedArtifact =
    selectedArtifactIndex >= 0 ? (allArtifacts[selectedArtifactIndex] ?? null) : null;
  const selectedArtifactHref =
    session && selectedArtifact ? artifactUrl(session.id, selectedArtifact.id) : null;
  const canSelectPreviousArtifact = selectedArtifactIndex > 0;
  const canSelectNextArtifact =
    selectedArtifactIndex >= 0 && selectedArtifactIndex < allArtifacts.length - 1;
  const selectArtifactOffset = useCallback(
    (offset: -1 | 1) => {
      setSelectedArtifactId((currentId) => {
        const currentIndex = allArtifacts.findIndex((artifact) => artifact.id === currentId);
        if (currentIndex < 0) return currentId;
        return allArtifacts[currentIndex + offset]?.id ?? currentId;
      });
    },
    [allArtifacts],
  );
  const selectPreviousArtifact = useCallback(
    () => selectArtifactOffset(-1),
    [selectArtifactOffset],
  );
  const selectNextArtifact = useCallback(() => selectArtifactOffset(1), [selectArtifactOffset]);
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
  const { surfacedLinks, visibleLinks } = splitSessionLinks(
    session?.links ?? [],
    sidecarLinkLabels,
  );
  const workspaceAccessItems = session?.workspaceAccess?.items ?? [];

  useEffect(() => {
    if (!selectedArtifactId || !session) return;
    if (!allArtifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(null);
    }
  }, [allArtifacts, selectedArtifactId, session]);

  useEffect(() => {
    if (!selectedArtifactId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedArtifactId(null);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectPreviousArtifact();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectNextArtifact();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectNextArtifact, selectPreviousArtifact, selectedArtifactId]);

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

  const canUseDeskCheckout = Boolean(session?.workspaceExists && session.worktreePath.trim());
  const deskMembers = useMemo(() => {
    const members = (session?.deskGroupMembers ?? []).filter(
      (member) => member.status !== "killed",
    );
    const visible = showAllDeskMembers
      ? members
      : members.filter((member) => member.status !== "completed");
    return {
      visible,
      hiddenCompletedCount: members.filter((member) => member.status === "completed").length,
      total: members.length,
    };
  }, [session?.deskGroupMembers, showAllDeskMembers]);
  const openRespawnEditor = useCallback(() => {
    if (!session) return;
    setRespawnPrompt(session.prompt);
    setRespawnStartupAttachmentIds(session.startupAttachmentIds ?? []);
    setRespawnAttachments([]);
    setRespawnAgent(session.agent);
    setRespawnModel(session.model ?? null);
    setRespawnOpen(true);
  }, [session]);

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

  const copyLabeledValue = useCallback(
    async (label: string, value: string) => {
      try {
        await copyTextToClipboard(value);
        showSuccessToast(`${label} copied`, value.length > 96 ? `${value.slice(0, 96)}...` : value);
      } catch (copyError) {
        showErrorToast(
          `Couldn't copy ${label}`,
          errorMessage(copyError, "Clipboard is unavailable."),
        );
      }
    },
    [showErrorToast, showSuccessToast],
  );

  const conflictClearPort = selectedClearPort ?? sidecarPortConflict?.candidates[0]?.port ?? null;
  const isClearingConflictPort =
    sidecarPortConflict !== null &&
    busyAction === `sidecar:start:${sidecarPortConflict.sidecarName}`;

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-4 sm:px-5 lg:px-6">
      <Link
        className="inline-flex items-center gap-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildDashboardPath(projectId)}
      >
        ← Back
      </Link>

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

            <h1 className="mt-2 min-w-0 text-xl font-bold tracking-[-0.02em] text-[var(--color-text-primary)] uppercase sm:text-2xl">
              {title}
            </h1>
            {promptView &&
            (promptView.task || promptView.handoff || promptView.selfDestructLabel) ? (
              <div className="mt-3 w-full space-y-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
                {promptView.task ? (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                        Task
                      </div>
                      <PromptSectionCopyButton
                        label="Task"
                        value={promptView.task}
                        onCopy={copyLabeledValue}
                      />
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[var(--color-text-secondary)]">
                      {promptView.task}
                    </p>
                  </div>
                ) : null}
                {promptView.handoff ? (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                        Handoff
                      </div>
                      <PromptSectionCopyButton
                        label="Handoff"
                        value={[
                          `From ${promptView.handoff.sourceAgent} · ${promptView.handoff.sourceSessionId}`,
                          promptView.handoff.notes,
                        ]
                          .filter(Boolean)
                          .join("\n\n")}
                        onCopy={copyLabeledValue}
                      />
                    </div>
                    <p className="mt-1 text-[var(--color-text-secondary)]">
                      From {promptView.handoff.sourceAgent} · {promptView.handoff.sourceSessionId}
                    </p>
                    {promptView.handoff.notes ? (
                      <p className="mt-1 whitespace-pre-wrap text-[var(--color-text-secondary)]">
                        {promptView.handoff.notes}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {promptView.selfDestructLabel ? (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                        Self-destruct
                      </div>
                      <PromptSectionCopyButton
                        label="Self-destruct"
                        value={`Complete this session when ${promptView.selfDestructLabel}.`}
                        onCopy={copyLabeledValue}
                      />
                    </div>
                    <p className="mt-1 text-[var(--color-text-secondary)]">
                      Complete this session when {promptView.selfDestructLabel}.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {deskMembers.total > 1 ? (
              <nav
                aria-label="Checkout group"
                className="mt-3 flex flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] pb-2"
              >
                {deskMembers.visible.map((m) => {
                  const selected = m.id === session.id;
                  return (
                    <Link
                      key={m.id}
                      aria-current={selected ? "page" : undefined}
                      aria-label={`${m.agent} ${m.id}`}
                      className={`inline-flex items-center gap-1 border-b-2 px-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-[0.1em] transition ${
                        selected
                          ? "border-[var(--color-accent)] text-[var(--color-text-primary)]"
                          : "border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                      }`}
                      href={buildSessionPath(m.id, projectId)}
                    >
                      <span title={`${m.state}${m.runtimeAlive ? "" : " offline"}`}>
                        <ActivityDot activity={m.state} dotOnly />
                      </span>
                      <span>
                        {m.agent} · {truncateMiddle(m.id, 18)}
                      </span>
                    </Link>
                  );
                })}
                {deskMembers.hiddenCompletedCount > 0 ? (
                  <button
                    type="button"
                    aria-expanded={showAllDeskMembers}
                    aria-label={
                      showAllDeskMembers
                        ? "Hide completed desk agents"
                        : "Show completed desk agents"
                    }
                    className="border-b-2 border-transparent px-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                    onClick={() => setShowAllDeskMembers((current) => !current)}
                  >
                    ...
                  </button>
                ) : null}
              </nav>
            ) : null}

            <TagsContext.Provider value={tagsContextValue}>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {displayState ? <ActivityDot activity={displayState} /> : null}
                {session.branch ? (
                  <span className="border border-[var(--color-border-default)] px-2 py-0.5 font-mono text-[var(--color-text-secondary)]">
                    {session.branch}
                  </span>
                ) : null}
                {wakeSummary ? (
                  <span
                    className="inline-flex items-center gap-1.5 border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-status-attention)]"
                    title={
                      wakeSummary.kind === "interval"
                        ? "Interval wake scheduled"
                        : wakeSummary.kind === "daily"
                          ? "Daily wake scheduled"
                          : "Wake scheduled"
                    }
                  >
                    <WakeIcon recurring={wakeSummary.kind !== "one-shot"} />
                    <span>{wakeSummary.label.toLowerCase()}</span>
                    <span className="font-mono text-[var(--color-text-primary)]">
                      {wakeCountdown}
                    </span>
                    {wakeSummary.intervalMs ? (
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                        every {formatIntervalDuration(wakeSummary.intervalMs)}
                      </span>
                    ) : null}
                    {wakeSummary.dailyAt ? (
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                        daily {wakeSummary.dailyAt.join(", ")}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {surfacedLinks.map((link) => (
                  <SessionLinkBadge key={`${link.label}-${link.url}`} link={link} />
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
                <TagEditor session={session} variant="chips" />
              </div>
            </TagsContext.Provider>
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
            {session ? (
              <button
                type="button"
                disabled={busyAction !== null || deskSpawning || !canUseDeskCheckout}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                onClick={openDeskSpawn}
                title={
                  canUseDeskCheckout
                    ? "Opens a second agent in this checkout directory with the same branch"
                    : "No reusable checkout is available"
                }
              >
                Desk agent
              </button>
            ) : null}
            {canHandoff(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                onClick={openHandoffEditor}
                title="Pass this task to another agent in the same workspace"
              >
                {busyAction === "handoff" ? "Handing off..." : "Handoff"}
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
            {canRecover(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => setRecoverPayload(buildLocalRecoverPayload(session))}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              >
                Recover
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
                        className={`min-w-0 max-w-[85%] px-3 py-2 ${
                          msg.role === "user"
                            ? "ml-auto border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]"
                            : msg.pending
                              ? "mr-auto border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-text-tertiary)]"
                              : "mr-auto border border-[var(--color-border-default)] text-[var(--color-text-secondary)]"
                        }`}
                      >
                        {msg.pending ? (
                          <div className={`${HARD_WRAP_TEXT_CLASS} animate-pulse tracking-[0.3em]`}>
                            {msg.text}
                          </div>
                        ) : (
                          <MarkdownMessage
                            text={msg.text.length > 500 ? `${msg.text.slice(0, 500)}...` : msg.text}
                          />
                        )}
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
                            className={`mt-1 ${HARD_WRAP_TEXT_CLASS} text-[var(--color-text-secondary)]`}
                          >
                            {queuedMessage}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {session.queuedMessages.awaitingPrompt ? (
                    <p className="mt-2 text-[var(--color-text-secondary)]">
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
                    <FileAttachmentTextarea
                      attachments={attachments}
                      clearLabel="Clear message"
                      minHeightClass="min-h-24"
                      onAddFiles={addFiles}
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
                    {voice.voiceError ? (
                      <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-[var(--color-chip-error-text)]">
                        {voice.voiceError}
                      </div>
                    ) : null}
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
                          className="inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                        >
                          {busyAction === "send" ? (
                            <Spinner className="h-3 w-3" strokeWidth={1.5} />
                          ) : null}
                          <span>{busyAction === "send" ? "Queueing..." : "Queue"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={
                            busyAction !== null || (!message.trim() && attachments.length === 0)
                          }
                          onClick={() => void doSend({ queue: false, interrupt: true })}
                          className="inline-flex items-center gap-2 bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                        >
                          {busyAction === "send" ? (
                            <Spinner className="h-3 w-3" strokeWidth={1.5} />
                          ) : null}
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
                            onPreview={setSelectedArtifactId}
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
                            variant={
                              artifactCategory === "attached" && artifact.kind === "image"
                                ? "attachedImage"
                                : "compact"
                            }
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
                  ...(wakeSummary && wakeCountdown
                    ? ([
                        ["Wake", wakeSummary.label],
                        ["Next wake", wakeCountdown],
                      ] as Array<[string, string]>)
                    : []),
                  ...(wakeSummary?.intervalMs
                    ? ([["Wake interval", formatIntervalDuration(wakeSummary.intervalMs)]] as Array<
                        [string, string]
                      >)
                    : []),
                  ...(wakeSummary?.dailyAt
                    ? ([["Wake daily at", wakeSummary.dailyAt.join(", ")]] as Array<
                        [string, string]
                      >)
                    : []),
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

              {wakeSummary?.stopCondition ? (
                <div className="mt-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    Wake stop condition
                  </div>
                  <div className="mt-1 text-[var(--color-text-secondary)]">
                    {wakeSummary.stopCondition}
                  </div>
                </div>
              ) : null}

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
                              onClick={() => void copyLabeledValue(item.label, item.value)}
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
                        className="border-b border-[var(--color-border-subtle)] py-1.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                            <span
                              className={`inline-block h-2 w-2 shrink-0 rounded-full ${sc.alive ? "bg-[var(--color-chip-alive)]" : "bg-[var(--color-text-tertiary)]"}`}
                              data-testid={`sidecar-status-${sc.name}`}
                            />
                            <span className="min-w-0 break-all text-[var(--color-text-secondary)]">
                              {sc.name}
                            </span>
                            {sc.ports?.map((port) => (
                              <span
                                key={port.env}
                                className="shrink-0 text-[var(--color-text-tertiary)]"
                              >
                                :{port.port}
                              </span>
                            ))}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {sc.alive && canAttach ? (
                              <button
                                type="button"
                                className="border border-[var(--color-border-strong)] px-2 py-0.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
                                onClick={() => syncTerminalFilter(`${session.id}--${sc.name}`)}
                              >
                                Terminal
                              </button>
                            ) : null}
                            {sidecarOpenUrl ? (
                              <a
                                className="border border-[var(--color-border-strong)] px-2 py-0.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] hover:no-underline"
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
                              disabled={
                                busyAction === `sidecar:start:${sc.name}` ||
                                busyAction === `sidecar:stop:${sc.name}`
                              }
                              onClick={() =>
                                void handleSidecarAction(sc.name, sc.alive ? "stop" : "start")
                              }
                              type="button"
                            >
                              {sc.alive ? <StopSquareIcon className="h-3.5 w-3.5" /> : <PlayIcon />}
                            </button>
                          </div>
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
          {recoverPayload ? (
            <RecoverActionDialog
              busy={busyAction !== null}
              onCancel={() => setRecoverPayload(null)}
              onForceKill={() => void handleRecoverForceKill()}
              onRespawn={() => void handleRecoverRespawn()}
              payload={recoverPayload}
            />
          ) : null}
          {openPrAction ? (
            <OpenPrActionDialog
              busy={busyAction === openPrAction.action}
              onAction={(action) => void handleOpenPrAction(action)}
              onCancel={() => setOpenPrAction(null)}
              payload={openPrAction.payload}
            />
          ) : null}
          {prCheckUnavailable ? (
            <GithubRateLimitDialog
              busy={busyAction === prCheckUnavailable.action}
              onCancel={() => setPrCheckUnavailable(null)}
              onRetry={() => void handlePrCheckRetry()}
              onSkip={() => void handlePrCheckSkip()}
              payload={prCheckUnavailable.payload}
            />
          ) : null}
          {sidecarPortConflict ? (
            <div
              aria-labelledby="sidecar-port-conflict-title"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)] p-4"
              onClick={(event) => {
                if (event.target === event.currentTarget && busyAction === null) {
                  setSidecarPortConflict(null);
                  setSelectedClearPort(null);
                }
              }}
              role="dialog"
            >
              <div className="w-full max-w-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)]">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2
                      className="font-bold uppercase tracking-[0.1em] text-[var(--color-status-attention)]"
                      id="sidecar-port-conflict-title"
                    >
                      Port busy
                    </h2>
                    <p className="mt-2 leading-snug text-[var(--color-text-secondary)]">
                      Select a reserved port to clear, then start sidecar{" "}
                      <span className="text-[var(--color-text-primary)]">
                        {sidecarPortConflict.sidecarName}
                      </span>{" "}
                      on that port.
                    </p>
                  </div>
                  <button
                    aria-label="Close port conflict"
                    className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)] disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setSidecarPortConflict(null);
                      setSelectedClearPort(null);
                    }}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                      Port
                    </span>
                    <select
                      aria-label={`Busy port for sidecar ${sidecarPortConflict.sidecarName}`}
                      className={`${INPUT_CLASS} w-full`}
                      disabled={busyAction !== null}
                      onChange={(event) =>
                        setSelectedClearPort(Number.parseInt(event.target.value, 10))
                      }
                      value={conflictClearPort ?? ""}
                    >
                      {sidecarPortConflict.candidates.map((candidate) => (
                        <option
                          key={`${candidate.portId}:${candidate.port}`}
                          value={candidate.port}
                        >
                          {candidate.portId}:{candidate.port}
                          {candidate.owner ? ` — ${candidate.owner}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                      disabled={busyAction !== null}
                      onClick={() => {
                        setSidecarPortConflict(null);
                        setSelectedClearPort(null);
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                      disabled={busyAction !== null || conflictClearPort === null}
                      onClick={() => {
                        if (conflictClearPort !== null) {
                          void handleSidecarAction(
                            sidecarPortConflict.sidecarName,
                            "start",
                            conflictClearPort,
                          );
                        }
                      }}
                      type="button"
                    >
                      {isClearingConflictPort ? "Clearing..." : "Clear/Retry"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {handoffOpen && session && handoffAgent ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
              onClick={(event) => {
                if (event.target === event.currentTarget && busyAction !== "handoff") {
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
                  <h2 className="font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
                    Handoff
                  </h2>
                  <button
                    className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                    disabled={busyAction === "handoff"}
                    onClick={() => setHandoffOpen(false)}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
                {respawnModalPrLink ? (
                  <div
                    className="mb-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--color-text-secondary)]"
                    role="note"
                  >
                    This session links a PR ({respawnModalPrLink.url}). The handoff prompt asks the
                    new agent to re-check PR state and CI before closing out.
                  </div>
                ) : null}
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <div className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--color-text-secondary)]">
                    Spur builds the main handoff prompt from this session&apos;s task, links,
                    branch, and workspace. Add optional notes below.
                  </div>
                  <div className="flex gap-2">
                    <AgentSelect
                      ariaLabel="Handoff agent"
                      onChange={(next) => {
                        setHandoffAgent(next);
                        setHandoffModel(null);
                      }}
                      value={handoffAgent}
                    />
                    <div className="min-w-40 flex-1">
                      <ModelSelect
                        agent={handoffAgent}
                        ariaLabel="Handoff model"
                        onChange={setHandoffModel}
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
                    placeholder={voicePlaceholder(
                      "Optional notes for the next agent...",
                      handoffVoice,
                    )}
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
                        disabled={busyAction === "handoff"}
                        onClick={() => setHandoffOpen(false)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="inline-flex items-center gap-2 bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                        disabled={busyAction === "handoff"}
                        onClick={() => void handleHandoff()}
                        type="button"
                      >
                        {busyAction === "handoff" ? "Handing off..." : "Handoff"}
                        {busyAction !== "handoff" ? (
                          <span
                            aria-hidden="true"
                            className="ml-2 whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-inverse)]/70"
                          >
                            {PRIMARY_SUBMIT_HINT}
                          </span>
                        ) : null}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {respawnOpen && session && respawnAgent ? (
            <SpawnModal
              agent={respawnAgent}
              agentAriaLabel="Respawn agent"
              attachments={respawnAttachments}
              canClose={busyAction !== "respawn"}
              clearLabel="Clear respawn prompt"
              history={{ entries: respawnHistory.entries, onSelect: setRespawnPrompt }}
              mode={{
                kind: "respawn",
                model: { value: respawnModel, onChange: setRespawnModel },
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
                noteSlot: respawnModalPrLink ? (
                  <div
                    className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--color-text-secondary)]"
                    role="note"
                  >
                    <div>
                      This session links a PR ({respawnModalPrLink.url}). Respawn drops the replaced
                      worktree after success—confirm merges or updates first if needed.
                    </div>
                  </div>
                ) : null,
              }}
              onAddFiles={addRespawnFiles}
              onAgentChange={(next) => {
                setRespawnAgent(next);
                setRespawnModel(null);
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
              promptMinHeightClass="min-h-[24rem] sm:min-h-[28rem]"
              promptPlaceholder="Edit the initial message..."
              promptRef={respawnPromptRef}
              showCancel
              slashEndpoint={`/api/projects/${encodeURIComponent(session.projectId)}/slash-commands?agent=${encodeURIComponent(respawnAgent)}`}
              submitBusyLabel="Respawning..."
              submitDisabled={
                busyAction === "respawn" ||
                (!respawnPrompt.trim() &&
                  respawnStartupAttachmentIds.length === 0 &&
                  respawnAttachments.length === 0)
              }
              submitLabel="Respawn"
              submitting={busyAction === "respawn"}
              title="Edit & Respawn"
              voice={respawnVoice}
            />
          ) : null}
          {deskSpawnOpen && session ? (
            <SpawnModal
              agent={deskSpawnAgent}
              agentAriaLabel="Desk spawn agent"
              attachments={deskSpawnAttachments}
              canClose={!deskSpawning}
              clearLabel="Clear desk agent prompt"
              history={{ entries: deskSpawnHistory.entries, onSelect: setDeskSpawnPrompt }}
              mode={{
                kind: "desk",
                branch: { value: deskSpawnBranch, onChange: setDeskSpawnBranch },
                planMode: { value: deskSpawnPlanMode, onChange: setDeskSpawnPlanMode },
                steps: {
                  items: deskSpawnSteps,
                  onUpdate: updateDeskSpawnStep,
                  onAdd: addDeskSpawnStep,
                  onRemove: removeDeskSpawnStep,
                },
              }}
              onAddFiles={addDeskSpawnFiles}
              onAgentChange={setDeskSpawnAgent}
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
              promptMinHeightClass="min-h-[24rem] sm:min-h-[28rem]"
              promptPlaceholder="First message"
              promptRef={deskSpawnPromptRef}
              showCancel
              slashEndpoint={`/api/projects/${encodeURIComponent(session.projectId)}/slash-commands?agent=${encodeURIComponent(deskSpawnAgent)}`}
              submitBusyLabel="Spawning..."
              submitDisabled={deskSpawning}
              submitLabel="Spawn"
              submitting={deskSpawning}
              title="Desk agent"
              voice={deskSpawnVoice}
            />
          ) : null}
          <ArtifactLightbox
            artifact={selectedArtifact}
            artifactHref={selectedArtifactHref}
            canGoNext={canSelectNextArtifact}
            canGoPrevious={canSelectPreviousArtifact}
            onClose={() => setSelectedArtifactId(null)}
            onNext={selectNextArtifact}
            onPrevious={selectPreviousArtifact}
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
          <p className="mt-2 whitespace-pre-wrap break-words">{error}</p>
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
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </main>
  );
}
