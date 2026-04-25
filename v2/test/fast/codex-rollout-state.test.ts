import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexRolloutState } from "../../src/agents/codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STALE_WORKING_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/stale-working-spur-1c0e-tail.jsonl",
);

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeSessionsDir(content: string, filename = "rollout-test.jsonl"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-rollout-"));
  tempDirs.push(root);
  const dayDir = join(root, "sessions", "2026", "04", "19");
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, filename), content, { encoding: "utf8", flag: "w" });
  return join(root, "sessions");
}

describe("readCodexRolloutState", () => {
  it("reads waiting from a real task_complete rollout tail", async () => {
    const content = await readFile(STALE_WORKING_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-stale.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019d8c38-fab8-7803-adfe-a984a5518abc",
    });
  });

  it("reads needs_input from request_user_input calls", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-04-19T16:00:00.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [] },
        }),
        JSON.stringify({
          timestamp: "2026-04-19T16:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "request_user_input", arguments: "{}" },
        }),
      ].join("\n"),
      "rollout-request-user-input.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "needs_input",
      reason: "request_user_input",
      timestamp: "2026-04-19T16:00:01.000Z",
    });
  });

  it("reads needs_input from structured input_required events", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-04-19T16:10:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "show-waiting-menu" },
        }),
        JSON.stringify({
          timestamp: "2026-04-19T16:10:01.000Z",
          type: "event_msg",
          payload: {
            type: "input_required",
            turn_id: "spur-needs-3",
            questions: [{ header: "Plan", question: "Which tier should I run next?" }],
          },
        }),
      ].join("\n"),
      "rollout-input-required.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "needs_input",
      reason: "input_required",
      turnId: "spur-needs-3",
      timestamp: "2026-04-19T16:10:01.000Z",
    });
  });
});
