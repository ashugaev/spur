"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { useInputHistory } from "@/hooks/useInputHistory";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { VoiceButton, VoiceConfirmModal } from "@/components/VoiceInput";
import "xterm/css/xterm.css";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { Terminal as TerminalType } from "xterm";
import { TERMINAL_THEME } from "@/design/colors";
import { cn } from "@/lib/cn";
import { getAgentHotkeys } from "@/lib/agent-hotkeys";
import { agentUsesBracketedPaste, getAgentDisplayName, type AgentName } from "@/lib/agents";

interface DirectTerminalProps {
  sessionId: string;
  agent?: AgentName;
  label?: string;
  title?: string;
  onClose?: () => void;
}

interface TerminalLocation {
  protocol: string;
  hostname: string;
  port: string;
}

interface DirectTerminalConfig {
  directTerminalPort?: string | number;
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

function isRetryableClose(code: number): boolean {
  return code !== 1000 && code !== 1008 && code !== 4004;
}

function normalizeTerminalPort(value: string | number | undefined, fallback: string): string {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= 65535 ? String(value) : fallback;
  }
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? String(parsed) : fallback;
}

function buildSubmittedTextPayloads(agent: AgentName, text: string): string[] {
  if (!agentUsesBracketedPaste(agent)) {
    return [`${text}\r`];
  }
  return [`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`, "\r"];
}

