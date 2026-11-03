"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { SendIcon } from "@/components/icons/SendIcon";
import { Spinner } from "@/components/icons/Spinner";
import { LoadingBar } from "@/components/LoadingBar";
import { formatRelativeTime } from "@/lib/format";
import {
  createSdkLoader,
  createSnippetHost,
  RELOADABLE_ERRORS,
  type PendingConfirm,
  type PanelRuntimeError,
  type SnippetFontBuffer,
  type SnippetHost,
  type SnippetHostDeps,
  type SnippetPort,
  type SnippetSessionUpdate,
} from "@/lib/snippets/snippet-host";
import type { SnippetManifest } from "@/lib/snippets/snippet-manifest";
import {
  isTerminalSnippetStatus,
  SNIPPET_CONFIRM_REASON_TEXT,
  SNIPPET_FONT_URLS,
  SNIPPET_RETRY_STATUSES,
  SNIPPET_THEME_TOKENS,
  snippetStatusLabel,
  type SnippetActionRecord,
  type SnippetTheme,
  type SnippetThemeToken,
} from "@/lib/snippets/snippet-protocol";
import { enterFullscreen, exitFullscreen, setInline } from "@/lib/snippets/snippet-dialog";
import type { SnippetStorage } from "@/lib/snippets/snippet-store";
import { buildSnippetSrcdoc, SNIPPET_FRAME_SANDBOX } from "@/lib/snippets/snippet-srcdoc";
import type { ConversationMessage } from "@/lib/types";

// ---------------------------------------------------------------------------
// page-level assets: SDK source and fonts are fetched once per page

const loadSdk = createSdkLoader(async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`sdk ${response.status}`);
  return response.text();
});

let fontCache: SnippetFontBuffer[] = [];
let fontsRequested = false;

function requestFonts(): void {
  if (fontsRequested) return;
  fontsRequested = true;
  for (const { url, weight } of Object.values(SNIPPET_FONT_URLS)) {
    void fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((data) => {
        if (data) fontCache = [...fontCache, { family: "Spur Mono", weight, data }];
      })
      .catch(() => undefined);
  }
}

// Fonts resolved at connect time only; ArrayBuffer copies leave the cache intact.
function currentFonts(): SnippetFontBuffer[] {
  return fontCache.map((font) => ({ ...font, data: font.data.slice(0) }));
}

function readTheme(): SnippetTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens = Object.fromEntries(
    SNIPPET_THEME_TOKENS.map((token) => [token, style.getPropertyValue(`--color-${token}`).trim()]),
  ) as Record<SnippetThemeToken, string>;
  return { mode: root.dataset.theme === "light" ? "light" : "dark", tokens };
}

// Storage that throws on every call: the gates fail closed when the browser
// denies localStorage.
const deny = (): never => {
  throw new Error("storage unavailable");
};
const DENIED_STORAGE: SnippetStorage = {
  length: 0,
  key: deny,
  getItem: deny,
  setItem: deny,
  removeItem: deny,
};

