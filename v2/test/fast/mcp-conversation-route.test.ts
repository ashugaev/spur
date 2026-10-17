import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { writeSession } from "../../src/metadata.js";
import type { ConversationResponse, TranscriptEntry } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(entries: TranscriptEntry[], startIndex = 0) {
  const root = await createTempDir("spur-mcp-route-");
  const repo = join(root, "repo");
  await mkdir(repo);
  const configPath = join(root, "instance.yaml");
  const port = await findFreePort();
  const dataDir = join(root, "data");
  await writeFile(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${dataDir}\nworktreeDir: ${join(root, "worktrees")}\nprojects:\n  test:\n    path: ${repo}\n`,
  );
  writeSession(dataDir, {
    id: "test-page",
    project: "test",
    agent: "codex",
    prompt: "test",
    branch: "feature/test",
    worktree: false,
    worktreePath: repo,
    tmuxSession: "test-page",
    launchCommand: "codex",
    status: "stopped",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  });
  const legacy: ConversationResponse = {
    entries,
    messages: entries.flatMap((entry) =>
      entry.kind === "message"
        ? [{ role: entry.role, text: entry.text, timestampMs: entry.timestampMs ?? 0 }]
        : [],
    ),
    state: "waiting",
    durationMs: 123,
    startIndex,
    totalEntries: startIndex + entries.length,
    hasMore: startIndex > 0,
  };
  const read = vi
    .spyOn(SessionService.prototype, "getConversation")
    .mockImplementation(async (_id, options) => {
      if (options?.from === undefined) return legacy;
      const from = Math.min(legacy.totalEntries, Math.max(startIndex, options.from));
      const selected = entries.slice(from - startIndex);
      return {
        ...legacy,
        entries: selected,
        messages: selected.flatMap((entry) =>
          entry.kind === "message"
            ? [{ role: entry.role, text: entry.text, timestampMs: entry.timestampMs ?? 0 }]
            : [],
        ),
        startIndex: from,
        hasMore: from > 0,
      };
    });
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  cleanups.push(() => server.stop());
  const client = new Client({ name: "real-route", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
      "--config",
      configPath,
      "mcp",
      "--project",
      "test",
    ],
    cwd: root,
    stderr: "pipe",
  });
  cleanups.push(() => client.close());
  await client.connect(transport);
  const url = `http://127.0.0.1:${port}/sessions/test-page/conversation`;
  return {
    client,
    legacy,
    read,
    url,
    call: (from: number, limit = 1) =>
      client.callTool({
        name: "get_conversation",
        arguments: { sessionId: "test-page", from, limit },
      }),
    page: async (query: string) => {
      const response = await fetch(`${url}?view=messages&${query}`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(body)).toBeLessThan(48 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(body) as unknown;
      } catch {
        throw new Error("Invalid route JSON");
      }
      return value;
    },
  };
}

it("projects a 9 MiB hidden tool before HTTP serialization and continues through SDK stdio", async () => {
  const { page, call, url, legacy } = await setup([
    { kind: "tool", name: "shell", output: "hidden-secret" + "x".repeat(9 * 1024 * 1024) },
    { kind: "message", role: "assistant", text: "visible-answer" },
  ]);
  expect(await page("from=0&limit=1")).toMatchObject({
    messages: [],
    nextFrom: 1,
    hasMoreAfter: true,
  });
  expect((await call(0)).structuredContent).toMatchObject({ messages: [], nextFrom: 1 });
  const next = await call(1);
  expect(next.isError).toBeUndefined();
  expect(next.structuredContent).toMatchObject({
    messages: [{ index: 1, text: "visible-answer" }],
    nextFrom: 2,
    hasMoreAfter: false,
  });
  expect(JSON.stringify(next)).not.toContain("hidden-secret");
  const raw = await (await fetch(url)).text();
  expect(Buffer.byteLength(raw)).toBeGreaterThan(8 * 1024 * 1024);
  expect(raw === JSON.stringify(legacy) + "\n").toBe(true);
});

it("reads first, later and final pages of 100 duplicated 50 KB messages while legacy remains unchanged", async () => {
  const { page, call, url, legacy } = await setup(
    Array.from({ length: 100 }, (_, index) => ({
      kind: "message",
      role: "assistant",
      text: `${index}:` + "x".repeat(50_000),
    })),
  );
  expect(await page("from=0&limit=1")).toMatchObject({
    messages: [{ index: 0, textTruncated: true }],
    nextFrom: 1,
  });
  for (const index of [0, 50, 99]) {
    const output = await call(index);
    expect(output.isError).toBeUndefined();
    expect(output.structuredContent).toMatchObject({
      messages: [{ index, textTruncated: true }],
      nextFrom: index + 1,
      hasMoreAfter: index < 99,
    });
  }
  const raw = await (await fetch(`${url}?limit=invalid`)).text();
  expect(Buffer.byteLength(raw)).toBeGreaterThan(8 * 1024 * 1024);
  expect(raw === JSON.stringify(legacy) + "\n").toBe(true);
});

it("preserves mixed source indices, nonzero starts and hidden-only progress", async () => {
  const { page, call } = await setup(
    [
      { kind: "reasoning", text: "private" },
      { kind: "question", header: "private", prompt: "private" },
      { kind: "message", role: "user", text: "hello", timestampMs: 123 },
      { kind: "tool", name: "private", output: "private" },
      { kind: "message", role: "assistant", text: "answer" },
    ],
    10,
  );
  expect(await page("limit=3")).toEqual({
    sessionId: "test-page",
    state: "waiting",
    messages: [{ index: 12, role: "user", text: "hello", timestampMs: 123 }],
    startIndex: 10,
    totalEntries: 15,
    nextFrom: 13,
    hasMoreBefore: true,
    hasMoreAfter: true,
  });
  expect((await call(13)).structuredContent).toMatchObject({ messages: [], nextFrom: 14 });
  expect((await call(14)).structuredContent).toMatchObject({
    messages: [{ index: 14, text: "answer" }],
    nextFrom: 15,
  });
});

it("bounds multibyte text at byte budget and consumes escaped oversized first message", async () => {
  const { page, call } = await setup([
    { kind: "message", role: "assistant", text: "\u0000".repeat(8192) },
    ...Array.from(
      { length: 5 },
      (): TranscriptEntry => ({ kind: "message", role: "assistant", text: "🙂".repeat(12000) }),
    ),
  ]);
  expect(await page("from=0&limit=1")).toMatchObject({
    messages: [{ textTruncated: true }],
    nextFrom: 1,
  });
  expect((await call(1, 5)).structuredContent).toMatchObject({
    messages: [
      { index: 1, textTruncated: true },
      { index: 2, textTruncated: true },
    ],
    nextFrom: 3,
    hasMoreAfter: true,
  });
});

it("returns empty history and default limit without changing legacy reads", async () => {
  const { page, url, legacy } = await setup([]);
  expect(await page("")).toMatchObject({
    messages: [],
    startIndex: 0,
    totalEntries: 0,
    nextFrom: 0,
    hasMoreBefore: false,
    hasMoreAfter: false,
  });
  expect(await (await fetch(url)).json()).toEqual(legacy);
});

it("validates view and limit before service read; legacy ignores unrelated limit", async () => {
  const { url, read, legacy } = await setup([]);
  for (const query of [
    "view=other",
    "view=",
    "view=messages&limit=0",
    "view=messages&limit=101",
    "view=messages&limit=1.5",
    "view=messages&limit=-1",
    "view=messages&limit=",
    "view=messages&limit=NaN",
  ]) {
    const before = read.mock.calls.length;
    const response = await fetch(`${url}?${query}`);
    expect(response.status).toBe(400);
    await response.text();
    expect(read).toHaveBeenCalledTimes(before);
  }
  expect(await (await fetch(`${url}?limit=invalid`)).json()).toEqual(legacy);
});
