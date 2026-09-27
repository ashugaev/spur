import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentSubmitAckBinding,
  resumeAgentSubmitAckBinding,
} from "../../src/agents/index.js";
import type { SubmitAckBaseline } from "../../src/types.js";

// A daemon restart rebinds the live send's ack scan to the baseline persisted
// with the typed message. Per agent transcript shape: turns recorded before
// the send never count, a new matching turn does.

const TYPED = "go further please";
let root: string;
let worktreePath: string;
let codexSessionsDir: string;

function ctx(agentSessionId?: string) {
  return { worktreePath, codexSessionsDir, ...(agentSessionId ? { agentSessionId } : {}) };
}

// Survives a JSON round trip, as the persisted marker does.
function persisted(baseline: SubmitAckBaseline): SubmitAckBaseline {
  return JSON.parse(JSON.stringify(baseline)) as SubmitAckBaseline;
}

function jsonl(file: string, lines: unknown[], flag: "w" | "a" = "w"): void {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  if (flag === "w") writeFileSync(file, body);
  else appendFileSync(file, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spur-ack-resume-"));
  // Never an existing agent project dir, so no fallback transcript resolves.
  worktreePath = join(root, "worktree-never-resolved");
  codexSessionsDir = join(root, "codex-sessions");
  mkdirSync(codexSessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["XDG_DATA_HOME"];
});

describe("resumeAgentSubmitAckBinding", () => {
  it("claude: an earlier short turn or an earlier identical text never acks; a new turn does", async () => {
    const file = join(root, "claude.jsonl");
    const user = (content: string) => ({ type: "user", message: { role: "user", content } });
    jsonl(file, [user("go"), user(TYPED)]);
    const baseline = persisted({ agent: "claude", file, size: statSync(file).size });

    const before = await resumeAgentSubmitAckBinding("claude", ctx(), baseline);
    expect((await before?.scan(TYPED))?.found).toBe(false);

    jsonl(file, [user(TYPED)], "a");
    const after = await resumeAgentSubmitAckBinding("claude", ctx(), baseline);
    expect((await after?.scan(TYPED))?.found).toBe(true);
  });

  it("codex: an earlier short turn or an earlier identical text never acks; a new turn does", async () => {
    const file = join(codexSessionsDir, "rollout-1.jsonl");
    const user = (text: string) => ({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    jsonl(file, [user("go"), user(TYPED)]);
    const live = await createAgentSubmitAckBinding("codex", ctx());
    if (!live) throw new Error("codex binding missing");
    const baseline = persisted(live.baseline);

    const before = await resumeAgentSubmitAckBinding("codex", ctx(), baseline);
    expect((await before?.scan(TYPED))?.found).toBe(false);

    jsonl(file, [user(TYPED)], "a");
    const after = await resumeAgentSubmitAckBinding("codex", ctx(), baseline);
    expect((await after?.scan(TYPED))?.found).toBe(true);
  });

  it("cursor: an earlier short turn or an earlier identical text never acks; a new wrapped turn does", async () => {
    const file = join(root, "cursor.jsonl");
    const user = (text: string) => ({
      role: "user",
      message: { content: [{ type: "text", text }] },
    });
    jsonl(file, [user("go"), user(`<user_query>${TYPED}</user_query>`)]);
    const baseline = persisted({ agent: "cursor", file, size: statSync(file).size });

    const before = await resumeAgentSubmitAckBinding("cursor", ctx(), baseline);
    expect((await before?.scan(TYPED))?.found).toBe(false);

    jsonl(file, [user(`<timestamp>now</timestamp>\n<user_query>${TYPED}</user_query>`)], "a");
    const after = await resumeAgentSubmitAckBinding("cursor", ctx(), baseline);
    expect((await after?.scan(TYPED))?.found).toBe(true);
  });

  it("opencode: earlier user messages never ack; a new one does, even stored /cmd-expanded", async () => {
    const dataHome = join(root, "xdg");
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    process.env["XDG_DATA_HOME"] = dataHome;
    const db = new DatabaseSync(join(dataHome, "opencode", "opencode.db"));
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
    const insert = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    const userData = (text: string) => JSON.stringify({ role: "user", text });
    insert.run("msg_1", "ses_1", userData("go"));
    insert.run("msg_2", "ses_1", userData("/review x"));
    const live = await createAgentSubmitAckBinding("opencode", ctx("ses_1"));
    if (!live) throw new Error("opencode binding missing");
    const baseline = persisted(live.baseline);

    const before = await resumeAgentSubmitAckBinding("opencode", ctx("ses_1"), baseline);
    expect((await before?.scan("/review x"))?.found).toBe(false);

    // Stored expanded: the text never equals what was typed.
    insert.run("msg_3", "ses_1", userData("Review the following change set: x"));
    const after = await resumeAgentSubmitAckBinding("opencode", ctx("ses_1"), baseline);
    expect((await after?.scan("/review x"))?.found).toBe(true);
    db.close();
  });

  it("refuses a baseline recorded for another agent", async () => {
    const baseline = persisted({ agent: "cursor", file: join(root, "x.jsonl"), size: 0 });
    expect(await resumeAgentSubmitAckBinding("claude", ctx(), baseline)).toBeNull();
  });
});
