import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir, userInfo } from "node:os";
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
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function readHost(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
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

export function createDirectTerminalServer(tmuxPath = findTmux()) {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }) + "\n");
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const sessions = new Map<string, TerminalSession>();

  wss.on("connection", (ws, request) => {
    if (!ptySpawn) {
      ws.close(1011, "node-pty is not installed");
      return;
    }

    const sessionId = readSessionId(request.url);
    if (!sessionId || !validateSessionId(sessionId)) {
      ws.close(1008, "Invalid session id");
      return;
    }

    if (!tmuxSessionExists(tmuxPath, sessionId)) {
      ws.close(4004, "Session not found");
      return;
    }

    const mouseProcess = spawn(tmuxPath, [
      ...tmuxSocketArgs(),
      "set-option",
      "-t",
      `=${sessionId}`,
      "mouse",
      "on",
    ]);
    mouseProcess.on("error", () => {
      // Best effort only.
    });

    const statusProcess = spawn(tmuxPath, [
      ...tmuxSocketArgs(),
      "set-option",
      "-t",
      `=${sessionId}`,
      "status",
      "off",
    ]);
    statusProcess.on("error", () => {
      // Best effort only.
    });

    const pty = ptySpawn(tmuxPath, [...tmuxSocketArgs(), "attach-session", "-t", `=${sessionId}`], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env["HOME"] || homedir(),
      env: createTerminalEnvironment(),
    });

    sessions.set(sessionId, { sessionId, pty, ws });

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
          const parsed = JSON.parse(message) as { type?: string; cols?: number; rows?: number };
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows);
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
    server,
    wss,
    close() {
      for (const session of sessions.values()) {
        session.ws.close();
        session.pty.kill();
      }
      sessions.clear();
      wss.close();
      server.close();
    },
  };
}

const port = parsePort(
  process.env["DIRECT_TERMINAL_BIND_PORT"] ?? process.env["DIRECT_TERMINAL_PORT"],
  14801,
);
const host = readHost(process.env["DIRECT_TERMINAL_BIND_HOST"], "127.0.0.1");
const shouldListen = import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (shouldListen) {
  const { server } = createDirectTerminalServer();
  server.listen(port, host, () => {
    process.stdout.write(`[direct-terminal] listening on ${host}:${port}\n`);
  });
}
