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

app.prepare().then(() => {
  const handle = app.getRequestHandler();
  const handleUpgrade = app.getUpgradeHandler();

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
      return;
    }

    // Delegate all non-terminal upgrades (e.g. Next.js HMR) back to Next.
    void handleUpgrade(req, socket, head).catch((err) => {
      console.error("[Server] Failed to handle upgrade:", err);
      socket.destroy();
    });
  });

  server.listen(port, hostname, () => {
    console.log(`[Server] Ready on http://${hostname}:${port}`);
    console.log(`[Server] DirectTerminal WebSocket at ws://${hostname}:${port}/terminal/ws`);
  });

  let shuttingDown = false;

  function handleShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[Server] Received ${signal}, shutting down...`);
    const forceExitTimer = setTimeout(() => {
      console.error("[Server] Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    shutdownTerminal();
    server.close((err) => {
      if (err) {
        console.error("[Server] Failed to close HTTP server:", err);
      }
      clearTimeout(forceExitTimer);
      void app.close().finally(() => {
        process.exit(err ? 1 : 0);
      });
    });
  }

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
});
