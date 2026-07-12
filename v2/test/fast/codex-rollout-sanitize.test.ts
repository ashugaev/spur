import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeCodexRollouts } from "../../src/agents/codex.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function header(threadId: string): string {
  return JSON.stringify({
    timestamp: "2026-04-19T16:00:00.000Z",
    type: "session_meta",
    payload: { id: threadId, cwd: "/work/repo" },
  });
}

async function makeSessionsDir(
  files: { filename: string; content: string }[],
): Promise<{ sessionsDir: string; pathFor: (filename: string) => string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-sanitize-"));
  tempDirs.push(root);
  const dayDir = join(root, "sessions", "2026", "04", "19");
  await mkdir(dayDir, { recursive: true });
  for (const file of files) {
    await writeFile(join(dayDir, file.filename), file.content, { encoding: "utf8", flag: "w" });
  }
  return {
    sessionsDir: join(root, "sessions"),
    pathFor: (filename: string) => join(dayDir, filename),
  };
}

const THREAD_ID = "019e1300-bbbb-7000-9000-000000000001";

describe("sanitizeCodexRollouts", () => {
  it("strips bare-UUID message id and keeps msg_/amsg_ message ids", async () => {
    const content =
      [
        header(THREAD_ID),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "abc-123-bare", content: [] },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "msg_keepme", content: [] },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "amsg_keepme", content: [] },
        }),
      ].join("\n") + "\n";
    const { sessionsDir, pathFor } = await makeSessionsDir([
      { filename: "rollout.jsonl", content },
    ]);

    const result = await sanitizeCodexRollouts(sessionsDir, THREAD_ID);

    expect(result).toEqual({ scanned: 1, rewritten: 1, strippedIds: 1 });
    const out = await readFile(pathFor("rollout.jsonl"), "utf8");
    const lines = out.slice(0, -1).split("\n");
    expect(JSON.parse(lines[1] ?? "").payload.id).toBeUndefined();
    expect(JSON.parse(lines[2] ?? "").payload.id).toBe("msg_keepme");
    expect(JSON.parse(lines[3] ?? "").payload.id).toBe("amsg_keepme");
  });

  it("leaves non-message items with non-msg ids untouched", async () => {
    const content =
      [
        header(THREAD_ID),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", id: "fc-bare-1", name: "exec_command" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "reasoning", id: "rs-bare-1" },
        }),
      ].join("\n") + "\n";
    const { sessionsDir, pathFor } = await makeSessionsDir([
      { filename: "rollout.jsonl", content },
    ]);

    const result = await sanitizeCodexRollouts(sessionsDir, THREAD_ID);

    expect(result).toEqual({ scanned: 1, rewritten: 0, strippedIds: 0 });
    expect(await readFile(pathFor("rollout.jsonl"), "utf8")).toBe(content);
  });

  it("preserves a malformed non-JSON line verbatim", async () => {
    const content =
      [
        header(THREAD_ID),
        "this is not json {{{",
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "bare-id", content: [] },
        }),
      ].join("\n") + "\n";
    const { sessionsDir, pathFor } = await makeSessionsDir([
      { filename: "rollout.jsonl", content },
    ]);

    const result = await sanitizeCodexRollouts(sessionsDir, THREAD_ID);

    expect(result).toEqual({ scanned: 1, rewritten: 1, strippedIds: 1 });
    const out = await readFile(pathFor("rollout.jsonl"), "utf8");
    expect(out.split("\n")[1]).toBe("this is not json {{{");
  });

  it("is byte-stable except for the single stripped id", async () => {
    const messageLine = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", id: "bare-id-strip", content: [] },
    });
    const strippedLine = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [] },
    });
    const lines = [
      header(THREAD_ID),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", id: "rs-1" } }),
      messageLine,
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ];
    const content = lines.join("\n") + "\n";
    const { sessionsDir, pathFor } = await makeSessionsDir([
      { filename: "rollout.jsonl", content },
    ]);

    await sanitizeCodexRollouts(sessionsDir, THREAD_ID);

    const expected = [lines[0], lines[1], strippedLine, lines[3]].join("\n") + "\n";
    expect(await readFile(pathFor("rollout.jsonl"), "utf8")).toBe(expected);
  });

  it("is idempotent: second run writes nothing", async () => {
    const content =
      [
        header(THREAD_ID),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "bare-id", content: [] },
        }),
      ].join("\n") + "\n";
    const { sessionsDir, pathFor } = await makeSessionsDir([
      { filename: "rollout.jsonl", content },
    ]);

    const first = await sanitizeCodexRollouts(sessionsDir, THREAD_ID);
    expect(first).toEqual({ scanned: 1, rewritten: 1, strippedIds: 1 });
    const afterFirst = await readFile(pathFor("rollout.jsonl"), "utf8");

    const second = await sanitizeCodexRollouts(sessionsDir, THREAD_ID);
    expect(second).toEqual({ scanned: 1, rewritten: 0, strippedIds: 0 });
    expect(await readFile(pathFor("rollout.jsonl"), "utf8")).toBe(afterFirst);
  });

  it("only sanitizes files whose header threadId matches", async () => {
    const otherThreadId = "019e1300-cccc-7000-9000-000000000002";
    const matchingContent =
      [
        header(THREAD_ID),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "bare-match", content: [] },
        }),
      ].join("\n") + "\n";
    const otherContent =
      [
        header(otherThreadId),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", id: "bare-other", content: [] },
        }),
      ].join("\n") + "\n";
    const { sessionsDir, pathFor } = await makeSessionsDir([
      { filename: "matching.jsonl", content: matchingContent },
      { filename: "other.jsonl", content: otherContent },
    ]);
    const otherBefore = await stat(pathFor("other.jsonl"));

    const result = await sanitizeCodexRollouts(sessionsDir, THREAD_ID);

    expect(result).toEqual({ scanned: 1, rewritten: 1, strippedIds: 1 });
    expect(await readFile(pathFor("other.jsonl"), "utf8")).toBe(otherContent);
    const otherAfter = await stat(pathFor("other.jsonl"));
    expect(otherAfter.mtimeMs).toBe(otherBefore.mtimeMs);
  });
});