function browserSnippetStorage(): SnippetStorage {
  try {
    return window.localStorage;
  } catch {
    return DENIED_STORAGE;
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// shared card chrome

const CHIP_ERROR =
  "border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-chip-error-text)]";

function PanelHeader({
  titleId,
  title,
  meta,
  toggle,
}: {
  titleId: string;
  title: string;
  meta: string;
  toggle?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <div className="min-w-0">
        <div
          className="truncate font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]"
          id={titleId}
        >
          {title}
        </div>
        <div className="truncate text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          {meta}
        </div>
      </div>
      {toggle}
    </div>
  );
}

export function SnippetErrorCard({
  titleId,
  title,
  meta,
  chip,
  message,
  detail,
  onReload,
}: {
  titleId: string;
  title: string;
  meta: string;
  chip: string;
  message: string;
  detail?: string;
  onReload?: (trusted: boolean) => void;
}) {
  return (
    <section
      aria-labelledby={titleId}
      className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]"
    >
      <PanelHeader meta={meta} title={title} titleId={titleId} />
      <div className="flex items-start justify-between gap-3 px-3 py-3.5" role="alert">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={CHIP_ERROR}>{chip}</span>
          {detail ? (
            <span className="text-[var(--color-text-primary)] [overflow-wrap:anywhere]">
              {detail}
            </span>
          ) : null}
          <span className="text-[var(--color-text-secondary)]">{message}</span>
        </div>
        {onReload ? (
          <button
            className="shrink-0 border border-[var(--color-border-strong)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
            onClick={(event) => onReload(event.nativeEvent.isTrusted)}
            type="button"
          >
            Reload
          </button>
        ) : null}
      </div>
    </section>
  );
}

const RUNTIME_ERRORS: Record<PanelRuntimeError, { chip: string; message: string }> = {
  hello_timeout: { chip: "No connection", message: "Snippet did not connect in 10 s." },
  navigated: { chip: "Navigated", message: "Snippet left its page. Panel stopped." },
  flood: { chip: "Flood", message: "Over 100 messages in 10 s. Panel stopped." },
  protocol: { chip: "No connection", message: "Snippet protocol version not supported." },
};

// ---------------------------------------------------------------------------
// confirm strip and status line

function payloadPreview(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function ConfirmStrip({
  confirm,
  onSend,
  onDiscard,
}: {
  confirm: PendingConfirm;
  onSend: (trusted: boolean) => void;
  onDiscard: (trusted: boolean) => void;
}) {
  return (
    <div
      aria-label="Confirm snippet action"
      aria-live="polite"
      className="border-t border-l-2 border-t-[var(--color-border-subtle)] border-l-[var(--color-status-attention)] bg-[var(--color-bg-elevated)] px-3 py-2.5"
      role="group"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
          {confirm.label}
        </span>
        <span className="text-[10px] text-[var(--color-text-tertiary)]">{confirm.actionId}</span>
        <span className="text-[var(--color-status-attention)]">
          {SNIPPET_CONFIRM_REASON_TEXT[confirm.reason]}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        {Object.entries(confirm.payload).map(([key, value]) => (
          <div className="contents" key={key}>
            <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {key}
            </dt>
            <dd className="truncate text-[var(--color-text-secondary)]">{payloadPreview(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Full payload
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2 text-[11px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
          {JSON.stringify(confirm.payload, null, 2)}
        </pre>
      </details>
      <div className="mt-2.5 flex justify-end gap-2 max-sm:[&>button]:flex-1">
        <button
          className="border border-[var(--color-border-strong)] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
          onClick={(event) => onDiscard(event.nativeEvent.isTrusted)}
          type="button"
        >
          Discard
        </button>
        <button
          className="inline-flex items-center justify-center gap-1.5 border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-inverse)] transition hover:opacity-90"
          onClick={(event) => onSend(event.nativeEvent.isTrusted)}
          type="button"
        >
          <SendIcon className="h-3 w-3" />
          Send
        </button>
      </div>
    </div>
  );
}

function StatusLine({
  action,
  manifest,
  onRetry,
}: {
  action: SnippetActionRecord | null;
  manifest: SnippetManifest;
  onRetry: (trusted: boolean) => void;
}) {
  if (!action) {
    return <div aria-live="polite" className="h-0 overflow-hidden" role="status" />;
  }
  const failed = action.status === "error" || action.status === "delivery_unknown";
  const attention = action.status === "timeout" || action.status === "awaiting_confirm";
  const working = !isTerminalSnippetStatus(action.status) && action.status !== "awaiting_confirm";
  const label = manifest.actions.find((candidate) => candidate.id === action.actionId)?.label;
  const tone = failed
    ? "text-[var(--color-status-error)]"
    : attention
      ? "text-[var(--color-status-attention)]"
      : "text-[var(--color-text-primary)]";
  return (
    <div
      aria-live={failed ? undefined : "polite"}
      className="relative flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-subtle)] px-3 py-1.5"
      data-snippet-status={action.status}
      role={failed ? "alert" : "status"}
    >
      {working ? (
        <LoadingBar className="absolute inset-x-0 top-0" label="Action in progress" />
      ) : null}
      <span
        className={`inline-flex items-center gap-1.5 font-bold uppercase tracking-[0.1em] ${tone}`}
      >
        {working ? <Spinner className="h-3 w-3" /> : null}
        {action.status === "completed" ? (
          <span aria-hidden="true" className="text-[var(--color-status-ready)]">
            ✓
          </span>
        ) : null}
        {snippetStatusLabel(action)}
      </span>
      {label ? <span className="text-[var(--color-text-secondary)]">{label}</span> : null}
      <span className="ml-auto text-[var(--color-text-tertiary)]">
        {formatRelativeTime(new Date(action.dispatchedAt).toISOString())}
      </span>
      {SNIPPET_RETRY_STATUSES.includes(action.status) ? (
        <button
          className="border border-[var(--color-border-strong)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
          onClick={(event) => onRetry(event.nativeEvent.isTrusted)}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// panel

function FramePlaceholder() {
  return (
    <div className="flex h-[160px] items-center justify-center text-[var(--color-text-tertiary)]">
      <Spinner className="h-4 w-4" />
    </div>
  );
}

const noopSubscribe = () => () => undefined;
const getNullState = (): null => null;

export interface SnippetPanelProps {
  sessionId: string;
  manifest: SnippetManifest;
  html: string;
  // listing metadata: lets the panel tell a poll that changed the file from one that did not
  listingKey: string;
  fetching: boolean;
  updatedAt?: string;
  session: Omit<SnippetSessionUpdate, "messages" | "fileSettled">;
  messages: readonly ConversationMessage[];
  // Bridge seam: tests replace the browser-backed deps (channel, send, storage, clocks).
  bridge?: Partial<SnippetHostDeps>;
}

export function SnippetPanel({
  sessionId,
  manifest,
  html,
  listingKey,
  fetching,
  updatedAt,
  session,
  messages,
  bridge,
}: SnippetPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const [host, setHost] = useState<SnippetHost | null>(null);
  const hostRef = useRef<SnippetHost | null>(null);
  const prevKeyRef = useRef(listingKey);
  const titleId = `snippet-title-${sessionId}-${manifest.snippetId}`;

  function openFullscreen(): void {
    const current = hostRef.current;
    const dialog = dialogRef.current;
    if (!current || !dialog || current.getState().fullscreen) return;
    enterFullscreen(dialog, iframeRef.current, closeRef.current);
    current.setFullscreen(true);
  }

  function closeFullscreen(): void {
    const current = hostRef.current;
    const dialog = dialogRef.current;
    if (!current || !dialog || !current.getState().fullscreen) return;
    exitFullscreen(dialog, toggleRef.current);
    current.setFullscreen(false);
  }

  // The controller is created in an effect so StrictMode's mount, cleanup,
  // mount cycle disposes one and builds a fresh one.
  useEffect(() => {
    const deps: SnippetHostDeps = {
      sessionId,
      postToFrame: (message, transfer) => {
        iframeRef.current?.contentWindow?.postMessage(message, "*", transfer as Transferable[]);
      },
      createChannel: () => {
        const channel = new MessageChannel();
        return { hostPort: channel.port1 as unknown as SnippetPort, framePort: channel.port2 };
      },
      send: async (prompt) => {
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: prompt, queue: true }),
          });
          return { kind: "response", status: response.status };
        } catch {
          return { kind: "failure" };
        }
      },
      loadSdk,
      getFonts: currentFonts,
      getTheme: readTheme,
      storage: browserSnippetStorage(),
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      nonce: randomNonce,
      isFrameFocused: () =>
        document.hasFocus() &&
        iframeRef.current !== null &&
        document.activeElement === iframeRef.current,
      onFullscreenRequest: (open) => {
        if (open) openFullscreen();
        else closeFullscreen();
      },
    };
    requestFonts();
    const created = createSnippetHost({ ...deps, ...bridge }, { manifest, html });
    const onMessage = (event: MessageEvent) => {
      created.onWindowMessage(
        event.data,
        iframeRef.current !== null && event.source === iframeRef.current.contentWindow,
      );
    };
    const onBlur = () => {
      if (iframeRef.current && document.activeElement === iframeRef.current) {
        created.noteFrameFocus();
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("blur", onBlur);
    hostRef.current = created;
    setHost(created);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("blur", onBlur);
      created.dispose();
      hostRef.current = null;
      setHost(null);
    };
    // The controller is built once per panel from the first file; later files
    // arrive through applyFile below.
  }, [sessionId]);

  const state = useSyncExternalStore(
    host ? host.subscribe : noopSubscribe,
    host ? host.getState : getNullState,
    getNullState,
  );

  // Attach runs on every dialog (re)mount: the panel swaps with an error card.
  const attachDialog = useCallback((node: HTMLDialogElement | null) => {
    dialogRef.current = node;
    if (node) setInline(node);
  }, []);

  useEffect(() => {
    host?.applyFile(manifest, html);
  }, [host, manifest, html]);

  useEffect(() => {
    const settled = prevKeyRef.current === listingKey && !fetching;
    prevKeyRef.current = listingKey;
    host?.updateSession({ ...session, messages, fileSettled: settled });
  }, [host, session, messages, listingKey, fetching]);

  const fullscreen = state?.fullscreen ?? false;
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  const running = state?.phase === "connecting" || state?.phase === "connected";
  const srcDoc = useMemo(
    () =>
      state && running && state.sdkSource !== null
        ? buildSnippetSrcdoc(state.html, state.sdkSource, state.nonce)
        : null,
    // mountKey changes with every nonce; the other fields are inputs of that mount
    [running, state?.sdkSource, state?.html, state?.nonce],
  );

  if (!state || !host) {
    return (
      <section className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
        <FramePlaceholder />
      </section>
    );
  }

  const meta = `${state.manifest.snippetId} · r${state.manifest.revision}${
    updatedAt ? ` · updated ${formatRelativeTime(updatedAt)}` : ""
  }`;

  if (state.phase === "error" && state.error !== null) {
    const info = RUNTIME_ERRORS[state.error];
    return (
      <SnippetErrorCard
        chip={info.chip}
        message={info.message}
        meta={meta}
        onReload={
          RELOADABLE_ERRORS.includes(state.error) ? (trusted) => host.reload(trusted) : undefined
        }
        title={state.manifest.title}
        titleId={titleId}
      />
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]"
      data-snippet-panel={state.manifest.snippetId}
    >
      <PanelHeader
        meta={meta}
        title={state.manifest.title}
        titleId={titleId}
        toggle={
          <button
            aria-label={`Open ${state.manifest.title} fullscreen`}
            className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)]"
            onClick={openFullscreen}
            ref={toggleRef}
            title="Fullscreen"
            type="button"
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              viewBox="0 0 16 16"
            >
              <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
            </svg>
          </button>
        }
      />
      {state.conflict ? (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-[var(--color-chip-warn-border)] px-3 py-2"
          role="alert"
        >
          <span className="border border-[var(--color-chip-warn-border)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-chip-warn-text)]">
            Revision conflict
          </span>
          <span className="text-[var(--color-text-secondary)]">
            Revision {state.manifest.revision} changed in place. Showing the first copy. Actions
            blocked until revision {state.manifest.revision + 1}.
          </span>
        </div>
      ) : null}
      <dialog
        aria-labelledby={titleId}
        className="snippet-dialog"
        onCancel={(event) => {
          event.preventDefault();
          closeFullscreen();
        }}
        ref={attachDialog}
      >
        <div className="snippet-fs-header flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-3 py-2">
          <button
            aria-label="Exit fullscreen"
            className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
            onClick={closeFullscreen}
            ref={closeRef}
            type="button"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
          <span className="min-w-0 truncate font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
            {state.manifest.title}
          </span>
          <span className="hidden truncate text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)] sm:inline">
            {state.manifest.snippetId} · r{state.manifest.revision} · Esc to exit
          </span>
        </div>
        {srcDoc !== null ? (
          <iframe
            className="snippet-frame block w-full border-0 bg-transparent"
            key={state.mountKey}
            onLoad={() => host.frameLoaded()}
            ref={iframeRef}
            referrerPolicy="no-referrer"
            sandbox={SNIPPET_FRAME_SANDBOX}
            srcDoc={srcDoc}
            style={{ height: state.height ?? 160 }}
            title={state.manifest.title}
          />
        ) : (
          <FramePlaceholder />
        )}
        {state.confirm ? (
          <ConfirmStrip
            confirm={state.confirm}
            onDiscard={(trusted) => host.confirmDiscard(trusted)}
            onSend={(trusted) => host.confirmSend(trusted)}
          />
        ) : null}
        <StatusLine
          action={state.action}
          manifest={state.manifest}
          onRetry={(trusted) => host.retry(trusted)}
        />
      </dialog>
    </section>
  );
}