export function buildDirectTerminalWsUrl(
  location: TerminalLocation,
  sessionId: string,
  portOverride?: string | number,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const port = normalizeTerminalPort(portOverride, location.port);
  const portSuffix = port ? `:${port}` : "";
  return `${protocol}//${location.hostname}${portSuffix}/ws?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Build an SGR mouse scroll sequence.
 * Button 64 = scroll up, 65 = scroll down.  Position (1,1) is fine — tmux
 * only cares about the button for WheelUpPane / WheelDownPane.
 */
function sgrScroll(up: boolean): string {
  const button = up ? 64 : 65;
  return `\x1b[<${button};1;1M`;
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
  agent = "claude",
  label,
  title,
  onClose,
}: DirectTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const hotkeyMenuRef = useRef<HTMLDivElement>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const inputSeqRef = useRef(0);
  const pendingAckRef = useRef<PendingInputAck | null>(null);
  const hotkeys = getAgentHotkeys(agent);
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "error">(
    "connecting",
  );
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

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

  const voice = useVoiceInput();
  const draftHistory = useInputHistory(TERMINAL_DRAFT_HISTORY_STORAGE_KEY);

  const submitVoiceDraft = useCallback(
    async (text: string) => {
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
      for (const payload of buildSubmittedTextPayloads(agent, text)) {
        await sendWithAck(payload);
      }
      draftHistory.saveEntry(text);
    },
    [agent, draftHistory, sendWithAck],
  );

  const sendHotkey = useCallback(
    async (hotkey: (typeof hotkeys)[number]) => {
      try {
        if (hotkey.submit) {
          setSubmitError(null);
          for (const payload of buildSubmittedTextPayloads(agent, hotkey.sequence)) {
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
    [agent, sendTerminalInput, sendWithAck],
  );

  const submitSlash = useCallback(
    async (text: string) => {
      try {
        setSubmitError(null);
        for (const payload of buildSubmittedTextPayloads(agent, text)) {
          await sendWithAck(payload);
        }
      } catch (slashError) {
        setSubmitError(
          slashError instanceof Error ? slashError.message : "Failed to insert transcription",
        );
      }
    },
    [agent, sendWithAck],
  );

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!hotkeysOpen) return;
      if (hotkeyMenuRef.current?.contains(event.target as Node)) return;
      setHotkeysOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (!hotkeysOpen || event.key !== "Escape") return;
      setHotkeysOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [hotkeysOpen]);

  useEffect(() => {
    if (!terminalRef.current) return;

    let mounted = true;
    let terminal: TerminalType | null = null;
    let fit: FitAddonType | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let binaryDisposable: { dispose(): void } | null = null;
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
          theme: TERMINAL_THEME,
          minimumContrastRatio: 1,
          scrollback: 10_000,
          allowProposedApi: true,
        });

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
          const dy = touchStartY - te.touches[0].clientY;
          touchAccum += dy;
          touchStartY = te.touches[0].clientY;

          const lines = Math.trunc(touchAccum / TOUCH_SCROLL_THRESHOLD);
          if (lines === 0) return;
          touchAccum -= lines * TOUCH_SCROLL_THRESHOLD;

          const up = lines < 0;
          const seq = sgrScroll(up);
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

        let directTerminalPort: string | number | undefined;

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

        const connect = async () => {
          if (!mounted || !terminal) return;
          const readyState = websocket?.readyState;
          if (readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN) return;
          clearReconnectTimer();

          setStatus((current) =>
            current === "connected" || current === "reconnecting" ? "reconnecting" : "connecting",
          );

          if (directTerminalPort === undefined) {
            try {
              const response = await fetch("/api/runtime/terminal", { cache: "no-store" });
              if (response.ok) {
                const payload = (await response.json()) as DirectTerminalConfig;
                directTerminalPort = payload.directTerminalPort;
              }
            } catch {
              // Fall back to the current page port when the terminal config request fails.
            }
          }

          const nextSocket = new WebSocket(
            buildDirectTerminalWsUrl(window.location, sessionId, directTerminalPort),
          );
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
      websocketRef.current?.close();
      websocketRef.current = null;
      terminal?.dispose();
    };
  }, [clearPendingAckTimers, rejectPendingAck, sendTerminalInput, sessionId]);

  const statusDotClass =
    status === "connected"
      ? "bg-[var(--color-status-ready)]"
      : status === "error"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    status === "connected"
      ? "Connected"
      : status === "reconnecting"
        ? (error ?? "Reconnecting…")
        : status === "error"
          ? (error ?? "Error")
          : "Connecting…";
  const terminalControlButtonClass =
    "flex h-8 items-center justify-center border border-[var(--color-border-strong)] px-3 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-[var(--color-hover-overlay)]";
  const terminalControlIconButtonClass =
    "flex h-8 w-10 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-[var(--color-hover-overlay)]";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-terminal-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
        <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
        <div className="min-w-0">
          <div className="truncate font-mono text-[10px] text-[var(--color-accent)]">
            {label ?? sessionId}
          </div>
          {title ? (
            <div className="truncate text-[10px] text-[var(--color-text-secondary)]">{title}</div>
          ) : null}
        </div>
        <div className="ml-auto text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
          {statusText}
        </div>
        {onClose ? (
          <button
            aria-label="Close terminal"
            className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-sm text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)]"
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

      <div className="min-h-0 flex-1 p-1.5">
        <div ref={terminalRef} className="h-full min-h-0" />
      </div>
      {(voice.voiceError ?? submitError) ? (
        <div className="border-t border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-3 py-2 text-[var(--color-chip-error-text)]">
          {voice.voiceError ?? submitError}
        </div>
      ) : null}

      <div className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1.5">
        <div className="flex items-center gap-1">
          <div className="relative" ref={hotkeyMenuRef}>
            <button
              aria-expanded={hotkeysOpen}
              aria-haspopup="menu"
              aria-label={`Open ${agent} shortcuts`}
              className={cn(terminalControlButtonClass, "w-10 px-0 text-sm")}
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
            endpoint={`/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`}
            onSelect={(entry) => void submitSlash(entry.insertText)}
          />
          <button
            className={cn(terminalControlButtonClass, "font-mono text-[10px] tracking-[0.1em]")}
            onClick={() => sendTerminalInput("\r")}
            type="button"
          >
            Enter
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              aria-label="Arrow Left"
              className={terminalControlIconButtonClass}
              onClick={() => sendTerminalInput("\x1b[D")}
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              aria-label="Arrow Up"
              className={terminalControlIconButtonClass}
              onClick={() => sendTerminalInput("\x1b[A")}
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M5 15l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              aria-label="Arrow Down"
              className={terminalControlIconButtonClass}
              onClick={() => sendTerminalInput("\x1b[B")}
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              aria-label="Arrow Right"
              className={terminalControlIconButtonClass}
              onClick={() => sendTerminalInput("\x1b[C")}
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <VoiceButton voice={voice} className={cn(terminalControlIconButtonClass, "ml-2")} />
        </div>
      </div>
      <VoiceConfirmModal
        historyEntries={draftHistory.entries}
        onInsert={submitVoiceDraft}
        voice={voice}
      />
    </div>
  );
}
