import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nextImport from "next";
import { attachDirectTerminalWebSocket } from "./direct-terminal-ws.js";
import { readSpurInstanceRuntimeConfig } from "./spur-instance.js";
import { findTmux } from "./tmux-utils.js";
import { parseWebHosts } from "./web-hosts.js";

// Next ships a CommonJS module; under Node16 ESM interop the callable factory is
// the default export at runtime but is typed as the module namespace. Re-type it.
type NextFactory = (typeof nextImport)["default"];
const next = nextImport as unknown as NextFactory;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

const instanceConfig = readSpurInstanceRuntimeConfig();
// Default to loopback; widening beyond it must be an explicit WEB_HOST opt-in
// since the terminal WebSocket (unauthenticated tmux attach) rides this port.
// WEB_HOST accepts a comma-separated list (e.g. loopback plus a Tailscale IP);
// see parseWebHosts for the 0.0.0.0-wildcard-supersedes rule.
const hosts = parseWebHosts(process.env["WEB_HOST"], "127.0.0.1");
const port = readPort(process.env["PORT"], instanceConfig.uiPort);

// The Next route handlers read these from the environment; default them from the
// resolved Spur instance config so a bare `node web-server.js` works standalone.
process.env["SPUR_DAEMON_URL"] ||= instanceConfig.daemonUrl;
process.env["SPUR_TMUX_SOCKET_NAME"] ||= instanceConfig.tmuxSocketName;
process.env["SPUR_CONFIG"] ||= instanceConfig.configPath;

const dev = process.env["NODE_ENV"] !== "production";
const app = next({ dev, dir: pkgRoot, hostname: hosts[0], port });
const handle = app.getRequestHandler();

await app.prepare();

// In dev, non-terminal upgrades (Next HMR) are forwarded to Next's own handler.
const devUpgrade = dev ? app.getUpgradeHandler() : undefined;

// Resolve the tmux binary once: findTmux() probes candidate paths with
// execFileSync, so doing it per host would repeat that blocking work for a
// multi-host WEB_HOST (e.g. the loopback + Tailscale bind).
const tmuxPath = findTmux();

// One HTTP server per host: Node's `server.listen(port, host)` binds a single
// interface, so a comma-separated WEB_HOST (loopback plus e.g. a Tailscale IP)
// needs one server per interface, each with its own terminal WebSocket attach.
for (const host of hosts) {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response);
  });

  // Terminal WebSocket shares this server on `/ws` (no separate port or proxy config).
  attachDirectTerminalWebSocket(server, {
    tmuxPath,
    fallbackUpgrade: devUpgrade
      ? (request, socket, head) => void devUpgrade(request, socket, head)
      : undefined,
  });

  server.once("error", (err) => {
    // Fatal when this is the loopback host, or when it's the only host in
    // play (e.g. --expose-web's single-entry `0.0.0.0` list): either way a
    // bind failure here leaves the process with zero listeners, silently
    // idle. Exiting non-zero lets systemd restart it instead. A non-loopback
    // host that's merely additive to a still-present loopback bind (e.g. a
    // Tailscale IP that isn't up yet) stays warn-and-continue.
    if (host === "127.0.0.1" || hosts.length === 1) {
      process.stderr.write(`[web] fatal: could not bind ${host}:${port}: ${String(err)}\n`);
      process.exit(1);
    }
    // A non-loopback host (e.g. a Tailscale IP that isn't up yet) is additive;
    // don't crash-loop the whole server over one unavailable interface.
    process.stderr.write(`[web] warning: could not bind ${host}: ${String(err)}\n`);
  });

  server.listen(port, host, () => {
    process.stdout.write(`[web] listening on ${host}:${port} (dev=${dev})\n`);
  });
}
