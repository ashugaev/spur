import { createServer } from "node:http";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { createMcpServer } from "../../src/mcp.js";
import { startMcpHttp, probeMcpServer } from "../../src/mcp-http.js";
import {
  writeInstalledInstance,
  installedInstanceReceiptPath,
} from "../../src/installed-instance.js";
import { getBuildId } from "../../src/build-identity.js";
import { mcpFixture } from "./mcp-fixture.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
async function fixtureWithMcpPort() {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing reserved port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await appendFile(fixture.configPath, `mcp:\n  port: ${address.port}\n`);
  return { ...fixture, mcpUrl: `http://127.0.0.1:${address.port}/mcp` };
}
async function setup() {
  const selected = await fixtureWithMcpPort();
  const override = await fixtureWithMcpPort();
  const home = join(selected.root, "home");
  await mkdir(join(home, ".spur"), { recursive: true });
  writeInstalledInstance(selected.configPath, home);
  // A generic MCP process must not import this legacy secret-bearing file.
  await writeFile(
    join(home, ".spur", "daemon.env"),
    `SPUR_CONFIG=${override.configPath}\nPRIVATE_SENTINEL=do-not-import\n`,
    { mode: 0o600 },
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("SPUR_CONFIG", undefined);
  return { selected, override, home };
}
async function stdioFactoryStatus(configPath?: string) {
  const server = await createMcpServer(configPath);
  const client = new Client({ name: "selection", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(() => client.close());
  return client.callTool({ name: "mcp_status", arguments: {} });
}
it("selects the installed receipt for the stdio factory, preserving explicit and environment precedence", async () => {
  const { selected, override } = await setup();
  expect((await stdioFactoryStatus()).structuredContent).toMatchObject({
    ok: true,
    configPath: selected.configPath,
  });
  expect((await stdioFactoryStatus(override.configPath)).structuredContent).toMatchObject({
    ok: true,
    configPath: override.configPath,
  });
  vi.stubEnv("SPUR_CONFIG", override.configPath);
  expect((await stdioFactoryStatus()).structuredContent).toMatchObject({
    ok: true,
    configPath: override.configPath,
  });
  expect((await stdioFactoryStatus(selected.configPath)).structuredContent).toMatchObject({
    ok: true,
    configPath: selected.configPath,
  });
  expect(process.env["PRIVATE_SENTINEL"]).toBeUndefined();
  expect(vi.mocked(execFileSync).mock.calls.every(([command]) => command === "git")).toBe(true);
});
it("starts implicit and explicit HTTP services on the selected instance without an environment probe", async () => {
  const { selected, override, home } = await setup();
  const before = await readFile(installedInstanceReceiptPath(home), "utf8");
  const implicit = await startMcpHttp();
  cleanups.push(implicit.close);
  const explicit = await startMcpHttp(override.configPath);
  cleanups.push(explicit.close);
  expect(
    await probeMcpServer({
      url: selected.mcpUrl,
      expectedConfigPath: selected.configPath,
      expectedBuildId: getBuildId(),
    }),
  ).toMatchObject({ ok: true, configPath: selected.configPath });
  expect(
    await probeMcpServer({
      url: override.mcpUrl,
      expectedConfigPath: override.configPath,
      expectedBuildId: getBuildId(),
    }),
  ).toMatchObject({ ok: true, configPath: override.configPath });
  expect(await readFile(installedInstanceReceiptPath(home), "utf8")).toBe(before);
  expect(process.env["PRIVATE_SENTINEL"]).toBeUndefined();
  expect(vi.mocked(execFileSync).mock.calls.every(([command]) => command === "git")).toBe(true);
});
it("refuses an invalid installed receipt without fallback, bootstrap or probing; explicit config still works", async () => {
  const { selected, home } = await setup();
  const path = installedInstanceReceiptPath(home);
  await writeFile(path, '{"configPath":"relative.yaml"}', { mode: 0o600 });
  await expect(createMcpServer()).rejects.toThrow("absolute");
  await expect(startMcpHttp()).rejects.toThrow("absolute");
  expect((await stdioFactoryStatus(selected.configPath)).structuredContent).toMatchObject({
    ok: true,
    configPath: selected.configPath,
  });
  expect(await readFile(path, "utf8")).toBe('{"configPath":"relative.yaml"}');
  expect(vi.mocked(execFileSync).mock.calls.every(([command]) => command === "git")).toBe(true);
});
