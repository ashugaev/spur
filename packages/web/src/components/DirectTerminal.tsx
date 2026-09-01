"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { useInputHistory } from "@/hooks/useInputHistory";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { StopSquareIcon, VoiceConfirmModal, VoiceControls } from "@/components/VoiceInput";
import "xterm/css/xterm.css";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { Terminal as TerminalType } from "xterm";
import { getTerminalTheme } from "@/design/colors";
import { cn } from "@/lib/cn";
import { getAgentHotkeys } from "@/lib/agent-hotkeys";
import { getAgentDisplayName, type AgentName } from "@/lib/agents";
import {
  assertAttachmentsWithinLimit,
  encodeFileAttachments,
  imageFilesFromDataTransfer,
  fileAttachmentsFromFiles,
  mergeAttachmentsWithinLimit,
  type FileAttachment,
} from "@/lib/file-attachments";
import { TerminalStatusDot } from "@/components/TerminalStatusDot";
import { ToastViewport } from "@/components/Toast";
import { useToasts } from "@/hooks/useToasts";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { useTheme } from "@/lib/theme-context";
import type { SpurSessionState } from "@/lib/types";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import {
  areTerminalLinksEqual,
  composeTerminalLinkDisplay,
  extractTerminalLinks,
  mergeTerminalLinkDiscoveries,
  TERMINAL_LINK_DISCOVERY_LIMIT,
  type TerminalLink,
} from "@/lib/terminal-links";

interface DirectTerminalProps {
  sessionId: string;
  apiSessionId?: string;
  agentInputEnabled?: boolean;
  agent?: AgentName;
  model?: string;
  activity?: SpurSessionState | null;
  title?: string;
  onClose?: () => void;
}

interface TerminalLocation {
  protocol: string;
  host: string;
}

/** Pixels of touch movement that count as one scroll line. */
const TOUCH_SCROLL_THRESHOLD = 20;
const RECONNECT_DELAY_MS = 1_000;
const INPUT_ACK_TIMEOUT_MS = 600;
const INPUT_RETRY_DELAY_MS = 200;
const INPUT_MAX_ATTEMPTS = 4;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const TERMINAL_DRAFT_HISTORY_STORAGE_KEY = "spur:input-history:terminal-draft";
const TERMINAL_ARROW_CONTROLS = [
  { label: "Arrow Left", iconPath: "M15 19l-7-7 7-7", sequence: "\x1b[D" },
  { label: "Arrow Up", iconPath: "M5 15l7-7 7 7", sequence: "\x1b[A" },
  { label: "Arrow Down", iconPath: "M19 9l-7 7-7-7", sequence: "\x1b[B" },
  { label: "Arrow Right", iconPath: "M9 5l7 7-7 7", sequence: "\x1b[C" },
] as const;

function isRetryableClose(code: number): boolean {
  return code !== 1000 && code !== 1008 && code !== 4004;
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M5 7h8" />
      <path d="M5 12h8" />
      <path d="M5 17h5" />
      <path d="M17 9v8" />
      <path d="M14 14l3 3 3-3" />
    </svg>
  );
}

