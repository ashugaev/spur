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
const INTERRUPTED_TAIL_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/interrupted-spur-00b0-tail.jsonl",
);
const WORKING_CURRENT_SESSION_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/working-spur-67c0-rollout-tail.jsonl",
);
const IDLE_FIXTURE_SESSION_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/idle-fixture-session-trailing-tool-output-tail.jsonl",
);
const WORKING_UNMATCHED_TOOL_CALL_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/working-unmatched-tool-call-tail.jsonl",
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
  it("reads working from the current Codex rollout tail after an older interrupted turn", async () => {
    const content = await readFile(WORKING_CURRENT_SESSION_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-working-current.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "working",
      reason: "function_call",
      timestamp: "2026-05-10T09:34:55.113Z",
    });
  });

  it("reads waiting from a Codex turn whose tail ends with matched function_call_output", async () => {
    const content = await readFile(IDLE_FIXTURE_SESSION_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-idle-fixture-session.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019e112e-6670-7620-9d09-061a78dc96cf",
    });
  });

  it("reads working from an in-flight Codex turn with an unmatched function_call", async () => {
    const content = await readFile(WORKING_UNMATCHED_TOOL_CALL_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-working-unmatched.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "working",
      reason: "function_call",
      timestamp: "2026-05-10T10:01:02.000Z",
    });
  });

  it("treats function_call as state-neutral when its matching function_call_output exists later in the file", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-05-10T11:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "019e1300-bbbb-7000-9000-000000000003",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T11:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "exec_command", call_id: "call_X" },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T11:00:02.000Z",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_X" },
        }),
      ].join("\n"),
      "rollout-matched-pair.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "working",
      reason: "task_started",
      turnId: "019e1300-bbbb-7000-9000-000000000003",
    });
  });

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

  it("reads waiting from a real interrupted turn_aborted tail", async () => {
    const content = await readFile(INTERRUPTED_TAIL_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-interrupted.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toMatchObject({
      state: "waiting",
      reason: "turn_aborted",
      turnId: "019dca92-5592-7043-bdca-211e6b7c11e2",
      timestamp: "2026-04-26T16:14:44.371Z",
    });
  });

  it("ignores turn_aborted events when the reason is not interrupted", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-04-26T16:14:44.371Z",
          type: "event_msg",
          payload: {
            type: "turn_aborted",
            turn_id: "spur-abort-1",
            reason: "tool_error",
          },
        }),
      ].join("\n"),
      "rollout-non-interrupted-abort.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toBeNull();
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
