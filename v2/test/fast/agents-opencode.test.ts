import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findOpenCodeSessionId,
  readOpenCodeJson,
  buildOpenCodePlan,
  buildOpenCodeConfig,
  buildOpenCodeResumePlan,
  diffOpenCodeSessionIds,
  hasNewOpenCodeUserMessage,
  isSupportedOpenCodeVersion,
  OPENCODE_RESTRICT_WRITES_CONFIG,
  parseOpenCodeExport,
  parseOpenCodeSessionListOutput,
  parseOpenCodeState,
  waitForOpenCodeLaunchMessage,
  parseOpenCodeUserMessageIds,
  withOpenCodeLaunchIdentityLock,
} from "../../src/agents/opencode.js";

describe("OpenCode adapter", () => {
  it("launches with permission auto-approval and a selected model", () => {
    vi.stubEnv("SPUR_OPENCODE_BIN", "/opt/Open Code/opencode");
    expect(buildOpenCodePlan("work", { model: "openai/gpt-5" })).toEqual({
      launchCommand: "'/opt/Open Code/opencode' --auto --prompt 'work' --model 'openai/gpt-5'",
      initialMessage: "",
      initialMessageDeliveredOnLaunch: true,
      readyMarkers: ["commands"],
    });
    vi.unstubAllEnvs();
  });

  it("enforces the supported CLI floor", () => {
    expect(isSupportedOpenCodeVersion("1.18.17")).toBe(false);
    expect(isSupportedOpenCodeVersion("v1.18.18")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.19.0-dev")).toBe(true);
    expect(isSupportedOpenCodeVersion("unknown")).toBe(false);
  });

  it("denies edit tools and git writes in restrict-writes mode", () => {
    expect(JSON.parse(OPENCODE_RESTRICT_WRITES_CONFIG)).toEqual({
      permission: {
        edit: "deny",
        bash: { "*": "allow", "git commit*": "deny", "git push*": "deny" },
      },
    });
  });

  it("merges session MCP bindings with restrict-writes policy", () => {
    expect(
      JSON.parse(
        buildOpenCodeConfig([{ server: "playwright", url: "http://127.0.0.1:5001/mcp" }], true) ??
          "{}",
      ),
    ).toEqual({
      mcp: {
        playwright: {
          type: "remote",
          url: "http://127.0.0.1:5001/mcp",
          enabled: true,
        },
      },
      permission: {
        edit: "deny",
        bash: { "*": "allow", "git commit*": "deny", "git push*": "deny" },
      },
    });
  });

  it("resumes the exact native session id", () => {
    expect(buildOpenCodeResumePlan("ses_123", "opencode").launchCommand).toBe(
      "'opencode' --auto --session 'ses_123'",
    );
  });

  it("binds only the single session created after launch", () => {
    const baseline = { worktreePath: "/repo", sessionIds: new Set(["ses_existing"]) };
    expect(diffOpenCodeSessionIds(baseline, new Set(["ses_existing", "ses_owned"]))).toBe(
      "ses_owned",
    );
    expect(diffOpenCodeSessionIds(baseline, new Set(["ses_existing"]))).toBeNull();
    expect(() =>
      diffOpenCodeSessionIds(baseline, new Set(["ses_existing", "ses_sibling_a", "ses_sibling_b"])),
    ).toThrow("refusing ambiguous identity");
  });

  it("treats OpenCode's blank empty-session list as an empty baseline", () => {
    expect(parseOpenCodeSessionListOutput("\n")).toEqual([]);
    expect(() => parseOpenCodeSessionListOutput("not json")).toThrow();
  });

  it("serializes fresh identity binding for concurrent launches in one worktree", async () => {
    const sessions = new Set(["ses_existing"]);
    let releaseFirst: () => void = () => {};
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered: string[] = [];

    const first = withOpenCodeLaunchIdentityLock("/repo", async () => {
      entered.push("first");
      const baseline = { worktreePath: "/repo", sessionIds: new Set(sessions) };
      sessions.add("ses_first");
      await firstMayFinish;
      return diffOpenCodeSessionIds(baseline, sessions);
    });
    const second = withOpenCodeLaunchIdentityLock("/repo", async () => {
      entered.push("second");
      const baseline = { worktreePath: "/repo", sessionIds: new Set(sessions) };
      sessions.add("ses_second");
      return diffOpenCodeSessionIds(baseline, sessions);
    });

    await Promise.resolve();
    expect(entered).toEqual(["first"]);
    releaseFirst();
    await expect(first).resolves.toBe("ses_first");
    await expect(second).resolves.toBe("ses_second");
    expect(entered).toEqual(["first", "second"]);
  });

  it("reads user and assistant text from an exported session", () => {
    expect(
      parseOpenCodeExport({
        messages: [
          { info: { role: "user" }, parts: [{ type: "text", text: "one" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "two" }] },
          { info: { role: "assistant" }, parts: [{ type: "tool", name: "bash" }] },
        ],
      }),
    ).toEqual([
      { kind: "message", role: "user", text: "one" },
      { kind: "message", role: "assistant", text: "two" },
    ]);
  });

  it("confirms delivery by user message id, not by the text OpenCode persisted", () => {
    // OpenCode stores a slash-command prompt expanded, so the persisted text
    // never equals what Spur sent; only the new id proves the prompt landed.
    const exported = {
      messages: [
        { info: { role: "user", id: "msg_1" }, parts: [{ type: "text", text: "EXPANDED SKILL" }] },
        { info: { role: "assistant", id: "msg_2" }, parts: [] },
      ],
    };
    const ids = parseOpenCodeUserMessageIds(exported);
    expect([...ids]).toEqual(["msg_1"]);
    expect(hasNewOpenCodeUserMessage({ sessionId: "ses_1", userMessageIds: new Set() }, ids)).toBe(
      true,
    );
    expect(
      hasNewOpenCodeUserMessage({ sessionId: "ses_1", userMessageIds: new Set(["msg_1"]) }, ids),
    ).toBe(false);
  });

  it("classifies structured busy, completed, and error messages", () => {
    expect(parseOpenCodeState({ messages: [{ info: { role: "user" } }] })).toEqual({
      state: "working",
      reason: "last role=user",
    });
    expect(
      parseOpenCodeState({
        messages: [{ info: { role: "assistant", time: { completed: 123 } } }],
      }),
    ).toEqual({ state: "waiting", reason: "assistant completed" });
    expect(
      parseOpenCodeState({
        messages: [{ info: { role: "assistant", error: { name: "ApiError" } } }],
      }),
    ).toEqual({ state: "error", reason: "assistant error" });
    expect(parseOpenCodeState({ messages: [{ info: { role: "assistant", time: {} } }] })).toEqual({
      state: "working",
      reason: "assistant incomplete",
    });
  });

  it("classifies real export shapes without inventing live-service state", () => {
    expect(
      parseOpenCodeState({
        info: { id: "ses_1" },
        messages: [
          {
            info: { role: "assistant", time: {} },
            parts: [{ type: "tool", tool: "question", state: { status: "running" } }],
          },
        ],
      }),
    ).toEqual({ state: "working", reason: "assistant incomplete" });
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              role: "assistant",
              error: { name: "APIError", data: { statusCode: 429, message: "Too Many Requests" } },
            },
          },
        ],
      }),
    ).toEqual({ state: "rate_limited", reason: "assistant rate limit" });
    expect(parseOpenCodeState({ messages: "malformed" })).toBeNull();
  });

  it("captures CLI output past the pipe truncation and buffer limits", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
    const binPath = join(binDir, "opencode");
    await writeFile(
      binPath,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(JSON.stringify({ blob: "x".repeat(2_000_000) }));',
      ].join("\n"),
      "utf8",
    );
    await chmod(binPath, 0o755);
    vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
    try {
      const stdout = await readOpenCodeJson(["export", "ses_big"], { timeoutMs: 20_000 });
      expect(JSON.parse(stdout)).toEqual({ blob: "x".repeat(2_000_000) });
    } finally {
      vi.unstubAllEnvs();
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("picks the newest session from a top-level updated timestamp", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
    const worktree = await mkdtemp(join(tmpdir(), "spur-opencode-wt-"));
    const binPath = join(binDir, "opencode");
    await writeFile(
      binPath,
      [
        "#!/usr/bin/env node",
        "const sessions = [",
        `  { id: "ses_old", directory: ${JSON.stringify(worktree)}, updated: 10 },`,
        `  { id: "ses_new", directory: ${JSON.stringify(worktree)}, updated: 20 },`,
        `  { id: "ses_other", directory: "/elsewhere", updated: 30 },`,
        "];",
        "process.stdout.write(JSON.stringify(sessions));",
      ].join("\n"),
      "utf8",
    );
    await chmod(binPath, 0o755);
    vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
    try {
      await expect(findOpenCodeSessionId(worktree)).resolves.toBe("ses_new");
    } finally {
      vi.unstubAllEnvs();
      await rm(binDir, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("accepts a launch prompt OpenCode persisted under expanded slash-command text", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
    const binPath = join(binDir, "opencode");
    await writeFile(
      binPath,
      [
        "#!/usr/bin/env node",
        "const exported = {",
        "  messages: [",
        '    { info: { role: "user", id: "msg_1" }, parts: [{ type: "text", text: "EXPANDED SKILL BODY" }] },',
        "  ],",
        "};",
        "process.stdout.write(JSON.stringify(exported));",
      ].join("\n"),
      "utf8",
    );
    await chmod(binPath, 0o755);
    vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
    try {
      await expect(waitForOpenCodeLaunchMessage("ses_launch", 5_000)).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
