import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { mcpFixture, session } from "./mcp-fixture.js";
import { computeBuildId } from "../../src/build-identity.js";
import { writeInstalledInstance } from "../../src/installed-instance.js";
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const execute = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("serves generic tools through packaged stdio with protocol-only stdout and clean EOF", async () => {
  const fixture = await mcpFixture();
  fixture.state.info.buildId = computeBuildId(
    fileURLToPath(new URL("../../dist/", import.meta.url)),
  );
  cleanups.push(fixture.close);
  const before = await readFile(fixture.configPath, "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--config", fixture.configPath, "mcp"],
    env: { SPUR_SESSION: "must-not-impersonate", SPUR_CONFIG: join(fixture.root, "wrong.yaml") },
    stderr: "pipe",
    cwd: fixture.root,
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const errors: Error[] = [];
  const client = new Client({ name: "process-test", version: "1" });
  client.onerror = (error) => errors.push(error);
  cleanups.push(() => client.close());
  await client.connect(transport);
  expect((await client.listTools()).tools).toHaveLength(17);
  for (const [name, args] of [
    ["list_projects", {}],
    ["list_sessions", {}],
    ["get_session", { sessionId: session.id }],
    ["get_conversation", { sessionId: session.id }],
    ["spawn_session", { project: "test", prompt: "task" }],
    ["send_message", { sessionId: session.id, message: "followup", interrupt: true }],
  ] as const) {
    expect((await client.callTool({ name, arguments: args })).isError).toBeUndefined();
  }
  expect(errors).toEqual([]);
  expect(stderr).toBe("");
  expect(fixture.calls.every((call) => call.headers["x-spur-caller-session"] === undefined)).toBe(
    true,
  );
  const pid = transport.pid;
  await client.close();
  if (pid) expect(() => process.kill(pid, 0)).toThrow();
  expect(await readFile(fixture.configPath, "utf8")).toBe(before);
});
it("selects SPUR_CONFIG without a global flag", async () => {
  const fixture = await mcpFixture();
  fixture.state.info.buildId = computeBuildId(
    fileURLToPath(new URL("../../dist/", import.meta.url)),
  );
  cleanups.push(fixture.close);
  const client = new Client({ name: "env-test", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      env: { SPUR_CONFIG: fixture.configPath },
      cwd: fixture.root,
      stderr: "pipe",
    }),
  );
  expect(
    (await client.callTool({ name: "list_projects", arguments: {} })).structuredContent,
  ).toMatchObject({ body: fixture.state.projects });
});
it("documents HTTP help and rejects missing config without bootstrap", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const help = await execute(process.execPath, [cli, "mcp", "--help"], { cwd: fixture.root });
  expect(help.stdout).toContain("--http");
  expect(help.stdout).not.toContain("--project");
  await expect(
    execute(process.execPath, [cli, "--config", join(fixture.root, "missing.yaml"), "mcp"], {
      cwd: fixture.root,
      timeout: 10000,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining("existing Spur instance config"),
  });
  expect(await readdir(fixture.root)).toEqual(["instance.yaml"]);
});

it("selects an installed receipt without loading daemon secrets and preserves explicit configuration precedence", async () => {
  const selected = await mcpFixture();
  const override = await mcpFixture();
  cleanups.push(selected.close, override.close);
  const buildId = computeBuildId(fileURLToPath(new URL("../../dist/", import.meta.url)));
  selected.state.info.buildId = buildId;
  override.state.info.buildId = buildId;
  for (const fixture of [selected, override]) {
    await appendFile(
      fixture.configPath,
      `projects:\n  test:\n    path: ${fixture.root}\n    sources:\n      telegram:\n        type: telegram\n        token: \${P2_DAEMON_ONLY_TOKEN}\n        allowedUsers: [123]\n`,
    );
  }
  writeInstalledInstance(selected.configPath, selected.root);
  await writeFile(
    join(selected.root, ".spur", "daemon.env"),
    `SPUR_CONFIG=${override.configPath}\nPRIVATE_SENTINEL=not-for-mcp\n`,
    { mode: 0o600 },
  );
  for (const selection of [
    { args: [cli, "mcp"], env: { HOME: selected.root }, expected: selected.configPath },
    {
      args: [cli, "mcp"],
      env: { HOME: selected.root, SPUR_CONFIG: override.configPath },
      expected: override.configPath,
    },
    {
      args: [cli, "--config", selected.configPath, "mcp"],
      env: { HOME: selected.root, SPUR_CONFIG: override.configPath },
      expected: selected.configPath,
    },
  ]) {
    const client = new Client({ name: "installed-selection", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: selection.args,
        env: selection.env,
        cwd: selected.root,
        stderr: "pipe",
      }),
    );
    const status = await client.callTool({ name: "mcp_status", arguments: {} });
    expect(status.isError).toBeUndefined();
    expect(status.structuredContent).toMatchObject({ ok: true, configPath: selection.expected });
    expect(JSON.stringify(status)).not.toContain("not-for-mcp");
    await client.close();
  }
});
it("retains escaped mutation output as paged bytes over packaged stdio", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  fixture.state.info.buildId = computeBuildId(
    fileURLToPath(new URL("../../dist/", import.meta.url)),
  );
  const raw = "\0".repeat(32768);
  fixture.state.override = (_path, method) =>
    method === "POST" ? { raw, headers: { "content-type": "text/plain" } } : undefined;
  const client = new Client({ name: "escaped-output", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--config", fixture.configPath, "mcp"],
      cwd: fixture.root,
      stderr: "pipe",
    }),
  );
  const result = await client.callTool({
    name: "spawn_session",
    arguments: { project: "test", prompt: "task" },
  });
  expect(result.isError).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131072);
  const response = result.structuredContent as Record<string, unknown>;
  const parts = [Buffer.from(String(response.data), "base64")];
  let offset = Number(response.nextOffset);
  while (offset < Number(response.totalBytes)) {
    const output = await client.callTool({
      name: "read_response",
      arguments: { responseId: response.responseId, offset },
    });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(131072);
    const page = output.structuredContent as Record<string, unknown>;
    parts.push(Buffer.from(String(page.data), "base64"));
    offset = Number(page.nextOffset);
  }
  expect(Buffer.concat(parts)).toEqual(Buffer.from(raw));
  expect(
    (
      await client.callTool({
        name: "release_response",
        arguments: { responseId: response.responseId },
      })
    ).structuredContent,
  ).toEqual({ released: true });
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
