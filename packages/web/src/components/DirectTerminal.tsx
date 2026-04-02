"use client";

import { useEffect, useRef, useState } from "react";
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
}

interface RuntimeTerminalConfig {
  directTerminalPort?: unknown;
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

function normalizePortValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) return undefined;
  return String(parsed);
}

async function readTerminalPort(): Promise<string> {
  try {
    const response = await fetch("/api/runtime/terminal", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as RuntimeTerminalConfig;
    return normalizePortValue(payload.directTerminalPort) ?? "14801";
  } catch {
    return "14801";
  }
}

export function buildDirectTerminalWsUrl(
  location: TerminalLocation,
  port: string,
  sessionId: string,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.hostname}:${port}/ws?session=${encodeURIComponent(sessionId)}`;
}

export function DirectTerminal({ sessionId, label, title, onClose }: DirectTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<TerminalType | null>(null);
  const fitAddon = useRef<FitAddonType | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    let mounted = true;
    let terminal: TerminalType | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let resizeHandler: (() => void) | null = null;

    Promise.all([
      import("xterm").then((module) => module.Terminal),
      import("@xterm/addon-fit").then((module) => module.FitAddon),
    ])
      .then(async ([Terminal, FitAddon]) => {
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

        const fit = new FitAddon();
        fitAddon.current = fit;
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
        terminalInstance.current = terminal;
        fit.fit();

        const port = await readTerminalPort();
        if (!mounted) return;

        const wsUrl = buildDirectTerminalWsUrl(window.location, port, sessionId);
        const websocket = new WebSocket(wsUrl);
        websocketRef.current = websocket;
        websocket.binaryType = "arraybuffer";

        websocket.onopen = () => {
          if (!terminal) return;
          setStatus("connected");
          setError(null);
          websocket.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
        };

        websocket.onmessage = (event) => {
          const data =
            typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
          terminal?.write(data);
        };

        websocket.onerror = () => {
          setStatus("error");
          setError("Terminal connection failed");
        };

        websocket.onclose = (event) => {
          if (!mounted) return;
          setStatus("error");
          setError(event.reason || "Terminal disconnected");
        };

        inputDisposable = terminal.onData((data) => {
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(data);
          }
        });

        resizeHandler = () => {
          if (!terminal || websocket.readyState !== WebSocket.OPEN) return;
          fit.fit();
          websocket.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
        };

        window.addEventListener("resize", resizeHandler);
      })
      .catch(() => {
        setStatus("error");
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
      }
      inputDisposable?.dispose();
      websocketRef.current?.close();
      terminal?.dispose();
      terminalInstance.current = null;
      fitAddon.current = null;
    };
  }, [sessionId]);

  const statusDotClass =
    status === "connected"
      ? "bg-[var(--color-status-ready)]"
      : status === "error"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    status === "connected" ? "Connected" : status === "error" ? (error ?? "Error") : "Connecting…";

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
            className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
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

      <div ref={terminalRef} className="min-h-0 flex-1 p-1.5" />
    </div>
  );
}
