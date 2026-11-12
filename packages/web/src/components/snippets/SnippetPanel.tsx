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
import { CheckIcon } from "@/components/icons/CheckIcon";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { SendIcon } from "@/components/icons/SendIcon";
import { Spinner } from "@/components/icons/Spinner";
import { LoadingBar } from "@/components/LoadingBar";
import { ChatVoiceView } from "@/components/ChatVoiceControls";
import { useVoiceInput, type UseVoiceInput } from "@/hooks/useVoiceInput";
import { placeVoiceSlots } from "@/lib/snippets/snippet-voice-layout";
import { formatRelativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme-context";
import {
  createSdkLoader,
  createSnippetHost,
  RELOADABLE_ERRORS,
  type PendingConfirm,
  type PanelRuntimeError,
  type SnippetAction,
  type SnippetFontBuffer,
  type ApplyFileResult,
  type SnippetHost,
  type SnippetHostDeps,
  type SnippetPort,
  type SnippetSessionUpdate,
  type StoreResponse,
} from "@/lib/snippets/snippet-host";
import type { SnippetManifest } from "@/lib/snippets/snippet-manifest";
import {
  isTerminalSnippetStatus,
  SNIPPET_CONFIRM_REASON_TEXT,
  SNIPPET_FONT_URLS,
  SNIPPET_RETRY_STATUSES,
  SNIPPET_THEME_TOKENS,
  snippetStatusLabel,
  type SnippetTheme,
  type SnippetThemeToken,
  type ChatLayout,
  type VoiceRect,
} from "@/lib/snippets/snippet-protocol";
import { enterFullscreen, exitFullscreen, setInline } from "@/lib/snippets/snippet-dialog";
import type { SnippetStorage } from "@/lib/snippets/snippet-store";
import { buildSnippetSrcdoc, SNIPPET_FRAME_SANDBOX } from "@/lib/snippets/snippet-srcdoc";
import { storeChangePoller } from "@/lib/store-change-poller";

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

export function browserSnippetStorage(): SnippetStorage {
  try {
    return window.localStorage;
  } catch {
    return DENIED_STORAGE;
  }
}

async function storeRequest(method: string, url: string, body?: unknown): Promise<StoreResponse> {
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body: json };
  } catch {
    return { ok: false, status: 0, body: { error: "network error" } };
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// shared card chrome

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]";
const SECONDARY_BUTTON = `border border-[var(--color-border-strong)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] ${FOCUS_RING}`;
const ICON_BUTTON = `inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`;

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
            className={`shrink-0 ${SECONDARY_BUTTON}`}
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
          {confirm.kind === "invoke" ? confirm.label : "Message to agent"}
        </span>
        {confirm.kind === "invoke" ? (
          <span className="text-[10px] text-[var(--color-text-tertiary)]">{confirm.actionId}</span>
        ) : null}
        <span className="text-[var(--color-status-attention)]">
          {SNIPPET_CONFIRM_REASON_TEXT[confirm.reason]}
        </span>
      </div>
      {confirm.kind === "invoke" ? (
        <>
          <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
            {Object.entries(confirm.payload).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  {key}
                </dt>
                <dd className="truncate text-[var(--color-text-secondary)]">
                  {payloadPreview(value)}
                </dd>
              </div>
            ))}
          </dl>
          <details className="mt-2">
            <summary
              className={`cursor-pointer text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)] ${FOCUS_RING}`}
            >
              Full payload
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2 text-[11px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
              {JSON.stringify(confirm.payload, null, 2)}
            </pre>
          </details>
        </>
      ) : (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2 text-[11px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
          {confirm.message}
        </pre>
      )}
      <div className="mt-2.5 flex justify-end gap-2 max-sm:[&>button]:flex-1">
        <button
          className={SECONDARY_BUTTON}
          onClick={(event) => onDiscard(event.nativeEvent.isTrusted)}
          type="button"
        >
          Discard
        </button>
        <button
          className={`inline-flex items-center justify-center gap-1.5 border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-inverse)] transition hover:opacity-90 ${FOCUS_RING}`}
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
  onRetry,
}: {
  action: SnippetAction | null;
  onRetry: (trusted: boolean) => void;
}) {
  if (!action) {
    return <div aria-live="polite" className="h-0 overflow-hidden" role="status" />;
  }
  const failed = action.status === "error";
  const attention = action.status === "timeout" || action.status === "awaiting_confirm";
  const working = !isTerminalSnippetStatus(action.status) && action.status !== "awaiting_confirm";
  const { label } = action;
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
          <CheckIcon className="h-3 w-3 text-[var(--color-status-ready)]" strokeWidth={2} />
        ) : null}
        {snippetStatusLabel(action)}
      </span>
      {label ? <span className="text-[var(--color-text-secondary)]">{label}</span> : null}
      <span className="ml-auto text-[var(--color-text-tertiary)]">
        {formatRelativeTime(new Date(action.createdAt).toISOString())}
      </span>
      {SNIPPET_RETRY_STATUSES.includes(action.status) ? (
        <button
          className={SECONDARY_BUTTON}
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
    <div
      aria-busy="true"
      className="flex h-[160px] items-center justify-center text-[var(--color-text-tertiary)]"
    >
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
  updatedAt?: string;
  session: SnippetSessionUpdate;
  // Bridge seam: tests replace the browser-backed deps (channel, request, poller, storage, clocks).
  bridge?: Partial<SnippetHostDeps>;
  // Outcome of each file handed to the controller (a lower revision is refused there).
  onApplyResult?: (result: ApplyFileResult) => void;
}

export function SnippetPanel({
  sessionId,
  manifest,
  html,
  updatedAt,
  session,
  bridge,
  onApplyResult,
}: SnippetPanelProps) {
  const onApplyResultRef = useRef(onApplyResult);
  useEffect(() => {
    onApplyResultRef.current = onApplyResult;
  }, [onApplyResult]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const [host, setHost] = useState<SnippetHost | null>(null);
  const hostRef = useRef<SnippetHost | null>(null);
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
      request: storeRequest,
      poller: storeChangePoller,
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

  // Runtime theme switch: tell the snippet once the provider has applied it.
  const { theme } = useTheme();
  const seenTheme = useRef(theme);
  useEffect(() => {
    if (seenTheme.current === theme) return;
    seenTheme.current = theme;
    queueMicrotask(() => hostRef.current?.themeChanged());
  }, [theme]);

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
    if (!host) return;
    const result = host.applyFile(manifest, html);
    onApplyResultRef.current?.(result);
  }, [host, manifest, html]);

  useEffect(() => {
    host?.updateSession(session);
  }, [host, session]);

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
        ? buildSnippetSrcdoc(state.html, state.sdkSource, state.nonce, theme)
        : null,
    // `theme` is left out on purpose: runtime switches go through the SDK theme message, and a remount would reload the snippet.
    // mountKey changes with every nonce; the other fields are inputs of that mount
    [running, state?.sdkSource, state?.html, state?.nonce],
  );

  if (!state || !host) {
    return (
      <section
        aria-labelledby={titleId}
        className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]"
      >
        <PanelHeader
          meta={`${manifest.snippetId} · r${manifest.revision}`}
          title={manifest.title}
          titleId={titleId}
        />
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
            className={ICON_BUTTON}
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
            className={ICON_BUTTON}
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
        <div className="snippet-frame-region relative min-h-0 overflow-hidden" ref={regionRef}>
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
          {state.phase === "connected" &&
          !state.conflict &&
          state.availability.canInvoke &&
          srcDoc !== null ? (
            <SnippetVoice
              key={`voice:${state.mountKey}`}
              host={host}
              sessionId={sessionId}
              mountKey={state.mountKey}
              frameRef={iframeRef}
              regionRef={regionRef}
              layout={state.voiceLayout}
            />
          ) : null}
        </div>
        {state.confirm ? (
          <ConfirmStrip
            confirm={state.confirm}
            onDiscard={(trusted) => host.confirmDiscard(trusted)}
            onSend={(trusted) => host.confirmSend(trusted)}
          />
        ) : null}
        <StatusLine action={state.action} onRetry={(trusted) => host.retry(trusted)} />
      </dialog>
    </section>
  );
}

