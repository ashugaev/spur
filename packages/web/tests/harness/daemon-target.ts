import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface IsolatedWebTestTarget {
  uiPort: number;
  env: Record<string, string>;
  cleanup: () => void;
}

// Every value the harness writes back into process.env. A worker re-loading
// playwright.config.ts reads all five from the inherited env and allocates
// nothing; if ANY of them is missing the harness allocates fresh values and
// overwrites all five, so a half-populated env can never yield a half-memoized
// target.
const MEMO_KEYS = [
  "SPUR_DAEMON_URL",
  "SPUR_CONFIG",
  "SPUR_TMUX_SOCKET_NAME",
  "SPUR_WEB_TEST_ISOLATION",
  "SPUR_WEB_TEST_UI_PORT",
] as const;

// Two servers listen at once so the kernel hands out two distinct ports.
// Synchronous by necessity: playwright.config.ts resolves baseURL at module
// load, and net.Server.listen has no sync form. Same listen(0) technique the
// CI "Select Playwright port" step used before this harness replaced it.
const PORT_PROBE = [
  'const net = require("node:net");',
  "const servers = [net.createServer(), net.createServer()];",
  "const ports = [];",
  "for (const server of servers) {",
  '  server.listen(0, "127.0.0.1", () => {',
  "    const address = server.address();",
  '    if (!address || typeof address === "string") process.exit(1);',
  "    ports.push(address.port);",
  "    if (ports.length === servers.length) {",
  "      for (const open of servers) open.close();",
  '      console.log(ports.join(" "));',
  "    }",
  "  });",
  "}",
].join("\n");

function allocatePorts(): { daemonPort: number; uiPort: number } {
  const printed = execFileSync(process.execPath, ["-e", PORT_PROBE], {
    encoding: "utf8",
  }).trim();
  const ports = printed.split(/\s+/).map((value) => Number.parseInt(value, 10));
  const daemonPort = ports[0];
  const uiPort = ports[1];
  if (ports.length !== 2 || !Number.isInteger(daemonPort) || !Number.isInteger(uiPort)) {
    throw new Error(`Free-port probe returned "${printed}"`);
  }
  return { daemonPort, uiPort };
}

function readMemoizedTarget(): IsolatedWebTestTarget | null {
  const env: Record<string, string> = {};
  for (const key of MEMO_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) {
      return null;
    }
    env[key] = value;
  }
  const uiPort = Number.parseInt(env["SPUR_WEB_TEST_UI_PORT"] ?? "", 10);
  if (!Number.isInteger(uiPort) || uiPort <= 0) {
    return null;
  }
  // The allocating process owns the temp dir; a worker owns no cleanup.
  return { uiPort, env, cleanup: () => undefined };
}

// Allocates an isolated, deliberately UNBOUND daemon target for a packages/web
// Playwright run: no daemon listens on daemonPort, so any request the spec
// mocks fail to intercept dies with ECONNREFUSED instead of reaching the host's
// real daemon on 4310. Idempotent per process tree through process.env.
export function createIsolatedWebTestTarget(): IsolatedWebTestTarget {
  const memoized = readMemoizedTarget();
  if (memoized) {
    return memoized;
  }

  const { daemonPort, uiPort } = allocatePorts();
  const configDir = mkdtempSync(join(tmpdir(), "spur-web-test-"));
  const configPath = join(configDir, "config.yaml");
  writeFileSync(
    configPath,
    ["server:", "  host: 127.0.0.1", `  port: ${daemonPort}`, "ui:", `  port: ${uiPort}`, ""].join(
      "\n",
    ),
    "utf8",
  );

  const env: Record<string, string> = {
    SPUR_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
    SPUR_CONFIG: configPath,
    SPUR_TMUX_SOCKET_NAME: `spur-web-test-${daemonPort}`,
    SPUR_WEB_TEST_ISOLATION: "1",
    SPUR_WEB_TEST_UI_PORT: String(uiPort),
  };
  for (const key of MEMO_KEYS) {
    process.env[key] = env[key];
  }

  return {
    uiPort,
    env,
    cleanup: () => cleanupIsolatedWebTestTarget(env),
  };
}

// Removes the temp config dir this harness created. Called by the allocating
// process's own cleanup() and by the Playwright globalTeardown, so a run leaves
// no spur-web-test-* dir behind. Refuses anything it did not create: an
// externally supplied SPUR_CONFIG, or a run with isolation off.
export function cleanupIsolatedWebTestTarget(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env["SPUR_WEB_TEST_ISOLATION"] !== "1") {
    return;
  }
  const configPath = env["SPUR_CONFIG"]?.trim();
  if (!configPath) {
    return;
  }
  const configDir = dirname(configPath);
  if (!basename(configDir).startsWith("spur-web-test-")) {
    return;
  }
  rmSync(configDir, { recursive: true, force: true });
}
