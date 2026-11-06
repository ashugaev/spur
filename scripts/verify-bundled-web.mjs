import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, connect } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

const host = "127.0.0.1";
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async function selectPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string" || address.port <= 0)
    throw new Error("Could not select smoke endpoint");
  return address.port;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child, exited, shutdownTimeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await bounded(
    exited.then(() => true),
    shutdownTimeoutMs,
    "Child stop timed out",
  ).catch(() => false);
  if (stopped) return;
  child.kill("SIGKILL");
  await bounded(exited, shutdownTimeoutMs, "Child exit remains unconfirmed");
}

export async function runBundledWebSmoke(
  entry,
  { startupTimeoutMs = 30_000, upgradeTimeoutMs = 10_000, shutdownTimeoutMs = 2_000, signal } = {},
) {
  signal?.throwIfAborted();
  const port = await selectPort();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, NODE_ENV: "production", WEB_HOST: host, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sockets = new Set();
  let diagnostics = "";
  let output = "";
  let failed = false;
  let fail;
  const failure = new Promise((_, reject) => {
    fail = (message) => {
      failed = true;
      reject(new Error(message));
    };
  });
  // Exit may precede the first await, so retain the rejection until raced below.
  void failure.catch(() => {});
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", () => {
      fail("Bundled child could not start");
      resolve();
    });
  });
  const onExit = () => fail("Bundled child exited during smoke verification");
  const onAbort = () => fail("Bundled web smoke interrupted");
  child.once("exit", onExit);
  signal?.addEventListener("abort", onAbort, { once: true });
  const live = () => {
    if (failed || child.exitCode !== null || child.signalCode !== null)
      throw new Error("Bundled child is no longer live");
  };
  const race = (promise) => Promise.race([promise, failure]);
  const capture = (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  };
  child.stderr.on("data", capture);
  let onOutput;
  const ready = new Promise((resolve, reject) => {
    onOutput = (chunk) => {
      capture(chunk);
      output += chunk.toString();
      if (output.length > 65_536) {
        reject(new Error("Bundled child readiness output exceeded limit"));
        return;
      }
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      if (lines.includes(`[web] listening on ${host}:${port} (dev=false)`)) resolve();
    };
    child.stdout.on("data", onOutput);
  });
  const probe = (path, upgrade = false) =>
    new Promise((resolve, reject) => {
      live();
      const key = randomBytes(16).toString("base64");
      const socket = connect(port, host);
      sockets.add(socket);
      let response = "";
      socket.once("error", () => reject(new Error("Bundled endpoint connection failed")));
      socket.once("end", () => reject(new Error("Bundled endpoint closed before headers")));
      socket.once("connect", () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
            (upgrade
              ? `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
              : "Connection: close\r\n") +
            "\r\n",
        );
      });
      socket.on("data", (chunk) => {
        response += chunk.toString();
        const end = response.indexOf("\r\n\r\n");
        if (end > 16_384 || (end === -1 && response.length > 16_384)) {
          reject(new Error("Bundled endpoint headers exceeded limit"));
          return;
        }
        if (end === -1) return;
        const lines = response.slice(0, end).split("\r\n");
        const expected = upgrade ? 101 : 200;
        if (!new RegExp(`^HTTP/1\\.[01] ${expected}(?: |$)`).test(lines[0] ?? "")) {
          reject(
            new Error(
              upgrade ? "Bundled WebSocket did not return 101" : "Bundled web did not return 200",
            ),
          );
          return;
        }
        if (upgrade) {
          const accept = createHash("sha1")
            .update(key + websocketGuid)
            .digest("base64");
          const header = (name) =>
            lines
              .slice(1)
              .filter((line) => line.slice(0, line.indexOf(":")).toLowerCase() === name)
              .map((line) => line.slice(line.indexOf(":") + 1).trim());
          const upgradeHeaders = header("upgrade");
          const acceptHeaders = header("sec-websocket-accept");
          if (
            upgradeHeaders.length !== 1 ||
            upgradeHeaders[0].toLowerCase() !== "websocket" ||
            !header("connection")
              .flatMap((value) => value.toLowerCase().split(","))
              .some((token) => token.trim() === "upgrade") ||
            acceptHeaders.length !== 1 ||
            acceptHeaders[0] !== accept
          ) {
            reject(new Error("Bundled WebSocket handshake is invalid"));
            return;
          }
        }
        socket.destroy();
        sockets.delete(socket);
        resolve();
      });
    });

  const startupDeadline = performance.now() + startupTimeoutMs;
  try {
    if (signal?.aborted) onAbort();
    await bounded(race(ready), startupTimeoutMs, "Bundled child readiness timed out");
    child.stdout.removeListener("data", onOutput);
    child.stdout.on("data", capture);
    live();
    await bounded(
      race(probe("/")),
      Math.max(1, startupDeadline - performance.now()),
      "Bundled HTTP check timed out",
    );
    live();
    await bounded(
      race(probe("/ws?session=nonexistent", true)),
      upgradeTimeoutMs,
      "Bundled WebSocket check timed out",
    );
    live();
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : "Bundled web smoke failed", {
        cause: error,
      }),
      { childOutput: diagnostics },
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    child.removeListener("exit", onExit);
    child.stdout.removeListener("data", onOutput);
    child.stdout.removeListener("data", capture);
    child.stderr.removeListener("data", capture);
    for (const socket of sockets) socket.destroy();
    await stopChild(child, exited, shutdownTimeoutMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new globalThis.AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (process.argv.length !== 3) throw new Error("Expected one bundled web entry argument");
    await runBundledWebSmoke(process.argv[2], { signal: controller.signal });
    console.log("Bundled web smoke passed: owned HTTP 200 and WebSocket 101");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Bundled web smoke failed");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