function SnippetVoice({
  host,
  sessionId,
  mountKey,
  frameRef,
  regionRef,
  layout,
}: {
  host: SnippetHost;
  sessionId: string;
  mountKey: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  regionRef: React.RefObject<HTMLDivElement | null>;
  layout: ChatLayout | null;
}) {
  const [slots, setSlots] = useState<Array<{ target: string; rect: VoiceRect }>>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const [errorTarget, setErrorTarget] = useState<string | null>(null);
  const claim = useRef<{ target: string; generation: number } | null>(null);
  const generation = useRef(0);
  const suspended = useRef(false);
  const currentLayout = useRef(layout);
  currentLayout.current = layout;
  const eligible = () => {
    if (suspended.current) return [];
    const frame = frameRef.current;
    const region = regionRef.current;
    return frame && region ? placeVoiceSlots(frame, region, currentLayout.current) : [];
  };
  const voice = useVoiceInput({
    contextKey: `snippet-chat:${sessionId}:${mountKey}`,
    onTranscribed: (text) => {
      const take = claim.current;
      if (
        take &&
        take.generation === generation.current &&
        eligible().some((slot) => slot.target === take.target)
      )
        host.insertVoiceText(take.target, mountKey, text);
    },
  });
  const live = useRef({ voice, eligible });
  live.current = { voice, eligible };
  const cancel = useCallback(() => {
    generation.current += 1;
    claim.current = null;
    setOwner(null);
    setErrorTarget(null);
    live.current.voice.cancelRecording();
    void live.current.voice.discardRetainedTake();
    live.current.voice.clearVoiceError();
  }, []);
  useEffect(() => {
    const frame = frameRef.current;
    const region = regionRef.current;
    if (!frame || !region) return;
    let scheduled = 0;
    const measure = () => {
      const next = live.current.eligible();
      if (claim.current && !next.some((slot) => slot.target === claim.current?.target)) cancel();
      setSlots((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    const invalidate = () => {
      if (!scheduled)
        scheduled = requestAnimationFrame(() => {
          scheduled = 0;
          measure();
        });
    };
    const motion = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.contains(frame)) {
        setSlots([]);
        cancel();
      }
    };
    const hide = () => {
      suspended.current = true;
      cancel();
      setSlots([]);
    };
    const show = () => {
      suspended.current = false;
      invalidate();
    };
    const resize = new ResizeObserver(invalidate);
    const mutation = new MutationObserver(invalidate);
    for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
      resize.observe(node);
      mutation.observe(node, {
        attributes: true,
        attributeFilter: ["class", "style", "open", "hidden"],
      });
    }
    const events = [
      "scroll",
      "resize",
      "transitionend",
      "transitioncancel",
      "animationend",
      "animationcancel",
    ];
    events.forEach((name) => window.addEventListener(name, invalidate, true));
    window.addEventListener("transitionrun", motion, true);
    window.addEventListener("animationstart", motion, true);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.visualViewport?.addEventListener("scroll", invalidate);
    window.visualViewport?.addEventListener("resize", invalidate);
    const timer = window.setInterval(measure, 500);
    invalidate();
    return () => {
      cancelAnimationFrame(scheduled);
      clearInterval(timer);
      resize.disconnect();
      mutation.disconnect();
      events.forEach((name) => window.removeEventListener(name, invalidate, true));
      window.removeEventListener("transitionrun", motion, true);
      window.removeEventListener("animationstart", motion, true);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.visualViewport?.removeEventListener("scroll", invalidate);
      window.visualViewport?.removeEventListener("resize", invalidate);
      generation.current += 1;
      claim.current = null;
      for (const slot of currentLayout.current?.slots ?? [])
        host.voiceState(slot.target, mountKey, {
          starting: false,
          unavailable: false,
          error: null,
        });
      live.current.voice.cancelRecording();
      void live.current.voice.discardRetainedTake();
    };
  }, [cancel, frameRef, regionRef, host, mountKey]);
  // A snapshot invalidates placement without rebuilding the controller or its observers.
  useEffect(() => {
    const next = eligible();
    if (claim.current && !next.some((slot) => slot.target === claim.current?.target)) cancel();
    setSlots((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    if (!layout) return;
    const expiry = window.setTimeout(
      () => {
        if (claim.current) cancel();
        setSlots([]);
      },
      Math.max(0, layout.receivedAt + 750 - Date.now()),
    );
    return () => clearTimeout(expiry);
  }, [layout, cancel]);
  useEffect(() => {
    if (voice.hasRetainedTake && !claim.current) {
      void voice.discardRetainedTake();
      return;
    }
    if (!voice.recording && !voice.voiceBusy && !voice.hasRetainedTake && claim.current) {
      setErrorTarget(voice.voiceError ? claim.current.target : null);
      claim.current = null;
      setOwner(null);
    }
  }, [voice.recording, voice.voiceBusy, voice.hasRetainedTake, voice.voiceError]);
  useEffect(() => {
    for (const slot of layout?.slots ?? [])
      host.voiceState(slot.target, mountKey, {
        starting: slot.target === owner && voice.voiceBusy === "starting",
        unavailable: !voice.canUseVoice,
        error:
          slot.target === (owner ?? errorTarget)
            ? (voice.voiceError?.slice(0, 2000) ?? null)
            : null,
      });
  }, [
    host,
    mountKey,
    layout,
    owner,
    errorTarget,
    voice.voiceBusy,
    voice.canUseVoice,
    voice.voiceError,
  ]);
  const gesture = useRef<{ target: string; rect: string } | null>(null);
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-snippet-voice-overlay
    >
      {slots.map(({ target, rect }) => {
        const other = owner !== null && owner !== target;
        const view: UseVoiceInput = other
          ? {
              ...voice,
              recording: false,
              voiceBusy: "starting",
              hasRetainedTake: false,
              voiceError: null,
            }
          : {
              ...voice,
              toggleRecording: () => {
                if (!claim.current) {
                  claim.current = { target, generation: ++generation.current };
                  setOwner(target);
                  setErrorTarget(null);
                  voice.clearVoiceError();
                }
                voice.toggleRecording();
              },
              cancelRecording: cancel,
              discardRetainedTake: async () => {
                cancel();
              },
            };
        return (
          <div
            key={target}
            data-voice-target={target}
            className="absolute origin-top-left"
            style={{
              left: rect.x,
              top: rect.y,
              width: 32,
              height: 108,
              transform: `scale(${rect.width / 32}, ${rect.height / 108})`,
            }}
            onPointerDownCapture={() => {
              const slot = eligible().find((item) => item.target === target);
              gesture.current = slot
                ? {
                    target,
                    rect: JSON.stringify(slot.rect),
                  }
                : null;
            }}
            onPointerCancel={() => {
              gesture.current = null;
            }}
            onClickCapture={(event) => {
              const slot = eligible().find((item) => item.target === target);
              const pending = gesture.current;
              gesture.current = null;
              if (
                !slot ||
                (claim.current && claim.current.target !== target) ||
                (event.detail > 0 &&
                  (!pending ||
                    pending.target !== target ||
                    pending.rect !== JSON.stringify(slot.rect)))
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <ChatVoiceView voice={view} />
          </div>
        );
      })}
    </div>
  );
}