function ArrowIcon({ path }: { path: string }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FourDirectionArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 9l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 15l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 8l-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChainLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function buildSubmittedTextPayloads(text: string): string[] {
  return [`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`, "\r"];
}

export function buildDirectTerminalWsUrl(location: TerminalLocation, sessionId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Build an SGR mouse scroll sequence.
 * Button 64 = scroll up, 65 = scroll down.
 */
function sgrScroll(up: boolean, column: number, row: number): string {
  const button = up ? 64 : 65;
  return `\x1b[<${button};${column};${row}M`;
}

interface InputAckMessage {
  type: "ack";
  id?: string;
}

interface PendingInputAck {
  attempts: number;
  data: string;
  id: string;
  ackTimer: number | null;
  retryTimer: number | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function DirectTerminal({
  sessionId,
  apiSessionId,
  agentInputEnabled = true,
  agent = "claude",
  model,
  activity,
  title,
  onClose,
}: DirectTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<TerminalType | null>(null);
  const hotkeyMenuRef = useRef<HTMLDivElement>(null);
  const arrowMenuRef = useRef<HTMLDivElement>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const inputSeqRef = useRef(0);
  const pendingAckRef = useRef<PendingInputAck | null>(null);
  const hotkeys = getAgentHotkeys(agent);
  const { theme } = useTheme();
  // Always holds the latest theme so the async terminal construction below
  // reads the current value even if the user toggled while `import("xterm")`
  // was still pending (the mount effect closes over a possibly-stale `theme`).
  const themeRef = useRef(theme);
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "error">(
    "connecting",
  );
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [arrowsOpen, setArrowsOpen] = useState(false);
  const [terminalLinks, setTerminalLinks] = useState<TerminalLink[]>([]);
  const terminalLinksRef = useRef<TerminalLink[]>([]);
  const discoveredTerminalLinksRef = useRef<TerminalLink[]>([]);
  const [terminalLinksOpen, setTerminalLinksOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [voiceAttachments, setVoiceAttachments] = useState<FileAttachment[]>([]);
  const { toasts, showErrorToast, dismissToast } = useToasts();
  const sessionApiId = apiSessionId ?? sessionId;
  const terminalLinksMenu = useAnchoredMenu({
    open: terminalLinksOpen,
    onClose: () => setTerminalLinksOpen(false),
    contentDeps: [terminalLinks],
  });

  const sendTerminalInput = useCallback((data: string): boolean => {
    if (websocketRef.current?.readyState !== WebSocket.OPEN) return false;
    websocketRef.current.send(data);
    return true;
  }, []);
  const clearPendingAckTimers = useCallback((pending: PendingInputAck) => {
    if (pending.ackTimer !== null) {
      window.clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    if (pending.retryTimer !== null) {
      window.clearTimeout(pending.retryTimer);
      pending.retryTimer = null;
    }
  }, []);

  const rejectPendingAck = useCallback(
    (pending: PendingInputAck, message: string) => {
      clearPendingAckTimers(pending);
      if (pendingAckRef.current?.id === pending.id) {
        pendingAckRef.current = null;
      }
      pending.reject(new Error(message));
    },
    [clearPendingAckTimers],
  );

  const sendWithAck = useCallback(
    (data: string): Promise<void> => {
      const id = `${Date.now()}-${inputSeqRef.current++}`;

      return new Promise<void>((resolve, reject) => {
        const existing = pendingAckRef.current;
        if (existing) {
          reject(new Error("Failed to insert transcription"));
          return;
        }
        const pending: PendingInputAck = {
          attempts: 0,
          data,
          id,
          ackTimer: null,
          retryTimer: null,
          resolve,
          reject,
        };

        const trySend = () => {
          pending.attempts += 1;
          if (pending.attempts > INPUT_MAX_ATTEMPTS) {
            rejectPendingAck(pending, "Failed to insert transcription");
            return;
          }
          const socket = websocketRef.current;
          if (
            !socket ||
            socket.readyState === WebSocket.CLOSED ||
            socket.readyState === WebSocket.CLOSING
          ) {
            rejectPendingAck(pending, "Failed to insert transcription");
            return;
          }

          if (socket.readyState !== WebSocket.OPEN) {
            pending.retryTimer = window.setTimeout(trySend, INPUT_RETRY_DELAY_MS);
            return;
          }

          socket.send(JSON.stringify({ type: "input", id: pending.id, data: pending.data }));
          pending.ackTimer = window.setTimeout(() => {
            pending.retryTimer = window.setTimeout(trySend, INPUT_RETRY_DELAY_MS);
          }, INPUT_ACK_TIMEOUT_MS);
        };

        pendingAckRef.current = pending;
        trySend();
      });
    },
    [rejectPendingAck],
  );

  const voice = useVoiceInput({ contextKey: `terminal:${sessionId}` });
  const draftHistory = useInputHistory(TERMINAL_DRAFT_HISTORY_STORAGE_KEY);

  const addVoiceImageFiles = useCallback(
    (files: FileList | File[] | null) => {
      void fileAttachmentsFromFiles(files)
        .then((attachments) => {
          if (attachments.length === 0) return;
          let rejectedMessage: string | null = null;
          setVoiceAttachments((current) => {
            const result = mergeAttachmentsWithinLimit(current, attachments);
            rejectedMessage = result.rejectedMessage;
            return result.attachments;
          });
          if (rejectedMessage) showErrorToast(rejectedMessage);
        })
        .catch(() => {});
    },
    [showErrorToast],
  );

  const sendSessionMessage = useCallback(
    async (
      text: string,
      attachments: FileAttachment[],
      options: { queue: boolean; interrupt?: boolean },
    ) => {
      const encodedAttachments = encodeFileAttachments(attachments);
      assertAttachmentsWithinLimit(encodedAttachments);
      const message = text.trim();
      if (!message && encodedAttachments.length === 0) return;
      const body: Record<string, unknown> = {
        message,
        queue: options.queue,
      };
      if (encodedAttachments.length > 0) {
        body.attachments = encodedAttachments;
      }
      if (options.interrupt !== undefined) {
        body.interrupt = options.interrupt;
      }

      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionApiId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await readResponsePayload(response);
        if (response.status === 409) {
          showErrorToast("Message not sent — this session is currently rate limited");
        }
        throw new Error(responseErrorMessage(payload, "Failed to send session message"));
      }
      setSubmitError(null);
    },
    [sessionApiId, showErrorToast],
  );

  const openAttachmentDraft = useCallback(
    (files: File[]) => {
      if (!agentInputEnabled) return;
      void fileAttachmentsFromFiles(files)
        .then((attachments) => {
          if (attachments.length === 0) return;
          let rejectedMessage: string | null = null;
          setVoiceAttachments((current) => {
            const result = mergeAttachmentsWithinLimit(current, attachments);
            rejectedMessage = result.rejectedMessage;
            return result.attachments;
          });
          if (rejectedMessage) {
            showErrorToast(rejectedMessage);
            return;
          }
          voice.openDraft(voice.voiceModalOpen ? voice.voiceDraft : "");
        })
        .catch(() => {});
    },
    [agentInputEnabled, showErrorToast, voice],
  );

  const handleTerminalPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!agentInputEnabled) return;
      const files = imageFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      openAttachmentDraft(files);
    },
    [agentInputEnabled, openAttachmentDraft],
  );

  useEffect(() => {
    const target = terminalRef.current;
    if (!target || !agentInputEnabled) return;
    const onPaste = (event: ClipboardEvent) => {
      if (!(event.target instanceof Node) || !target.contains(event.target)) return;
      const dataTransfer = event.clipboardData;
      const files = imageFilesFromDataTransfer(dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      openAttachmentDraft(files);
    };
    target.addEventListener("paste", onPaste, { capture: true });
    document.addEventListener("paste", onPaste, { capture: true });
    return () => {
      target.removeEventListener("paste", onPaste, { capture: true });
      document.removeEventListener("paste", onPaste, { capture: true });
    };
  }, [agentInputEnabled, openAttachmentDraft]);

  const submitVoiceDraft = useCallback(
    async (text: string) => {
      if (voiceAttachments.length > 0) {
        await sendSessionMessage(text, voiceAttachments, { queue: false, interrupt: true });
        setVoiceAttachments([]);
        if (text.trim()) {
          draftHistory.saveEntry(text);
        }
        return;
      }
      const socket = websocketRef.current;
      if (
        !socket ||
        socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED
      ) {
        throw new Error("Failed to insert transcription");
      }
      setError(null);
      setSubmitError(null);
      for (const payload of buildSubmittedTextPayloads(text)) {
        await sendWithAck(payload);
      }
      draftHistory.saveEntry(text);
    },
    [draftHistory, sendSessionMessage, sendWithAck, voiceAttachments],
  );

  const queueVoiceDraft = useCallback(
    async (text: string) => {
      await sendSessionMessage(text, voiceAttachments, { queue: true });
      setVoiceAttachments([]);
      if (text.trim()) {
        draftHistory.saveEntry(text);
      }
    },
    [draftHistory, sendSessionMessage, voiceAttachments],
  );

  const sendHotkey = useCallback(
    async (hotkey: (typeof hotkeys)[number]) => {
      try {
        if (hotkey.submit) {
          setSubmitError(null);
          for (const payload of buildSubmittedTextPayloads(hotkey.sequence)) {
            await sendWithAck(payload);
          }
          return;
        }
        sendTerminalInput(hotkey.sequence);
      } catch (hotkeyError) {
        setSubmitError(
          hotkeyError instanceof Error ? hotkeyError.message : "Failed to insert transcription",
        );
      }
    },
    [sendTerminalInput, sendWithAck],
  );

  const submitSlash = useCallback(
    async (text: string) => {
      try {
        setSubmitError(null);
        for (const payload of buildSubmittedTextPayloads(text)) {
          await sendWithAck(payload);
        }
      } catch (slashError) {
        setSubmitError(
          slashError instanceof Error ? slashError.message : "Failed to insert transcription",
        );
      }
    },
    [sendWithAck],
  );

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (hotkeysOpen && !hotkeyMenuRef.current?.contains(event.target)) {
        setHotkeysOpen(false);
      }
      if (arrowsOpen && !arrowMenuRef.current?.contains(event.target)) {
        setArrowsOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (hotkeysOpen) setHotkeysOpen(false);
      if (arrowsOpen) setArrowsOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [arrowsOpen, hotkeysOpen]);

  useEffect(() => {
    terminalLinksRef.current = [];
    discoveredTerminalLinksRef.current = [];
    setTerminalLinks([]);
    setTerminalLinksOpen(false);

    if (!terminalRef.current) return;

    let mounted = true;
    let terminal: TerminalType | null = null;
    let fit: FitAddonType | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let binaryDisposable: { dispose(): void } | null = null;
    let parsedWriteDisposable: { dispose(): void } | null = null;
    let terminalResizeDisposable: { dispose(): void } | null = null;
    let bufferChangeDisposable: { dispose(): void } | null = null;
    let resizeHandler: (() => void) | null = null;
    let touchCleanup: (() => void) | null = null;
    let reconnectTimer: number | null = null;
    let websocket: WebSocket | null = null;
    let closingForUnmount = false;

    Promise.all([
      import("xterm").then((module) => module.Terminal),
      import("@xterm/addon-fit").then((module) => module.FitAddon),
    ])
      .then(([Terminal, FitAddon]) => {
        if (!mounted || !terminalRef.current) return;

        terminal = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          fontFamily:
            'var(--font-mono), "JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          theme: getTerminalTheme(themeRef.current),
          minimumContrastRatio: 1,
          scrollback: 10_000,
          allowProposedApi: true,
        });
        terminalInstanceRef.current = terminal;

        fit = new FitAddon();
        terminal.loadAddon(fit);

        terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, () => {
          terminal?.write("\x1bP>|XTerm(370)\x1b\\");
          return true;
        });

        terminal.parser.registerOscHandler(52, (data) => {
          const parts = data.split(";");
          if (parts.length < 2) return false;
          const encoded = parts[parts.length - 1];
          if (!encoded) return false;
          try {
            const binary = atob(encoded);
            const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            const text = new TextDecoder().decode(bytes);
            void navigator.clipboard?.writeText(text);
          } catch {
            // Ignore invalid clipboard payloads.
          }
          return true;
        });

        terminal.open(terminalRef.current);
        terminal.focus();
        fit.fit();

        const scanTerminalLinks = (mode: "merge" | "keep" | "reset") => {
          if (!mounted || !terminal) return;
          const activeBuffer = terminal.buffer.active;
          const startIndex = Math.max(0, activeBuffer.length - 100);
          const rows = [];
          for (let index = startIndex; index < activeBuffer.length; index += 1) {
            const line = activeBuffer.getLine(index);
            rows.push(
              line
                ? {
                    text: line.translateToString(false, 0, terminal.cols),
                    isWrapped: line.isWrapped,
                  }
                : undefined,
            );
          }
          const scanned = extractTerminalLinks(rows, terminal.cols);

          if (mode === "reset") {
            discoveredTerminalLinksRef.current = [];
          }
          if (mode !== "keep") {
            discoveredTerminalLinksRef.current = mergeTerminalLinkDiscoveries(
              discoveredTerminalLinksRef.current,
              scanned,
              TERMINAL_LINK_DISCOVERY_LIMIT,
            );
          }

          const nextLinks = composeTerminalLinkDisplay(scanned, discoveredTerminalLinksRef.current);
          if (areTerminalLinksEqual(terminalLinksRef.current, nextLinks)) return;
          terminalLinksRef.current = nextLinks;
          setTerminalLinks(nextLinks);
          if (nextLinks.length === 0) setTerminalLinksOpen(false);
        };

        scanTerminalLinks("merge");
        parsedWriteDisposable = terminal.onWriteParsed(() => scanTerminalLinks("merge"));
        terminalResizeDisposable = terminal.onResize(() => scanTerminalLinks("keep"));
        bufferChangeDisposable = terminal.buffer.onBufferChange(() => scanTerminalLinks("reset"));

        // Touch scroll: convert vertical swipes into SGR mouse scroll sequences
        // using native drag semantics, so finger movement matches terminal content movement.
        const touchTarget =
          terminalRef.current.querySelector(".xterm-screen") ?? terminalRef.current;
        let touchStartY = 0;
        let touchAccum = 0;

        const onTouchStart = (e: Event) => {
          const te = e as TouchEvent;
          if (te.touches.length !== 1) return;
          touchStartY = te.touches[0].clientY;
          touchAccum = 0;
        };

        const onTouchMove = (e: Event) => {
          const te = e as TouchEvent;
          if (te.touches.length !== 1) return;
          const touch = te.touches[0];
          const dy = touchStartY - touch.clientY;
          touchAccum += dy;
          touchStartY = touch.clientY;

          const lines = Math.trunc(touchAccum / TOUCH_SCROLL_THRESHOLD);
          if (lines === 0) return;

          const rect = touchTarget.getBoundingClientRect();
          const cols = terminal?.cols;
          const rows = terminal?.rows;
          if (
            !Number.isFinite(rect.width) ||
            rect.width <= 0 ||
            !Number.isFinite(rect.height) ||
            rect.height <= 0 ||
            typeof cols !== "number" ||
            !Number.isFinite(cols) ||
            cols <= 0 ||
            typeof rows !== "number" ||
            !Number.isFinite(rows) ||
            rows <= 0 ||
            !Number.isFinite(touch.clientX) ||
            !Number.isFinite(touch.clientY)
          ) {
            return;
          }

          const column = Math.min(
            cols,
            Math.max(1, Math.ceil(((touch.clientX - rect.left) * cols) / rect.width)),
          );
          const row = Math.min(
            rows,
            Math.max(1, Math.ceil(((touch.clientY - rect.top) * rows) / rect.height)),
          );
          touchAccum -= lines * TOUCH_SCROLL_THRESHOLD;

          const up = lines < 0;
          const seq = sgrScroll(up, column, row);
          const count = Math.abs(lines);
          for (let i = 0; i < count; i++) {
            sendTerminalInput(seq);
          }
          te.preventDefault();
        };

        touchTarget.addEventListener("touchstart", onTouchStart, { passive: true });
        touchTarget.addEventListener("touchmove", onTouchMove, { passive: false });

        touchCleanup = () => {
          touchTarget.removeEventListener("touchstart", onTouchStart);
          touchTarget.removeEventListener("touchmove", onTouchMove);
        };

        const sendResize = () => {
          if (!terminal || !fit || websocket?.readyState !== WebSocket.OPEN) return;
          fit.fit();
          websocket.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
        };

        const clearReconnectTimer = () => {
          if (reconnectTimer === null) return;
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        };

        const scheduleReconnect = (message: string) => {
          if (!mounted || reconnectTimer !== null || closingForUnmount) return;
          setStatus("reconnecting");
          setError(message);
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, RECONNECT_DELAY_MS);
        };

        const connect = () => {
          if (!mounted || !terminal) return;
          const readyState = websocket?.readyState;
          if (readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN) return;
          clearReconnectTimer();

          setStatus((current) =>
            current === "connected" || current === "reconnecting" ? "reconnecting" : "connecting",
          );

          const nextSocket = new WebSocket(buildDirectTerminalWsUrl(window.location, sessionId));
          websocket = nextSocket;
          websocketRef.current = nextSocket;
          nextSocket.binaryType = "arraybuffer";

          nextSocket.onopen = () => {
            if (websocket !== nextSocket || !terminal) return;
            setStatus("connected");
            setError(null);
            terminal.focus();
            sendResize();
          };

          nextSocket.onmessage = (event) => {
            if (websocket !== nextSocket) return;
            const data =
              typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
            if (typeof data === "string" && data.startsWith("{")) {
              try {
                const parsed = JSON.parse(data) as InputAckMessage;
                if (parsed.type === "ack" && typeof parsed.id === "string") {
                  const pending = pendingAckRef.current;
                  if (pending?.id === parsed.id) {
                    clearPendingAckTimers(pending);
                    pendingAckRef.current = null;
                    pending.resolve();
                  }
                  return;
                }
              } catch {
                // Fall through to terminal output.
              }
            }
            terminal?.write(data);
          };

          nextSocket.onerror = () => {
            if (websocket !== nextSocket || !mounted) return;
            setStatus("reconnecting");
            setError("Terminal connection failed. Retrying…");
          };

          nextSocket.onclose = (event) => {
            if (websocket === nextSocket) {
              websocket = null;
              websocketRef.current = null;
            }
            if (!mounted || closingForUnmount) return;

            const message = event.reason || "Terminal disconnected";
            if (isRetryableClose(event.code)) {
              scheduleReconnect(`${message}. Retrying…`);
              return;
            }

            setStatus("error");
            setError(message);
          };
        };

        connect();

        resizeHandler = () => {
          sendResize();
        };

        const maybeRefreshConnection = () => {
          if (document.visibilityState === "hidden") return;
          connect();
        };

        inputDisposable = terminal.onData((data) => {
          if (websocket?.readyState === WebSocket.OPEN) {
            websocket.send(data);
          }
        });

        binaryDisposable = terminal.onBinary((data) => {
          if (websocket?.readyState === WebSocket.OPEN) {
            websocket.send(data);
          }
        });

        window.addEventListener("resize", resizeHandler);
        window.addEventListener("focus", maybeRefreshConnection);
        window.addEventListener("online", maybeRefreshConnection);
        document.addEventListener("visibilitychange", maybeRefreshConnection);

        touchCleanup = () => {
          touchTarget.removeEventListener("touchstart", onTouchStart);
          touchTarget.removeEventListener("touchmove", onTouchMove);
          window.removeEventListener("focus", maybeRefreshConnection);
          window.removeEventListener("online", maybeRefreshConnection);
          document.removeEventListener("visibilitychange", maybeRefreshConnection);
        };
      })
      .catch(() => {
        if (!mounted) return;
        setStatus("error");
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
      closingForUnmount = true;
      const pending = pendingAckRef.current;
      if (pending) {
        rejectPendingAck(pending, "Failed to insert transcription");
      }
      pendingAckRef.current = null;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
      }
      touchCleanup?.();
      inputDisposable?.dispose();
      binaryDisposable?.dispose();
      parsedWriteDisposable?.dispose();
      terminalResizeDisposable?.dispose();
      bufferChangeDisposable?.dispose();
      websocketRef.current?.close();
      websocketRef.current = null;
      terminal?.dispose();
      terminalInstanceRef.current = null;
    };
  }, [clearPendingAckTimers, rejectPendingAck, sendTerminalInput, sessionId]);

  // Swap the live xterm theme when the UI theme changes, without tearing
  // down the websocket connection (that effect intentionally excludes `theme`).
  useEffect(() => {
    themeRef.current = theme;
    const instance = terminalInstanceRef.current;
    if (!instance) return;
    instance.options.theme = getTerminalTheme(theme);
  }, [theme]);

  const terminalControlButtonClass =
    "flex h-8 items-center justify-center border border-[var(--color-border-strong)] px-2 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-[var(--color-hover-overlay)] sm:px-3";
  const terminalControlIconButtonClass =
    "flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-[var(--color-hover-overlay)] sm:w-10";
  const terminalFloatingControlIconButtonClass = cn(
    terminalControlIconButtonClass,
    "bg-[var(--color-bg-base)]",
  );
  const terminalFloatingVoiceButtonClass = cn(
    terminalFloatingControlIconButtonClass,
    "border-[var(--color-status-error)] text-[var(--color-status-error)]",
  );
  const terminalActiveVoiceButtonClass =
    "border-[var(--color-status-error)] bg-[var(--color-status-error)]/12 text-[var(--color-status-error)]";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-terminal-bg)]">
      <div
        className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2"
        data-testid="direct-terminal-header"
      >
        <TerminalStatusDot activity={activity} error={error} wsStatus={status} />
        {title ? (
          <div
            className="min-w-0 flex-1 overflow-hidden whitespace-normal text-[10px] leading-4 text-[var(--color-text-secondary)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]"
            data-testid="direct-terminal-header-title"
            title={title}
          >
            {title}
          </div>
        ) : null}
        {/* Never truncates: the title yields space, this label just butts against it. */}
        <div
          className="ml-auto shrink-0 whitespace-nowrap text-[10px] leading-4 text-[var(--color-text-tertiary)]"
          data-testid="direct-terminal-header-agent"
        >
          {getAgentDisplayName(agent)}
          {model ? ` • ${model}` : null}
        </div>
        {onClose ? (
          <button
            aria-label="Close terminal"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)]"
            onClick={onClose}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : null}
      </div>

      <div
        className="min-h-0 flex-1 p-1.5"
        data-testid="direct-terminal-surface"
        onPasteCapture={handleTerminalPaste}
      >
        <div ref={terminalRef} className="h-full min-h-0" />
      </div>
      {(voice.voiceError ?? submitError) ? (
        <div className="border-t border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-3 py-2 text-[var(--color-chip-error-text)]">
          {voice.voiceError ?? submitError}
        </div>
      ) : null}

      <div
        className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-bg-base)] py-1.5 pl-[max(0.5rem,env(safe-area-inset-left),env(safe-area-inset-bottom))] pr-[max(0.5rem,env(safe-area-inset-right),env(safe-area-inset-bottom))]"
        data-testid="direct-terminal-controls"
      >
        <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
          <div className="relative" ref={hotkeyMenuRef}>
            <button
              aria-expanded={hotkeysOpen}
              aria-haspopup="menu"
              aria-label={`Open ${agent} shortcuts`}
              className={cn(terminalControlButtonClass, "w-8 px-0 text-sm sm:w-10")}
              onClick={() => setHotkeysOpen((current) => !current)}
              type="button"
            >
              ...
            </button>
            {hotkeysOpen ? (
              <div
                aria-label={`${agent} shortcuts`}
                className="absolute bottom-9 left-0 z-20 flex max-h-72 min-w-[18rem] flex-col overflow-y-auto border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] p-1 shadow-[0_8px_30px_var(--color-shadow-menu)]"
                role="menu"
              >
                <div className="border-b border-[var(--color-border-subtle)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  {getAgentDisplayName(agent)}
                </div>
                {hotkeys.map((hotkey) => (
                  <button
                    className="grid w-full grid-cols-[1fr_auto] gap-x-3 border-b border-[var(--color-border-subtle)] px-2 py-2 text-left transition last:border-b-0 hover:bg-[var(--color-hover-overlay)]"
                    key={hotkey.id}
                    onClick={() => {
                      void sendHotkey(hotkey);
                      setHotkeysOpen(false);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-bold uppercase text-[var(--color-text-primary)]">
                        {hotkey.label}
                      </span>
                      <span className="block text-[10px] text-[var(--color-text-secondary)]">
                        {hotkey.detail}
                      </span>
                    </span>
                    {hotkey.shortcut ? (
                      <span className="self-start font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent)]">
                        {hotkey.shortcut}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <SlashSuggestions
            buttonClassName={cn(terminalControlButtonClass, "text-[10px] tracking-[0.1em]")}
            endpoint={
              agentInputEnabled
                ? `/api/sessions/${encodeURIComponent(sessionApiId)}/slash-commands`
                : null
            }
            onSelect={(entry) => void submitSlash(entry.insertText)}
          />
          <button
            className={cn(terminalControlButtonClass, "font-mono text-[10px] tracking-[0.1em]")}
            onClick={() => sendTerminalInput("\r")}
            type="button"
          >
            Enter
          </button>
          {terminalLinks.length > 0 ? (
            <div className="shrink-0" ref={terminalLinksMenu.containerRef}>
              <button
                aria-controls="terminal-links-panel"
                aria-expanded={terminalLinksOpen}
                aria-label="Open terminal links"
                className={cn(
                  terminalControlButtonClass,
                  "gap-1 px-2 text-[10px] focus-visible:border-[var(--color-accent)] focus-visible:text-[var(--color-accent)] focus-visible:outline-none",
                  terminalLinksOpen &&
                    "border-[var(--color-accent)] bg-[var(--color-hover-overlay)] text-[var(--color-accent)]",
                )}
                onClick={() => setTerminalLinksOpen((current) => !current)}
                ref={terminalLinksMenu.buttonRef}
                type="button"
              >
                <ChainLinkIcon />
                <span>{terminalLinks.length}</span>
              </button>
              {terminalLinksOpen ? (
                <div
                  aria-label="Terminal links"
                  className="fixed z-30 max-h-[min(24rem,calc(100vh-1rem))] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] p-1 shadow-[0_8px_30px_var(--color-shadow-menu)]"
                  id="terminal-links-panel"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setTerminalLinksOpen(false);
                    terminalLinksMenu.buttonRef.current?.focus();
                  }}
                  ref={terminalLinksMenu.menuRef}
                  role="region"
                  style={terminalLinksMenu.menuStyle}
                >
                  <ul>
                    {terminalLinks.map((link) => (
                      <li
                        className="border-b border-[var(--color-border-subtle)] last:border-b-0"
                        key={link.url}
                      >
                        <a
                          className="block min-w-0 px-2 py-2 transition hover:bg-[var(--color-hover-overlay)] focus-visible:bg-[var(--color-hover-overlay)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]"
                          href={link.url}
                          onClick={() => setTerminalLinksOpen(false)}
                          rel="noopener noreferrer"
                          target="_blank"
                          title={link.url}
                        >
                          <span className="block truncate font-bold text-[var(--color-text-primary)]">
                            {link.hostname}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-[var(--color-text-secondary)]">
                            {link.url}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="relative ml-auto" ref={arrowMenuRef}>
            <button
              aria-expanded={arrowsOpen}
              aria-haspopup="menu"
              aria-label="Open arrow controls"
              className={terminalControlIconButtonClass}
              onClick={() => setArrowsOpen((current) => !current)}
              type="button"
            >
              <FourDirectionArrowIcon />
            </button>
            {arrowsOpen ? (
              <div
                aria-label="Arrow controls"
                className="absolute bottom-9 right-0 z-20 flex flex-col items-end gap-1"
                role="menu"
              >
                {TERMINAL_ARROW_CONTROLS.map((arrow) => (
                  <button
                    aria-label={arrow.label}
                    className={terminalFloatingControlIconButtonClass}
                    key={arrow.label}
                    onClick={() => sendTerminalInput(arrow.sequence)}
                    role="menuitem"
                    type="button"
                  >
                    <ArrowIcon path={arrow.iconPath} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative ml-2">
            {voice.recording && !voice.voiceModalOpen ? (
              <div className="absolute bottom-9 right-0 z-20 flex flex-col items-end gap-1">
                <button
                  aria-label="Edit voice transcript"
                  className={terminalFloatingVoiceButtonClass}
                  onClick={voice.toggleRecording}
                  type="button"
                >
                  <PencilIcon />
                </button>
                <button
                  aria-label="Send voice to queue"
                  className={terminalFloatingVoiceButtonClass}
                  onClick={() => voice.stopAndSend(queueVoiceDraft)}
                  type="button"
                >
                  <QueueIcon />
                </button>
                <button
                  aria-label="Stop and send voice"
                  aria-keyshortcuts="Meta+."
                  className={terminalFloatingVoiceButtonClass}
                  onClick={() => voice.stopAndSend(submitVoiceDraft)}
                  title="Stop and send voice"
                  type="button"
                >
                  <StopSquareIcon />
                </button>
              </div>
            ) : null}
            {voice.recording && !voice.voiceModalOpen ? (
              <button
                aria-label="Cancel voice recording"
                aria-keyshortcuts="Meta+."
                className={cn(terminalControlIconButtonClass, terminalActiveVoiceButtonClass)}
                onClick={() => {
                  setVoiceAttachments([]);
                  voice.cancelRecording();
                }}
                title="Cancel voice recording"
                type="button"
              >
                <CancelIcon />
              </button>
            ) : voice.recording && voice.voiceModalOpen ? null : (
              <VoiceControls
                voice={voice}
                className={cn(
                  terminalControlIconButtonClass,
                  voice.voiceBusy === "transcribing" && terminalActiveVoiceButtonClass,
                )}
                groupClassName="absolute bottom-0 right-0 z-20 flex flex-col items-end gap-1"
                onRetrySend={submitVoiceDraft}
                slotClassName="relative h-8 w-8 sm:w-10"
              />
            )}
          </div>
        </div>
      </div>
      <VoiceConfirmModal
        attachments={voiceAttachments}
        historyEntries={draftHistory.entries}
        onAddFiles={agentInputEnabled ? addVoiceImageFiles : undefined}
        onDismiss={() => setVoiceAttachments([])}
        onInsert={submitVoiceDraft}
        onQueue={queueVoiceDraft}
        onRemoveAttachment={(index) =>
          setVoiceAttachments((current) =>
            current.filter((_, currentIndex) => currentIndex !== index),
          )
        }
        voice={voice}
      />
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
