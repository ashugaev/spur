import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";

interface SmokeOptions {
  startupTimeoutMs?: number;
  upgradeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
}
const {
  runBundledWebSmoke,
}: {
  runBundledWebSmoke: (entry: string, options?: SmokeOptions) => Promise<void>;
} = await import(new URL("../../../scripts/verify-bundled-web.mjs", import.meta.url).href);
const directories: string[] = [];
const options = { startupTimeoutMs: 2_000, upgradeTimeoutMs: 1_000, shutdownTimeoutMs: 100 };
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function untilFile(path: string) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await wait(5);
    }
  }
  throw new Error("Fixture did not report its checkpoint");
}

async function fixture(mode = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "spur-release-smoke-"));
  directories.push(directory);
  const entry = join(directory, "fixture.mjs");
  const pid = join(directory, "pid");
  const port = join(directory, "port");
  const release = join(directory, "release");
  await writeFile(
    entry,
    `import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
const cfg = ${JSON.stringify({ mode, pid, port, release })};
writeFileSync(cfg.pid, String(process.pid));
writeFileSync(cfg.port, process.env.PORT);
setTimeout(() => process.exit(99), 10_000).unref();
if (cfg.mode === "exit-before") process.exit(7);
if (cfg.mode === "ignore-term") process.on("SIGTERM", () => {});
const server = createServer((request, response) => {
  if (cfg.mode === "exit-http") process.exit(7);
  if (cfg.mode === "hang-http") return;
  response.writeHead(cfg.mode === "http401" ? 401 : 200);
  response.end("x".repeat(32_000));
});
server.on("upgrade", (request, socket) => {
  if (cfg.mode === "exit-ws") process.exit(7);
  if (cfg.mode === "hang-ws") return;
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  if (cfg.mode === "huge-headers") { socket.write("HTTP/1.1 101 Switching Protocols\\r\\nX-Long: " + "x".repeat(17_000)); return; }
  socket.end("HTTP/1.1 " + (cfg.mode === "ws401" ? "401 Unauthorized" : "101 Switching Protocols") +
    "\\r\\nUpgrade: websocket\\r\\nConnection: " + (cfg.mode === "bad-connection" ? "not-upgrade" : "Upgrade") + "\\r\\nSec-WebSocket-Accept: " +
    (cfg.mode === "bad-accept" ? "wrong" : accept) + "\\r\\n\\r\\n");
});
server.on("error", () => process.exit(8));
function listen() {
  server.listen(Number(process.env.PORT), process.env.WEB_HOST, () => {
    if (cfg.mode === "silent") return;
    const reportedPort = cfg.mode === "wrong-port" ? 0 : process.env.PORT;
    const reportedHost = cfg.mode === "wrong-host" ? "localhost" : process.env.WEB_HOST;
    process.stdout.write("[web] listen");
    setTimeout(() => process.stdout.write("ing on " + reportedHost + ":" + reportedPort + " (dev=false)\\n"), 5);
  });
}
if (cfg.mode === "collision") {
  const timer = setInterval(() => { if (existsSync(cfg.release)) { clearInterval(timer); listen(); } }, 5);
} else listen();
`,
  );
  return {
    entry,
    port,
    release,
    async assertStopped() {
      await untilFile(pid);
      const value = Number(await readFile(pid, "utf8"));
      expect(() => process.kill(value, 0)).toThrow();
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("own split readiness gates HTTP 200 and valid WebSocket 101; child is stopped", async () => {
  const child = await fixture();
  await runBundledWebSmoke(child.entry, options);
  expect(Number(await readFile(child.port, "utf8"))).toBeGreaterThan(0);
  await child.assertStopped();
});

const failureCases: [string, string | RegExp][] = [
  ["exit-before", "exited"],
  ["exit-http", /exited|closed before headers/],
  ["exit-ws", /exited|closed before headers/],
  ["wrong-port", "readiness timed out"],
  ["wrong-host", "readiness timed out"],
  ["silent", "readiness timed out"],
  ["http401", "did not return 200"],
  ["ws401", "did not return 101"],
  ["bad-accept", "handshake is invalid"],
  ["bad-connection", "handshake is invalid"],
  ["huge-headers", "headers exceeded limit"],
  ["hang-http", "HTTP check timed out"],
  ["hang-ws", "WebSocket check timed out"],
];
test.each(failureCases)("%s fails closed and stops only the owned child", async (mode, reason) => {
  const child = await fixture(mode);
  await expect(runBundledWebSmoke(child.entry, options)).rejects.toThrow(reason);
  await child.assertStopped();
});

test("port handoff collision never probes or kills the foreign successful endpoint", async () => {
  const child = await fixture("collision");
  const result = runBundledWebSmoke(child.entry, options);
  // Attach the assertion before the deliberate failing child can reject.
  const failed = expect(result).rejects.toThrow("exited");
  await untilFile(child.port);
  const port = Number(await readFile(child.port, "utf8"));
  let connections = 0;
  const sockets = new Set<Socket>();
  const foreign = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("data", (chunk) => {
      const request = chunk.toString();
      if (request.startsWith("GET /ws")) {
        const key = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(request)?.[1] ?? "";
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      } else socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(port, "127.0.0.1", resolve);
  });
  try {
    await writeFile(child.release, "release");
    await failed;
    expect(connections).toBe(0);
    expect(foreign.listening).toBe(true);
    await child.assertStopped();
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeServer(foreign);
  }
});

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("concurrent smoke children use distinct endpoints and both clean up", async () => {
  const children = await Promise.all([fixture(), fixture()]);
  await Promise.all(children.map((child) => runBundledWebSmoke(child.entry, options)));
  const ports = await Promise.all(children.map((child) => readFile(child.port, "utf8")));
  expect(new Set(ports).size).toBe(2);
  await Promise.all(children.map((child) => child.assertStopped()));
});

test("abort during startup stops the owned child", async () => {
  const child = await fixture("silent");
  const controller = new AbortController();
  const result = runBundledWebSmoke(child.entry, { ...options, signal: controller.signal });
  const failed = expect(result).rejects.toThrow("interrupted");
  await untilFile(child.port);
  controller.abort();
  await failed;
  await child.assertStopped();
});

test("bounded shutdown escalates only the child that ignores SIGTERM", async () => {
  const child = await fixture("ignore-term");
  await runBundledWebSmoke(child.entry, options);
  await child.assertStopped();
});

test("CLI rejects missing entry without starting a child", async () => {
  await expect(
    promisify(execFile)(process.execPath, [
      new URL("../../../scripts/verify-bundled-web.mjs", import.meta.url).pathname,
    ]),
  ).rejects.toMatchObject({ code: 1, stderr: "Expected one bundled web entry argument\n" });
});

test("release workflow invokes the helper and preserves subsequent build/test/publish steps", async () => {
  const content = await readFile(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const definition = parse(content) as {
    jobs: { release: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } };
  };
  const steps = definition.jobs.release.steps;
  const index = steps.findIndex((step) => step.name === "Verify bundled web boots");
  expect(index).toBeGreaterThan(0);
  expect(steps[index]).toEqual({
    name: "Verify bundled web boots",
    run: "node scripts/verify-bundled-web.mjs v2/web/dist-server/web-server.js",
  });
  expect(steps.slice(index + 1)).toEqual([
    { name: "Build v2", env: { SPUR_DISABLE_AUTOSTART: "1" }, run: "pnpm --dir v2 build" },
    { name: "Test v2", run: "pnpm --dir v2 test" },
    {
      name: "Release",
      env: {
        GITHUB_TOKEN: `\${{ secrets.GITHUB_TOKEN }}`,
        NODE_AUTH_TOKEN: `\${{ secrets.NPM_TOKEN }}`,
        SPUR_DISABLE_AUTOSTART: "1",
      },
      run: "npx -p semantic-release@24 -p @semantic-release/exec -- semantic-release",
    },
  ]);
  expect(content).not.toContain("41799");
});
