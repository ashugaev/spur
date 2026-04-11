"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { VoiceButton, VoiceStatusHint } from "@/components/VoiceInput";
import { ActivityDot } from "@/components/ActivityDot";
import { TerminalModal } from "@/components/TerminalModal";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  getSessionSubtitle,
  getSessionTitle,
  truncateMiddle,
} from "@/lib/format";
import {
  CiStatusDot,
  ReviewCommentsBadge,
  extractLinkId,
  GithubIcon,
  JiraIcon,
  prStateColor,
  usePrInfo,
} from "@/lib/link-icons";
import {
  buildDashboardPath,
  buildSessionPath,
  getTerminalQuerySessionId,
  withTerminalQuery,
} from "@/lib/project-routes";
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

function LinkBadge({ link }: { link: { label: string; url: string } }) {
  const prUrl = link.label === "pr" ? link.url : undefined;
  const prInfo = usePrInfo(prUrl);
  const color = prStateColor(prInfo.state);

  return (
    <a
      className="inline-flex items-center gap-1 border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
      href={link.url}
      rel="noreferrer"
      target="_blank"
    >
      {link.label === "pr" ? <GithubIcon /> : <JiraIcon />}
      <span className="text-[10px]" style={color ? { color } : undefined}>
        {extractLinkId(link)}
      </span>
      {link.label === "pr" ? (
        <>
          <CiStatusDot status={prInfo.ciStatus} />
          <ReviewCommentsBadge total={prInfo.totalThreads} unresolved={prInfo.unresolvedThreads} />
        </>
      ) : null}
    </a>
  );
}

const POLL_INTERVAL_MS = 4_000;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Attachment {
  file: File;
  preview: string;
}

interface LogEntry {
  timestamp: string;
  event: string;
  level: string;
  message?: string;
  sessionId?: string;
}

