/**
 * Unified Next.js + DirectTerminal server.
 *
 * Runs Next.js and the DirectTerminal WebSocket on the same HTTP port,
 * so remote access through a single Tailscale/proxy endpoint works for
 * both the dashboard and terminal WebSocket connections.
 *
 * WebSocket path: /terminal/ws?session=<sessionId>
 */

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { createDirectTerminalWss } from "./direct-terminal-ws.js";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });

  // Attach DirectTerminal WebSocket — serves /terminal/ws on the same port
  const { wss, shutdown: shutdownTerminal } = createDirectTerminalWss();

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url || "");
    if (pathname === "/terminal/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
    // Other upgrade requests (Next.js HMR) are handled by Next.js internally
  });

  server.listen(port, hostname, () => {
    console.log(`[Server] Ready on http://${hostname}:${port}`);
    console.log(`[Server] DirectTerminal WebSocket at ws://${hostname}:${port}/terminal/ws`);
  });

  function handleShutdown(signal: string) {
    console.log(`[Server] Received ${signal}, shutting down...`);
    shutdownTerminal();
    server.close();
    const forceExitTimer = setTimeout(() => {
      console.error("[Server] Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();
  }

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
});
