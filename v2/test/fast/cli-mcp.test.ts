import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPUR_DAEMON_API_VERSION } from "../../src/types.js";

const cli = resolve("dist/cli.js");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler?: (request: IncomingMessage, response: ServerResponse) => void) {
  const dir = await mkdtemp(join(tmpdir(), "spur-mcp-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const requests: Array<{
    path: string | undefined;
    method: string | undefined;
    origin: string | undefined;
    caller: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      origin: request.headers["x-spur-origin"] as string | undefined,
      caller: request.headers["x-spur-caller-session"] as string | undefined,
    });
    if (handler) return handler(request, response);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/info"
          ? { ok: true, apiVersion: SPUR_DAEMON_API_VERSION, pid: 123 }
          : [{ id: "TEST", name: "Test", configured: true, path: "/private" }],
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const config = join(dir, "config.yaml");
  await writeFile(
    config,
    `server:\n  host: 127.0.0.1\n  port: ${address.port}\ndataDir: ./data\nworktreeDir: ./worktrees\nprojects: {}\n`,
  );
  return { dir, config, requests };
}

async function child(config: string, dir: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--config", config, "mcp"],
    cwd: dir,
    stderr: "pipe",
    env: { SPUR_SESSION: "must-not-leak", SPUR_PROJECT: "must-not-connect" },
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (data: Buffer) => errors.push(data.toString()));
  const client = new Client({ name: "test", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return { client, transport, errors };
}

describe("built spur mcp stdio", () => {
  it("initializes SDK, discovers and calls tools with protocol-only stdout and no config writes or CLI attribution", async () => {
    const { config, dir, requests } = await fixture();
    const original = await readFile(config, "utf8");
    const { client, errors } = await child(config, dir);
    expect((await client.listTools()).tools).toHaveLength(6);
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    expect(result.structuredContent).toEqual({
      projects: [{ id: "TEST", name: "Test", configured: true }],
      total: 1,
      nextOffset: null,
    });
    expect(errors).toEqual([]);
    expect(requests).toEqual([
      { path: "/info", method: "GET", origin: undefined, caller: undefined },
      { path: "/projects", method: "GET", origin: undefined, caller: undefined },
    ]);
    expect(await readFile(config, "utf8")).toBe(original);
    expect(await readdir(dir)).toEqual(["config.yaml"]);
  });

  it.each(["missing", "invalid", "incompatible", "unavailable"])(
    "fails %s startup on stderr without writes or lifecycle calls",
    async (kind) => {
      const { dir, config, requests } = await fixture((request, response) => {
        if (kind === "unavailable") {
          request.socket.destroy();
          return;
        }
        response.end(JSON.stringify({ ok: true, apiVersion: -1, pid: 123, secret: "/private" }));
      });
      if (kind === "invalid") await writeFile(config, "server: [invalid");
      const selected = kind === "missing" ? join(dir, "absent.yaml") : config;
      const processChild = spawn(process.execPath, [cli, "--config", selected, "mcp"], {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      processChild.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      processChild.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const [code] = await once(processChild, "exit");
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Spur MCP requires");
      expect(stderr).not.toContain(dir);
      expect(
        requests.every((request) => request.path === "/info" && request.method === "GET"),
      ).toBe(true);
      expect(await readdir(dir)).toEqual(["config.yaml"]);
    },
  );

  it("exits on stdin EOF", async () => {
    const { dir, config } = await fixture();
    const processChild = spawn(process.execPath, [cli, "--config", config, "mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(async () => {
      processChild.kill("SIGKILL");
    });
    const exited = once(processChild, "exit");
    processChild.stdin.end();
    const [code] = await exited;
    expect(code).toBe(0);
  });

  it("EOF aborts an in-flight daemon request and exits without a signal", async () => {
    let pending = false,
      aborted = false;
    const { dir, config, requests } = await fixture((request, response) => {
      if (request.url === "/info") {
        response.end(JSON.stringify({ ok: true, apiVersion: SPUR_DAEMON_API_VERSION, pid: 123 }));
        return;
      }
      pending = true;
      response.on("close", () => {
        aborted = true;
      });
    });
    const processChild = spawn(process.execPath, [cli, "--config", config, "mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(async () => {
      processChild.kill("SIGKILL");
    });
    const exited = once(processChild, "exit");
    processChild.stdout.on("data", () => undefined);
    processChild.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }) + "\n",
    );
    processChild.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    processChild.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_session", arguments: { sessionId: "s" } },
      }) + "\n",
    );
    await vi.waitFor(() => expect(pending).toBe(true));
    processChild.stdin.end();
    const [code, signal] = await exited;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(requests.map((request) => request.path)).toEqual(["/info", "/sessions/s"]);
  });

  it("SIGTERM aborts pending daemon HTTP without stopping daemon or retrying", async () => {
    let pending = false,
      aborted = false;
    const { dir, config, requests } = await fixture((request, response) => {
      if (request.url === "/info") {
        response.end(JSON.stringify({ ok: true, apiVersion: SPUR_DAEMON_API_VERSION, pid: 123 }));
        return;
      }
      pending = true;
      response.on("close", () => {
        aborted = true;
      });
    });
    const { client, transport } = await child(config, dir);
    const call = client
      .callTool({ name: "get_session", arguments: { sessionId: "s" } })
      .catch(() => undefined);
    await vi.waitFor(() => expect(pending).toBe(true));
    if (!transport.pid) throw new Error("Missing child pid");
    process.kill(transport.pid, "SIGTERM");
    await vi.waitFor(() => expect(aborted).toBe(true));
    await call;
    expect(requests.map((request) => request.path)).toEqual(["/info", "/sessions/s"]);
  });
});
