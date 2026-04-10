"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { VoiceButton, VoiceConfirmModal } from "@/components/VoiceInput";
import "xterm/css/xterm.css";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { ITheme, Terminal as TerminalType } from "xterm";
import { cn } from "@/lib/cn";

interface DirectTerminalProps {
  sessionId: string;
  label?: string;
  title?: string;
  onClose?: () => void;
}

interface TerminalLocation {
  protocol: string;
  hostname: string;
  port: string;
}

const terminalTheme: ITheme = {
  background: "#0a0a0f",
  foreground: "#d4d4d8",
  cursor: "#5b7ef8",
  cursorAccent: "#0a0a0f",
  selectionBackground: "rgba(91, 126, 248, 0.3)",
  selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
  black: "#1a1a24",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#5b7ef8",
  magenta: "#a371f7",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#50506a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#7b9cfb",
  brightMagenta: "#c084fc",
  brightCyan: "#67e8f9",
  brightWhite: "#eeeef5",
};

/** Pixels of touch movement that count as one scroll line. */
const TOUCH_SCROLL_THRESHOLD = 20;
const RECONNECT_DELAY_MS = 1_000;
const VISIBILITY_REFRESH_AFTER_MS = 1_000;

function isRetryableClose(code: number): boolean {
  return code !== 1000 && code !== 1008 && code !== 4004;
}

export function buildDirectTerminalWsUrl(
  location: TerminalLocation,
  sessionId: string,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const portSuffix = location.port ? `:${location.port}` : "";
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

export function DirectTerminal({ sessionId, label, title, onClose }: DirectTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  const sendTerminalInput = useCallback((data: string): boolean => {
    if (websocketRef.current?.readyState !== WebSocket.OPEN) return false;
    websocketRef.current.send(data);
    return true;
  }, []);

  const voice = useVoiceInput();

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
    let hiddenAt: number | null = null;
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
          fontSize: 13,
          fontFamily:
            'var(--font-mono), "JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          theme: terminalTheme,
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
        const touchTarget = terminalRef.current.querySelector(".xterm-screen") ?? terminalRef.current;
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

        const wsUrl = buildDirectTerminalWsUrl(window.location, sessionId);
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

        const connect = (force = false) => {
          if (!mounted || !terminal) return;
          const readyState = websocket?.readyState;
          if (
            !force &&
            (readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN)
          ) {
            return;
          }
          clearReconnectTimer();
          if (force && websocket && websocket.readyState < WebSocket.CLOSING) {
            websocket.onopen = null;
            websocket.onmessage = null;
            websocket.onerror = null;
            websocket.onclose = null;
            websocket.close();
          }

          setStatus((current) => (current === "connected" || current === "reconnecting" ? "reconnecting" : "connecting"));
          const nextSocket = new WebSocket(wsUrl);
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
          const wasHiddenLongEnough =
            hiddenAt !== null && Date.now() - hiddenAt >= VISIBILITY_REFRESH_AFTER_MS;
          hiddenAt = null;

          if (wasHiddenLongEnough) {
            connect(true);
            return;
          }

          if (!websocket || websocket.readyState === WebSocket.CLOSED) {
            connect();
          }
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

        const handleVisibilityChange = () => {
          if (document.visibilityState === "hidden") {
            hiddenAt = Date.now();
            return;
          }
          maybeRefreshConnection();
        };

        window.addEventListener("resize", resizeHandler);
        window.addEventListener("focus", maybeRefreshConnection);
        window.addEventListener("online", maybeRefreshConnection);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        touchCleanup = () => {
          touchTarget.removeEventListener("touchstart", onTouchStart);
          touchTarget.removeEventListener("touchmove", onTouchMove);
          window.removeEventListener("focus", maybeRefreshConnection);
          window.removeEventListener("online", maybeRefreshConnection);
          document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
      })
      .catch(() => {
        setStatus("error");
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
      closingForUnmount = true;
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
  }, [sessionId]);

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
    "flex h-8 items-center justify-center border border-[var(--color-border-strong)] px-3 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-white/5";
  const terminalControlIconButtonClass =
    "flex h-8 w-10 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-white/5";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border border-[var(--color-border-default)] bg-[#0a0a0f]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
        <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-[var(--color-accent)]">
            {label ?? sessionId}
          </div>
          {title ? (
            <div className="truncate text-[11px] text-[var(--color-text-secondary)]">{title}</div>
          ) : null}
        </div>
        <div className="ml-auto text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
          {statusText}
        </div>
        {onClose ? (
          <button
            aria-label="Close terminal"
            className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-sm text-[var(--color-text-secondary)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
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
      {voice.voiceError ? (
        <div className="border-t border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-red-100">
          {voice.voiceError}
        </div>
      ) : null}

      <div className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1.5">
        <div className="flex items-center gap-1">
          <button
            className={cn(terminalControlButtonClass, "font-mono text-[10px] tracking-[0.1em]")}
            onClick={() => sendTerminalInput("\x1b")}
            type="button"
          >
            Esc
          </button>
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
      <VoiceConfirmModal voice={voice} onInsert={(text) => sendTerminalInput(text)} />
    </div>
  );
}
