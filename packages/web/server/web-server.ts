import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import nextImport from "next";
import { attachDirectTerminalWebSocket, DIRECT_TERMINAL_WS_PATH } from "./direct-terminal-ws.js";

// Next ships a CommonJS module; under Node16 ESM interop the callable factory is
// the default export at runtime but is typed as the module namespace. Re-type it.
const next = nextImport as unknown as typeof import("next").default;
import { readSpurInstanceRuntimeConfig } from "./spur-instance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");

function readHost(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

const instanceConfig = readSpurInstanceRuntimeConfig();
const host = readHost(process.env["WEB_HOST"], "0.0.0.0");
const port = readPort(process.env["PORT"], instanceConfig.uiPort);

// The Next route handlers read these from the environment; default them from the
// resolved Spur instance config so a bare `node web-server.js` works standalone.
process.env["SPUR_DAEMON_URL"] ||= instanceConfig.daemonUrl;
process.env["SPUR_TMUX_SOCKET_NAME"] ||= instanceConfig.tmuxSocketName;
process.env["SPUR_CONFIG"] ||= instanceConfig.configPath;

const dev = process.env["NODE_ENV"] !== "production";
const app = next({ dev, dir: pkgRoot, hostname: host, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  void handle(request, response);
});

// Terminal WebSocket shares this server on `/ws`; no separate port or proxy config.
attachDirectTerminalWebSocket(server);

if (dev) {
  // Forward Next's HMR upgrade (everything except the terminal path) in dev.
  const upgrade = app.getUpgradeHandler();
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "ws://127.0.0.1");
    if (pathname === DIRECT_TERMINAL_WS_PATH) return;
    void upgrade(request, socket, head);
  });
}

server.listen(port, host, () => {
  process.stdout.write(`[web] listening on ${host}:${port} (dev=${dev})\n`);
});
