import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it, vi } from "vitest";
import { startMcpHttp, probeMcpServer } from "../../src/mcp-http.js";
import { getBuildId } from "../../src/build-identity.js";
import { mcpFixture, session } from "./mcp-fixture.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("port");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await appendFile(fixture.configPath, `mcp:\n  port: ${port}\n`);
  const host = await startMcpHttp(fixture.configPath);
  cleanups.push(host.close);
  const url = `http://127.0.0.1:${port}/mcp`;
  async function connect() {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
    cleanups.push(() => client.close());
    return client;
  }
  return { fixture, url, connect, host };
}
it("initializes stateless SDK, retains handles across wrappers/clients, and probes installed identity", async () => {
  const { fixture, url, connect } = await setup();
  const client = await connect();
  expect((await client.listTools()).tools).toHaveLength(17);
  const raw = JSON.stringify({ tool: "🙂".repeat(2_500_000) });
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}/conversation` ? { raw } : undefined;
  const result = await client.callTool({
    name: "get_conversation",
    arguments: { sessionId: session.id },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(131072);
  const handle = String(
    (result.structuredContent as Record<string, unknown> | undefined)?.responseId,
  );
  await client.close();
  const next = await connect();
  const first = await next.callTool({
    name: "read_response",
    arguments: { responseId: handle, offset: 0, limit: 32768 },
  });
  expect(
    Buffer.from(
      String((first.structuredContent as Record<string, unknown> | undefined)?.data),
      "base64",
    ).toString(),
  ).toBe(Buffer.from(raw).subarray(0, 32768).toString());
  expect(
    await probeMcpServer({
      url,
      expectedBuildId: getBuildId(),
      expectedConfigPath: fixture.configPath,
    }),
  ).toMatchObject({ ok: true, buildId: getBuildId(), daemonPid: process.pid });
  expect((await probeMcpServer({ url, expectedBuildId: "wrong" })).ok).toBe(false);
});
it("rejects DNS rebinding, foreign Origin, protocol oversize and JSON errors", async () => {
  const { url } = await setup();
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { host: "evil.test" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once("error", reject);
    req.end("{}");
  });
  expect(rebound).toBe(403);
  expect(
    (await fetch(url, { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }))
      .status,
  ).toBe(403);
  expect((await fetch(url, { method: "POST", body: "x".repeat(262145) })).status).toBe(413);
  expect((await fetch(url, { method: "POST", body: "broken" })).status).toBe(400);
});
it("keeps protocol alive through daemon identity failure and recovers without mutation replay", async () => {
  const { fixture, url, connect } = await setup();
  const client = await connect();
  fixture.state.info.apiVersion = -1;
  expect((await client.listTools()).tools).toHaveLength(17);
  expect((await client.callTool({ name: "list_projects", arguments: {} })).isError).toBe(true);
  expect((await fetch(url.replace("/mcp", "/healthz"))).status).toBe(503);
  fixture.state.info.apiVersion = 3;
  expect((await client.callTool({ name: "list_projects", arguments: {} })).isError).toBeUndefined();
  expect((await fetch(url.replace("/mcp", "/healthz"))).status).toBe(200);
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});
it("reconstructs escaped text/error/JSON mutation responses within every MCP envelope without replay", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();
  for (const sample of [
    { raw: "\n".repeat(32768), mime: "text/plain", status: 500 },
    { raw: "\0".repeat(32768), mime: "text/plain", status: 200 },
    { raw: JSON.stringify({ tool: "\0".repeat(16384) }), mime: "application/json", status: 200 },
  ]) {
    fixture.state.override = (_path, method) =>
      method === "POST"
        ? { raw: sample.raw, status: sample.status, headers: { "content-type": sample.mime } }
        : undefined;
    const writesBefore = fixture.calls.filter((call) => call.method === "POST").length;
    const result = await client.callTool({
      name: "daemon_request",
      arguments: {
        operationId: "spawn_background_session",
        body: { project: "test", prompt: "task" },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131072);
    expect(result.isError ?? false).toBe(sample.status === 500);
    const response = result.structuredContent as Record<string, unknown>;
    expect(response).toMatchObject({ status: sample.status, responseId: expect.any(String) });
    const parts = [Buffer.from(String(response.data), "base64")];
    let offset = Number(response.nextOffset);
    while (offset < Number(response.totalBytes)) {
      const output = await client.callTool({
        name: "read_response",
        arguments: { responseId: response.responseId, offset, limit: 32768 },
      });
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(131072);
      const page = output.structuredContent as Record<string, unknown>;
      parts.push(Buffer.from(String(page.data), "base64"));
      offset = Number(page.nextOffset);
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(sample.raw));
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(writesBefore + 1);
  }
});
it("retains the producing list lifecycle identity for empty and paged SDK responses", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();
  for (const raw of ["[]", JSON.stringify([{ id: "s", diagnostic: "x".repeat(40000) }])]) {
    fixture.state.override = (path) =>
      path === "/sessions"
        ? { raw, headers: { "x-spur-lifecycle-instance-id": "producing-instance" } }
        : undefined;
    const output = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(output.isError).toBeUndefined();
    expect(output.structuredContent).toMatchObject({
      headers: { "x-spur-lifecycle-instance-id": "producing-instance" },
    });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(131072);
    const response = output.structuredContent as Record<string, unknown>;
    if (raw === "[]") expect(response.body).toEqual([]);
    else {
      const parts = [Buffer.from(String(response.data), "base64")];
      let offset = Number(response.nextOffset);
      while (offset < Number(response.totalBytes)) {
        const next = await client.callTool({
          name: "read_response",
          arguments: { responseId: response.responseId, offset },
        });
        expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(131072);
        const page = next.structuredContent as Record<string, unknown>;
        parts.push(Buffer.from(String(page.data), "base64"));
        offset = Number(page.nextOffset);
      }
      expect(Buffer.concat(parts)).toEqual(Buffer.from(raw));
    }
  }
});
it("retrieves exact small JSON artifact hashes and mutation bytes through SDK handles", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();
  const raw = '{\n  "n": 9007199254740993, "x":1, "x":2, "s":"\\u0061"\n}\n';
  fixture.state.override = (path) =>
    path.endsWith("/artifacts/result.json") || path === "/sessions/background"
      ? {
          raw,
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-disposition": "inline; filename=result.json",
          },
        }
      : undefined;
  for (const args of [
    { operationId: "get_artifact", pathParams: { sessionId: session.id, path: "result.json" } },
    { operationId: "spawn_background_session", body: { project: "test", prompt: "task" } },
  ]) {
    const result = await client.callTool({ name: "daemon_request", arguments: args });
    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131072);
    const response = result.structuredContent as Record<string, unknown>;
    expect(response.responseId).toBeTypeOf("string");
    const read = await client.callTool({
      name: "read_response",
      arguments: { responseId: response.responseId },
    });
    const page = read.structuredContent as Record<string, unknown>;
    expect(
      createHash("sha256")
        .update(Buffer.from(String(page.data), "base64"))
        .digest("hex"),
    ).toBe(createHash("sha256").update(raw).digest("hex"));
  }
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it("keeps opaque write receipts and escaped8192-character prompts within paged result budgets", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();
  for (const character of ["\0", "\n"]) {
    const prompt = `task${character.repeat(8188)}`;
    const raw = `${JSON.stringify({ ...session, prompt })}\n`;
    fixture.state.override = (_path, method) => (method === "POST" ? { raw } : undefined);
    const before = fixture.calls.filter((call) => call.method === "POST").length;
    const output = await client.callTool({
      name: "spawn_session",
      arguments: { project: "test", prompt },
    });
    expect(output.isError).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(131072);
    const result = output.structuredContent as Record<string, unknown>;
    expect(String(result.after)).toHaveLength(36);
    if (typeof result.rawBody === "string") {
      expect(Buffer.from(result.rawBody)).toEqual(Buffer.from(raw));
      expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(before + 1);
      continue;
    }
    expect(result.responseId).toBeTypeOf("string");
    const parts = [Buffer.from(String(result.data), "base64")];
    let offset = Number(result.nextOffset);
    while (offset < Number(result.totalBytes)) {
      const pageOutput = await client.callTool({
        name: "read_response",
        arguments: { responseId: result.responseId, offset, limit: 32768 },
      });
      expect(Buffer.byteLength(JSON.stringify(pageOutput))).toBeLessThanOrEqual(131072);
      const page = pageOutput.structuredContent as Record<string, unknown>;
      parts.push(Buffer.from(String(page.data), "base64"));
      offset = Number(page.nextOffset);
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(raw));
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(before + 1);
  }
});
it("discovers idempotent local response disposal and leaves uploads and daemon mutations unchanged", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();
  const tool = (await client.listTools()).tools.find((item) => item.name === "release_response");
  expect(tool).toMatchObject({
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { additionalProperties: false, required: ["responseId"] },
  });
  expect(
    (
      await client.callTool({
        name: "release_response",
        arguments: { responseId: "unknown", extra: true },
      })
    ).isError,
  ).toBe(true);
  const staged = await client.callTool({
    name: "stage_request",
    arguments: {
      data: Buffer.from('{"project":"test","prompt":"task"}').toString("base64"),
      complete: true,
    },
  });
  const request = staged.structuredContent as Record<string, unknown>;
  expect(
    (
      await client.callTool({
        name: "release_response",
        arguments: { responseId: request.bodyHandle },
      })
    ).structuredContent,
  ).toEqual({ released: false });
  fixture.state.override = (_path, method) =>
    method === "POST" ? { value: { ...session, result: "x".repeat(40000) } } : undefined;
  const mutation = await client.callTool({
    name: "daemon_request",
    arguments: { operationId: "spawn_background_session", bodyHandle: request.bodyHandle },
  });
  const response = mutation.structuredContent as Record<string, unknown>;
  expect(response.responseId).toBeTypeOf("string");
  expect(
    (
      await client.callTool({
        name: "read_response",
        arguments: { responseId: response.responseId },
      })
    ).isError,
  ).toBeUndefined();
  expect(
    (
      await client.callTool({
        name: "release_response",
        arguments: { responseId: response.responseId },
      })
    ).structuredContent,
  ).toEqual({ released: true });
  expect(
    (
      await client.callTool({
        name: "release_response",
        arguments: { responseId: response.responseId },
      })
    ).structuredContent,
  ).toEqual({ released: false });
  expect(
    (
      await client.callTool({
        name: "read_response",
        arguments: { responseId: response.responseId },
      })
    ).isError,
  ).toBe(true);
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it("disposes known probe handles on paged errors, identity failure and cancellation after response", async () => {
  const { fixture, host, url } = await setup();
  const released = vi.spyOn(host.gateway.results, "release");
  async function spoolFiles() {
    const directory = (await readdir(join(fixture.root, "data", "mcp")))[0];
    if (!directory) throw new Error("Missing spool");
    return readdir(join(fixture.root, "data", "mcp", directory));
  }
  fixture.state.projects = [{ id: "large", name: "x".repeat(40000), configured: true }];
  expect(await probeMcpServer({ url, expectedBuildId: "mismatch" })).toMatchObject({
    ok: false,
    error: expect.stringContaining("build mismatch"),
  });
  expect(released).toHaveBeenCalledTimes(1);
  expect(await spoolFiles()).toEqual([]);
  fixture.state.override = (path) =>
    path === "/projects"
      ? { status: 500, raw: "error".repeat(10000), headers: { "content-type": "text/plain" } }
      : undefined;
  expect(await probeMcpServer({ url })).toMatchObject({
    ok: false,
    error: "MCP list_projects failed",
  });
  expect(released).toHaveBeenCalledTimes(2);
  expect(await spoolFiles()).toEqual([]);
  let infos = 0;
  const cancellation = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 9876 ? cancellation.signal : timeout(ms),
  );
  fixture.state.override = (path) => {
    if (path === "/info" && ++infos > 1) {
      cancellation.abort(new Error("Cancelled after projects response"));
      return { hold: true };
    }
    return undefined;
  };
  const started = Date.now();
  const cancelled = await probeMcpServer({ url, timeoutMs: 9876 });
  expect(cancelled.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(1300);
  expect(released).toHaveBeenCalledTimes(3);
  expect(await spoolFiles()).toEqual([]);
});
it("marks cleanup failure unhealthy while preserving primary diagnostics and attempts cleanup once", async () => {
  const { fixture, host, url } = await setup();
  fixture.state.projects = [{ id: "large", name: "x".repeat(40000), configured: true }];
  const release = vi
    .spyOn(host.gateway.results, "release")
    .mockRejectedValue(new Error("private-spool-details"));
  expect(await probeMcpServer({ url })).toEqual({
    ok: false,
    error: "MCP response cleanup failed",
  });
  expect(release).toHaveBeenCalledTimes(1);
  const failed = await probeMcpServer({ url, expectedBuildId: "mismatch" });
  expect(failed).toMatchObject({
    ok: false,
    error: expect.stringContaining("build mismatch; MCP response cleanup failed"),
  });
  expect(JSON.stringify(failed)).not.toContain("private-spool-details");
  expect(release).toHaveBeenCalledTimes(2);
});
it("does not fabricate disposal before any response ID and skips cleanup for inline results", async () => {
  const { fixture, host, url } = await setup();
  const release = vi.spyOn(host.gateway.results, "release");
  expect(await probeMcpServer({ url })).toMatchObject({ ok: true });
  expect(release).not.toHaveBeenCalled();
  fixture.state.override = (path) => (path === "/projects" ? { hold: true } : undefined);
  expect((await probeMcpServer({ url, timeoutMs: 100 })).ok).toBe(false);
  expect(release).not.toHaveBeenCalled();
});