interface DialogMessage {
  key: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

function formatLogTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
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

interface SessionDetailProps {
  sessionId: string;
  projectId?: string;
}

export function SessionDetail({ sessionId, projectId }: SessionDetailProps) {
  const router = useRouter();
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const voice = useVoiceInput({
    onTranscribed: (text) => setMessage((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const [locationSearch, setLocationSearch] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [conversation, setConversation] = useState<ConversationResponse | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastDialogTailRef = useRef<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as SpurSessionView;
      const nextSession = toDashboardSession(payload);
      setSession(nextSession);
      setError(null);
      document.title = `${nextSession.id} | Spur`;
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
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/respawn`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as SpurSessionView;
      router.push(buildSessionPath(data.id, projectId));
    } catch (respawnError) {
      setError(
        respawnError instanceof Error ? respawnError.message : "Failed to respawn session",
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
    if (!files) return;
    const images = Array.from(files).filter((f) => IMAGE_TYPES.has(f.type));
    if (images.length === 0) return;
    void Promise.all(images.map(async (f) => ({ file: f, preview: await fileToDataUrl(f) })))
      .then((entries) => setAttachments((prev) => [...prev, ...entries]))
      .catch(() => {});
  };

  const doSend = async () => {
    const trimmed = message.trim();
    if (!trimmed && attachments.length === 0) return;
    const encoded = attachments.map((att) => ({
      name: sanitizeFilename(att.file.name),
      data: att.preview.split(",")[1] ?? "",
    }));
    const body: Record<string, unknown> = { message: trimmed };
    if (encoded.length > 0) body.attachments = encoded;
    await handleAction("send", body);
  };

  const title = useMemo(
    () => (session ? getSessionTitle(session) : sessionId),
    [session, sessionId],
  );
  const subtitle = useMemo(() => (session ? getSessionSubtitle(session) : null), [session]);
  const displayState = useMemo(
    () =>
      session?.agent === "claude" && conversation?.state === "working" ? "working" : session?.state,
    [conversation?.state, session?.agent, session?.state],
  );
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
  const sidecarUiLink = useMemo(
    () => session?.links.find((link) => link.label === "sidecar-ui")?.url ?? null,
    [session],
  );

  const canAttach =
    session && session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);
  const isSessionTerminal = Boolean(
    session &&
      (requestedTerminalSessionId === session.id ||
        (requestedTerminalSessionId !== null &&
          requestedTerminalSessionId.startsWith(`${session.id}--`))),
  );
  const terminalOpen = Boolean(canAttach && isSessionTerminal);

  useEffect(() => {
    if (!requestedTerminalSessionId || !session || typeof window === "undefined") return;
    if (isSessionTerminal && canAttach) return;

    const query = withTerminalQuery(window.location.search, null);
    window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
    setLocationSearch(window.location.search);
  }, [canAttach, isSessionTerminal, requestedTerminalSessionId, session]);

  const syncTerminalFilter = (terminalSessionId: string | null) => {
    if (typeof window === "undefined") return;
    const query = withTerminalQuery(window.location.search, terminalSessionId);
    window.history.pushState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
    setLocationSearch(window.location.search);
  };

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-4 sm:px-5 lg:px-6">
      <a
        className="inline-flex items-center gap-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildDashboardPath(projectId)}
      >
        ← Back
      </a>

      {error || voice.voiceError ? (
        <div className="mt-3 border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-red-100">
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
                .filter((l) => l.label === "tracker" || l.label === "pr")
                .map((link) => (
                  <LinkBadge key={`${link.label}-${link.url}`} link={link} />
                ))}
              {!session.runtimeAlive && !isTerminalSession(session) ? (
                <span className="border border-red-500/30 px-2 py-0.5 text-red-200">offline</span>
              ) : null}
              {hasServiceProblems(session) ? (
                <span className="border border-orange-400/30 px-2 py-0.5 text-orange-200">
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
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-white/5 disabled:opacity-50"
              >
                {busyAction === "pause" ? "Pausing..." : "Pause"}
              </button>
            ) : null}
            {isRestorable(session) ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleAction("restore")}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-white/5 disabled:opacity-50"
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
                onClick={() => void handleRespawn()}
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-white/5 disabled:opacity-50"
              >
                {busyAction === "respawn" ? "Respawning..." : "Respawn"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void openLogs()}
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-white/5"
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
                        className={`max-w-[85%] px-3 py-2 text-sm ${
                          msg.role === "user"
                            ? "ml-auto border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]"
                            : msg.pending
                              ? "mr-auto border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-text-tertiary)]"
                              : "mr-auto border border-[var(--color-border-default)] text-[var(--color-text-secondary)]"
                        }`}
                      >
                        <div
                          className={`whitespace-pre-wrap break-words ${msg.pending ? "animate-pulse tracking-[0.3em]" : ""}`}
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

              {/* Message */}
              <section>
                <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  Message
                  <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                </h2>
                {canSendMessage(session) ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <textarea
                        className="min-h-24 w-full resize-y border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 pr-12 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                        onChange={(event) => setMessage(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            void doSend();
                          }
                        }}
                        onPaste={(e) => {
                          const files = e.clipboardData.files;
                          if (files.length > 0) {
                            e.preventDefault();
                            addImageFiles(files);
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          addImageFiles(e.dataTransfer.files);
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        placeholder="Message to the running agent..."
                        value={message}
                      />
                      <VoiceButton voice={voice} />
                    </div>
                    {attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {attachments.map((att, i) => (
                          <div key={`${att.file.name}-${i}`} className="group relative">
                            <img
                              src={att.preview}
                              alt={att.file.name}
                              className="h-12 w-12 border border-[var(--color-border-default)] object-cover"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setAttachments((prev) => prev.filter((_, j) => j !== i))
                              }
                              className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center bg-[var(--color-status-error)] text-[10px] text-white opacity-0 transition group-hover:opacity-100"
                            >
                              x
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        <VoiceStatusHint voice={voice} /> {!voice.voiceBusy && !voice.recording ? "⌘/Ctrl + Enter" : null}
                      </span>
                      <button
                        type="button"
                        disabled={
                          busyAction !== null || (!message.trim() && attachments.length === 0)
                        }
                        onClick={() => void doSend()}
                        className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                      >
                        {busyAction === "send" ? "Sending..." : "Send"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="py-2 text-[var(--color-text-secondary)]">
                    Not accepting input. Restore to continue.
                  </p>
                )}
              </section>

              {/* Links */}
              {session.links.length > 0 ? (
                <section>
                  <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Links
                    <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {session.links.map((link) => (
                      <a
                        key={`${session.id}-${link.label}-${link.url}`}
                        className="border border-[var(--color-border-default)] px-2.5 py-1 text-[var(--color-accent)] hover:no-underline"
                        href={link.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
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

              {session.error ? (
                <div className="mt-3 border border-red-500/30 bg-red-500/[0.08] px-2.5 py-2 text-red-100">
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
                  {session.sidecars.map((sc) => (
                    <div
                      key={sc.name}
                      className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${sc.alive ? "bg-green-400" : "bg-[var(--color-text-tertiary)]"}`}
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
                            className="border border-[var(--color-border-strong)] px-2 py-0.5 text-xs font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-white/5"
                            onClick={() => syncTerminalFilter(`${session.id}--${sc.name}`)}
                          >
                            Terminal
                          </button>
                        ) : null}
                        {sc.alive && sc.name === "isolated-ui" && sidecarUiLink ? (
                          <a
                            className="border border-[var(--color-border-strong)] px-2 py-0.5 text-xs font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-white/5 hover:no-underline"
                            href={sidecarUiLink}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))}
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
              <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-4 py-2">
                <span className="font-bold uppercase text-[var(--color-text-primary)]">
                  Logs — {session.id}
                </span>
                <button
                  type="button"
                  className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                  onClick={() => setLogsOpen(false)}
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[10px] leading-5">
                {logEntries.length === 0 ? (
                  <p className="text-[var(--color-text-tertiary)]">No log entries.</p>
                ) : (
                  logEntries.map((entry, i) => (
                    <div
                      key={`${entry.timestamp}-${i}`}
                      style={{
                        color: LOG_LEVEL_COLORS[entry.level] ?? "var(--color-text-secondary)",
                      }}
                    >
                      <span className="text-[var(--color-text-tertiary)]">
                        [{formatLogTime(entry.timestamp)}]
                      </span>{" "}
                      <span className="uppercase">{entry.event}</span>
                      {entry.message ? ` — ${entry.message}` : ""}
                    </div>
                  ))
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
        </>
      ) : (
        <p className="mt-5 text-[var(--color-text-secondary)]">Loading session...</p>
      )}
    </main>
  );
}
