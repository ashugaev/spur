import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { writeSession } from "../../src/metadata.js";
import { codexHookHomePath } from "../../src/agents/codex.js";
import * as buildIdentity from "../../src/build-identity.js";
import type { ConversationResponse, TranscriptEntry } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(entries: TranscriptEntry[], startIndex = 0, native = false) {
  // Source daemon and compiled stdio share this test's installed generation.
  vi.spyOn(buildIdentity, "getBuildId").mockReturnValue(
    buildIdentity.computeBuildId(fileURLToPath(new URL("../../dist/", import.meta.url))),
  );
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
  const rolloutDir = join(
    codexHookHomePath(join(dataDir, "session-tools", "test-page")),
    "sessions",
  );
  const rolloutPath = join(rolloutDir, "rollout-test.jsonl");
  const writeRollout = async (
    messages: { role: "user" | "assistant"; text: string }[],
    hidden = false,
  ) => {
    await mkdir(rolloutDir, { recursive: true });
    const rows = messages.map(({ role, text }) => ({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      },
    }));
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "test-page", cwd: repo } }),
        ...rows.map((row) => JSON.stringify(row)),
        ...(hidden
          ? [
              JSON.stringify({
                type: "response_item",
                payload: {
                  type: "function_call",
                  name: "shell",
                  call_id: "hidden",
                  arguments: "{}",
                },
              }),
            ]
          : []),
        "",
      ].join("\n"),
    );
  };
  if (native) await writeRollout([]);
  const read = native
    ? undefined
    : vi
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
    writeRollout,
    url,
    call: async (from: number, limit = 1) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "get_conversation",
          arguments: { sessionId: "test-page", from, limit, view: "messages" },
        }),
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const body = result.structuredContent as Record<string, unknown> | undefined;
      if (typeof body?.responseId === "string") {
        const responseId = body.responseId;
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const page = CallToolResultSchema.parse(
            await client.callTool({
              name: "read_response",
              arguments: { responseId, offset },
            }),
          );
          expect(page.isError, JSON.stringify(page)).not.toBe(true);
          const data = page.structuredContent as Record<string, unknown>;
          chunks.push(Buffer.from(String(data.data), "base64"));
          if (data.eof === true) break;
          offset = Number(data.nextOffset);
        }
        await client.callTool({ name: "release_response", arguments: { responseId } });
        try {
          return {
            ...result,
            structuredContent: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          };
        } catch {
          throw new Error("Invalid retained route JSON");
        }
      }
      return { ...result, structuredContent: body?.body };
    },
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
  if (!read) throw new Error("Expected fixture reader spy");
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

it("keeps native transcript end cursors stable across polls, appends and hidden final entries", async () => {
  const { page, call, url, writeRollout } = await setup([], 0, true);
  for (let poll = 0; poll < 2; poll++) {
    expect(await page("from=0")).toMatchObject({
      messages: [],
      startIndex: 0,
      nextFrom: 0,
      hasMoreAfter: false,
    });
  }
  const messages = [
    { role: "user" as const, text: "question" },
    { role: "assistant" as const, text: "first" },
    { role: "assistant" as const, text: "second" },
  ];
  await writeRollout(messages);
  expect(await page("from=0")).toMatchObject({
    messages: [{ index: 0 }, { index: 1 }, { index: 2 }],
    nextFrom: 3,
  });
  for (let poll = 0; poll < 2; poll++) {
    expect(await page("from=3")).toMatchObject({
      messages: [],
      startIndex: 3,
      nextFrom: 3,
      hasMoreAfter: false,
    });
  }
  expect((await call(3)).structuredContent).toMatchObject({ messages: [], nextFrom: 3 });
  messages.push({ role: "assistant", text: "appended" });
  await writeRollout(messages);
  expect(await page("from=3")).toMatchObject({
    messages: [{ index: 3, text: "appended" }],
    nextFrom: 4,
  });
  expect(await page("from=4")).toMatchObject({ messages: [], nextFrom: 4 });
  await writeRollout(messages, true);
  expect(await page("from=4")).toMatchObject({
    messages: [],
    startIndex: 4,
    nextFrom: 5,
    hasMoreAfter: false,
  });
  for (let poll = 0; poll < 2; poll++) {
    expect(await page("from=5")).toMatchObject({
      messages: [],
      startIndex: 5,
      nextFrom: 5,
      hasMoreAfter: false,
    });
  }
  // Legacy exact-end reads retain their existing tail reset.
  expect(await (await fetch(`${url}?from=5`)).json()).toMatchObject({
    startIndex: 0,
    totalEntries: 5,
  });
  await writeRollout(messages.slice(0, 1));
  expect(await page("from=5")).toMatchObject({
    messages: [{ index: 0, text: "question" }],
    startIndex: 0,
    nextFrom: 1,
  });
  expect(await (await fetch(`${url}?from=5`)).json()).toMatchObject({
    startIndex: 0,
    totalEntries: 1,
  });
});
