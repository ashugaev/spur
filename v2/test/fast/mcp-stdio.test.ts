import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { mcpFixture, session } from "./mcp-fixture.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("serves six SDK tools through packaged CLI with protocol-only stdout and clean shutdown", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const before = await readFile(fixture.configPath, "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--config", fixture.configPath, "mcp", "--project", "test"],
    env: {
      SPUR_SESSION: "inherited-must-not-impersonate",
      SPUR_CONFIG: join(fixture.root, "wrong.yaml"),
    },
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
  expect((await client.listTools()).tools).toHaveLength(6);
  for (const [name, args] of [
    ["list_projects", {}],
    ["list_sessions", {}],
    ["get_session", { sessionId: session.id }],
    ["get_conversation", { sessionId: session.id }],
    ["spawn_session", { project: "test", prompt: "task" }],
    ["send_message", { sessionId: session.id, message: "followup" }],
  ] as const) {
    const output = await client.callTool({ name, arguments: args });
    expect(output.isError).toBeUndefined();
    expect(output.content).toEqual([
      { type: "text", text: JSON.stringify(output.structuredContent) },
    ]);
  }
  expect(errors).toEqual([]);
  const beforeInvalid = fixture.calls.length;
  expect(
    (
      await client.callTool({
        name: "send_message",
        arguments: { sessionId: session.id, message: "x", interrupt: true },
      })
    ).isError,
  ).toBe(true);
  expect(fixture.calls).toHaveLength(beforeInvalid);
  expect(stderr).toBe("");
  expect(fixture.calls.every((call) => call.headers["x-spur-caller-session"] === undefined)).toBe(
    true,
  );
  const pid = transport.pid;
  expect(pid).toBeTypeOf("number");
  await client.close();
  if (pid) expect(() => process.kill(pid, 0)).toThrow();
  expect(await readFile(fixture.configPath, "utf8")).toBe(before);
  expect(await readdir(fixture.root)).toEqual(["instance.yaml"]);
});

it("uses SPUR_CONFIG when global flag is absent and supports repeated project filters", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const client = new Client({ name: "env-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--project", "test", "--project", "other"],
    env: { SPUR_CONFIG: fixture.configPath },
    cwd: fixture.root,
    stderr: "pipe",
  });
  cleanups.push(() => client.close());
  await client.connect(transport);
  expect(
    (await client.callTool({ name: "list_projects", arguments: {} })).structuredContent,
  ).toMatchObject({ total: 2 });
});

it("exposes command help and fails startup on stderr without bootstrapping config", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const help = await execute(process.execPath, [cli, "mcp", "--help"], { cwd: fixture.root });
  expect(help.stdout).toContain("--project");
  try {
    await execute(process.execPath, [cli, "--config", join(fixture.root, "missing.yaml"), "mcp"], {
      cwd: fixture.root,
      timeout: 10000,
    });
    throw new Error("Expected startup failure");
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stdout: "" });
    expect(error).toHaveProperty(
      "stderr",
      expect.stringContaining("existing valid Spur instance config"),
    );
  }
  expect(await readdir(fixture.root)).toEqual(["instance.yaml"]);
});
