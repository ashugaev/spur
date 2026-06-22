import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir, userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { findTmux, tmuxSessionExists, tmuxSocketArgs, validateSessionId } from "./tmux-utils.js";

interface Pty {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  kill(): void;
}

type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => Pty;

let ptySpawn: PtySpawn | undefined;

try {
  const nodePty = await import("node-pty");
  ptySpawn = nodePty.spawn;
} catch {
  console.warn("[direct-terminal] node-pty is unavailable; web terminal connections will fail");
}

interface TerminalSession {
  sessionId: string;
  pty: Pty;
  ws: WebSocket;
  seenInputIds: Set<string>;
}

interface ResizeMessage {
  type: "resize";
  cols?: number;
  rows?: number;
}

interface InputMessage {
  type: "input";
  id?: string;
  data?: string;
}

function readSessionId(urlValue: string | undefined): string | null {
  const url = new URL(urlValue ?? "/", "ws://127.0.0.1");
  const sessionId = url.searchParams.get("session")?.trim();
  return sessionId ? sessionId : null;
}

function createTerminalEnvironment(): Record<string, string> {
  return {
    HOME: process.env["HOME"] || homedir(),
    SHELL: process.env["SHELL"] || "/bin/zsh",
    USER: process.env["USER"] || userInfo().username,
    PATH: process.env["PATH"] || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: process.env["LANG"] || "en_US.UTF-8",
    TMPDIR: process.env["TMPDIR"] || "/tmp",
  };
}

export const DIRECT_TERMINAL_WS_PATH = "/ws";

export function attachDirectTerminalWebSocket(server: Server, tmuxPath = findTmux()) {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, TerminalSession>();

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "ws://127.0.0.1");
    if (pathname !== DIRECT_TERMINAL_WS_PATH) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
  server.on("upgrade", handleUpgrade);

  wss.on("connection", (ws, request) => {
    if (!ptySpawn) {
      console.warn("[direct-terminal] close: node-pty not installed");
      ws.close(1011, "node-pty is not installed");
      return;
    }

    const sessionId = readSessionId(request.url);
    if (!sessionId || !validateSessionId(sessionId)) {
      console.warn("[direct-terminal] close: invalid session id:", sessionId ?? "(none)");
      ws.close(1008, "Invalid session id");
      return;
    }

    if (!tmuxSessionExists(tmuxPath, sessionId)) {
      console.warn("[direct-terminal] close: tmux session not found:", sessionId);
      ws.close(4004, "Session not found");
      return;
    }

    // Ensure mouse mode is enabled for the session before attaching.
    // This allows xterm.js to correctly handle wheel scrolling as mouse sequences.
    try {
      const socketArgs = tmuxSocketArgs();
      execFileSync(tmuxPath, [...socketArgs, "set-option", "-t", `=${sessionId}`, "mouse", "on"]);
      // Bind scroll-up to enter copy mode so wheel scrolls through history.
      execFileSync(tmuxPath, [
        ...socketArgs,
        "bind-key",
        "-n",
        "WheelUpPane",
        "if-shell",
        "-F",
        "-t",
        "=",
        "#{mouse_any_flag}",
        "send-keys -M",
        "if -Ft= '#{pane_in_mode}' 'send-keys -M' 'copy-mode -e; send-keys -M'",
      ]);
    } catch {
      // Best effort only.
    }

    const pty = ptySpawn(tmuxPath, [...tmuxSocketArgs(), "attach-session", "-t", `=${sessionId}`], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env["HOME"] || homedir(),
      env: createTerminalEnvironment(),
    });

    sessions.set(sessionId, { sessionId, pty, ws, seenInputIds: new Set() });
    console.log("[direct-terminal] attached:", sessionId);

    pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    pty.onExit(({ exitCode }) => {
      if (sessions.get(sessionId)?.pty === pty) {
        sessions.delete(sessionId);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, `Terminal ended (${exitCode})`);
      }
    });

    ws.on("message", (data) => {
      const message = data.toString("utf8");
      if (message.startsWith("{")) {
        try {
          const parsed = JSON.parse(message) as ResizeMessage | InputMessage;
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows);
            return;
          }
          if (
            parsed.type === "input" &&
            typeof parsed.id === "string" &&
            typeof parsed.data === "string"
          ) {
            const session = sessions.get(sessionId);
            if (!session) {
              return;
            }
            if (!session.seenInputIds.has(parsed.id)) {
              session.seenInputIds.add(parsed.id);
              pty.write(parsed.data);
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ack", id: parsed.id }));
            }
            return;
          }
        } catch {
          // Fall through to normal terminal input.
        }
      }
      pty.write(message);
    });

    ws.on("close", () => {
      if (sessions.get(sessionId)?.pty === pty) {
        sessions.delete(sessionId);
      }
      pty.kill();
    });

    ws.on("error", () => {
      if (sessions.get(sessionId)?.pty === pty) {
        sessions.delete(sessionId);
      }
      pty.kill();
    });
  });

  return {
    wss,
    close() {
      server.off("upgrade", handleUpgrade);
      for (const session of sessions.values()) {
        session.ws.close();
        session.pty.kill();
      }
      sessions.clear();
      wss.close();
    },
  };
}

/** Test helper: attach the terminal WebSocket to a standalone HTTP server. */
export function createDirectTerminalServer(tmuxPath = findTmux()) {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end("Not found");
  });
  const { wss, close } = attachDirectTerminalWebSocket(server, tmuxPath);
  return {
    server,
    wss,
    close() {
      close();
      server.close();
    },
  };
}
