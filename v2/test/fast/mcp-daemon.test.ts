import { createHash } from "node:crypto";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import { startMcpHttp, probeMcpServer } from "../../src/mcp-http.js";
import { getBuildId } from "../../src/build-identity.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
it("preserves real daemon JSON LF bytes inline across40 SDK health/discovery cycles without handle leaks", async () => {
  const root = await createTempDir("mcp-daemon-");
  const repo = join(root, "repo");
  await mkdir(repo);
  const daemonPort = await findFreePort();
  const mcpPort = await findFreePort();
  const configPath = join(root, "instance.yaml");
  const dataDir = join(root, "data");
  await writeFile(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: ${daemonPort}\nmcp:\n  port: ${mcpPort}\ndataDir: ${dataDir}\nworktreeDir: ${join(root, "worktrees")}\nprojects:\n  test:\n    path: ${repo}\n`,
  );
  vi.stubEnv("SPUR_MCP_TUNNEL_ENV_FILE", join(root, "absent-tunnel.env"));
  const daemon = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  cleanups.push(() => daemon.stop());
  const host = await startMcpHttp(configPath);
  cleanups.push(host.close);
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  const client = new Client({ name: "daemon-regression", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
  cleanups.push(() => client.close());
  const raw = await (await fetch(`http://127.0.0.1:${daemonPort}/projects`)).text();
  expect(raw.endsWith("\n")).toBe(true);
  const sourceHash = createHash("sha256").update(raw).digest("hex");
  for (let index = 0; index < 40; index++) {
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    expect(projects.isError).toBeUndefined();
    const result = projects.structuredContent as Record<string, unknown>;
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.responseId).toBeUndefined();
    expect(createHash("sha256").update(String(result.rawBody)).digest("hex")).toBe(sourceHash);
    expect(Buffer.byteLength(JSON.stringify(projects))).toBeLessThanOrEqual(131072);
    expect(
      await probeMcpServer({ url, expectedBuildId: getBuildId(), expectedConfigPath: configPath }),
    ).toMatchObject({ ok: true });
  }
  const instance = (await readdir(join(dataDir, "mcp")))[0];
  if (!instance) throw new Error("Missing host directory");
  expect(await readdir(join(dataDir, "mcp", instance))).toEqual([]);
}, 30_000);
it("reclaims40 actual daemon large health responses while preserving an unrelated user handle", async () => {
  const root = await createTempDir("mcp-large-daemon-");
  const repo = join(root, "repo");
  await mkdir(repo);
  const daemonPort = await findFreePort();
  const mcpPort = await findFreePort();
  const dataDir = join(root, "data");
  const configPath = join(root, "instance.yaml");
  await writeFile(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: ${daemonPort}\nmcp:\n  port: ${mcpPort}\ndataDir: ${dataDir}\nworktreeDir: ${join(root, "worktrees")}\nprojects:\n  test:\n    path: ${repo}\n    name: ${"Project".repeat(7000)}\n`,
  );
  vi.stubEnv("SPUR_MCP_TUNNEL_ENV_FILE", join(root, "absent-tunnel.env"));
  const daemon = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  cleanups.push(() => daemon.stop());
  const host = await startMcpHttp(configPath);
  cleanups.push(host.close);
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  const raw = await (await fetch(`http://127.0.0.1:${daemonPort}/projects`)).text();
  expect(Buffer.byteLength(raw)).toBeGreaterThan(32768);
  const directory = (await readdir(join(dataDir, "mcp")))[0];
  if (!directory) throw new Error("Missing host directory");
  const spoolFiles = () => readdir(join(dataDir, "mcp", directory));
  expect(
    await probeMcpServer({ url, expectedBuildId: getBuildId(), expectedConfigPath: configPath }),
  ).toMatchObject({ ok: true });
  expect(await spoolFiles()).toEqual([]);
  const user = new Client({ name: "user", version: "1" });
  await user.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
  cleanups.push(() => user.close());
  const retained = await user.callTool({ name: "list_projects", arguments: {} });
  expect(retained.isError).toBeUndefined();
  const response = retained.structuredContent as Record<string, unknown>;
  expect(response.responseId).toBeTypeOf("string");
  const responseId = String(response.responseId);
  for (let index = 0; index < 40; index++) {
    expect(
      await probeMcpServer({ url, expectedBuildId: getBuildId(), expectedConfigPath: configPath }),
    ).toMatchObject({ ok: true });
    expect(await spoolFiles()).toEqual([responseId]);
  }
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const output = await user.callTool({
      name: "read_response",
      arguments: { responseId, offset, limit: 32768 },
    });
    expect(output.isError).toBeUndefined();
    const page = output.structuredContent as Record<string, unknown>;
    parts.push(Buffer.from(String(page.data), "base64"));
    offset = Number(page.nextOffset);
    if (page.eof) break;
  }
  expect(createHash("sha256").update(Buffer.concat(parts)).digest("hex")).toBe(
    createHash("sha256").update(raw).digest("hex"),
  );
  expect(
    (await user.callTool({ name: "release_response", arguments: { responseId } }))
      .structuredContent,
  ).toEqual({ released: true });
  expect(await spoolFiles()).toEqual([]);
  expect(await probeMcpServer({ url })).toMatchObject({ ok: true });
  expect(await spoolFiles()).toEqual([]);
}, 30_000);
