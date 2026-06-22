import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nextImport from "next";
import { attachDirectTerminalWebSocket } from "./direct-terminal-ws.js";
import { readSpurInstanceRuntimeConfig } from "./spur-instance.js";

// Next ships a CommonJS module; under Node16 ESM interop the callable factory is
// the default export at runtime but is typed as the module namespace. Re-type it.
type NextFactory = (typeof nextImport)["default"];
const next = nextImport as unknown as NextFactory;

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
// Default to loopback; widening to all interfaces must be an explicit WEB_HOST
// opt-in since the terminal WebSocket (unauthenticated tmux attach) rides this port.
const host = readHost(process.env["WEB_HOST"], "127.0.0.1");
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

// Terminal WebSocket shares this server on `/ws` (no separate port or proxy config).
// In dev, non-terminal upgrades (Next HMR) are forwarded to Next's own handler.
const devUpgrade = dev ? app.getUpgradeHandler() : undefined;
attachDirectTerminalWebSocket(server, {
  fallbackUpgrade: devUpgrade
    ? (request, socket, head) => void devUpgrade(request, socket, head)
    : undefined,
});

server.listen(port, host, () => {
  process.stdout.write(`[web] listening on ${host}:${port} (dev=${dev})\n`);
});
