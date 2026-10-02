import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findOpenCodeSessionId,
  readOpenCodeConversation,
  readOpenCodeJson,
  readOpenCodeState,
  readOpenCodeStructuredState,
  invalidateOpenCodeState,
  resetOpenCodeExportState,
  buildOpenCodePlan,
  buildOpenCodeConfig,
  buildOpenCodeResumePlan,
  buildOpenCodeRestorePlan,
  captureOpenCodeSubmitBaseline,
  diffOpenCodeSessionIds,
  hasOpenCodeUserMessageAfter,
  isSupportedOpenCodeVersion,
  openCodeDatabasePath,
  OPENCODE_EXPORT_MAX_CONCURRENCY,
  OPENCODE_RESTRICT_WRITES_CONFIG,
  parseOpenCodeExport,
  parseOpenCodeSessionListOutput,
  parseOpenCodeState,
  parseOpenCodeTokenUsage,
  readOpenCodeLatestUserMessageFromDatabase,
  scanOpenCodeForNewUserMessage,
  scanOpenCodeForTypedMessage,
  parseOpenCodeUserTextsAfter,
  waitForOpenCodeLaunchMessage,
  parseOpenCodeLatestUserMessage,
  withOpenCodeLaunchIdentityLock,
} from "../../src/agents/opencode.js";

describe("OpenCode adapter", () => {
  it("combines selected variant with MCP and permissions without replacing native selected options", () => {
    const config = JSON.parse(
      buildOpenCodeConfig([{ server: "tools", url: "http://localhost/mcp" }], true, {
        model: "provider/model/nested",
        reasoningEffort: "high",
        variantNames: ["low", "high", "custom"],
      }) ?? "{}",
    );
    expect(config.agent).toEqual({
      build: { model: "provider/model/nested", variant: "high" },
      plan: { model: "provider/model/nested", variant: "high" },
    });
    expect(config.provider).toEqual({
      provider: {
        models: {
          "model/nested": {
            variants: { low: { disabled: true }, custom: { disabled: true } },
          },
        },
      },
    });
    expect(config.mcp.tools).toEqual({
      type: "remote",
      url: "http://localhost/mcp",
      enabled: true,
    });
    expect(config.permission.edit).toBe("deny");
    const configContent = JSON.stringify(config);
    for (const command of [
      buildOpenCodePlan("work's task", { model: "provider/model/nested", configContent })
        .launchCommand,
      buildOpenCodeResumePlan("session's id", "opencode", {
        model: "provider/model/nested",
        configContent,
      }).launchCommand,
    ]) {
      expect(command).toContain(`OPENCODE_CONFIG_CONTENT='${configContent}'`);
      expect(command).toContain("--model 'provider/model/nested'");
      expect(command).not.toContain("--variant");
    }
  });

  it("omits config when no session settings exist", () => {
    expect(buildOpenCodeConfig(undefined, false)).toBeUndefined();
  });

  it("retains reasoning config and escaped variant keys on restore", async () => {
    const configContent =
      buildOpenCodeConfig(undefined, false, {
        model: "provider/model",
        reasoningEffort: "high",
        variantNames: ["high", "custom's"],
      }) ?? "";
    const plan = await buildOpenCodeRestorePlan("/repo", "restore", {
      model: "provider/model",
      sessionId: "ses_selected",
      configContent,
    });
    expect(plan?.launchCommand).toContain("OPENCODE_CONFIG_CONTENT=");
    expect(plan?.launchCommand).toContain('"custom\'\\\'\'s":{"disabled":true}');
    expect(plan?.launchCommand).toContain("--session 'ses_selected' --model 'provider/model'");
    expect(plan?.initialMessage).toBe("restore");
    expect(plan?.launchCommand).not.toMatch(/XDG_|--variant/);
  });
  it("extracts deduped structured components from a sanitized export fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/agent-history/opencode/token-components.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;

    expect(parseOpenCodeTokenUsage(fixture)).toEqual({
      provider: "opencode",
      generationId: "opencode:session-sanitized:msg-assistant-1",
      inputTokens: 50,
      outputTokens: 29,
      totalTokens: 79,
      cacheReadInputTokens: 34,
      cacheWriteInputTokens: 4,
      reasoningOutputTokens: 6,
    });
  });

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

  it("confirms delivery by a user message past the watermark, not by the text OpenCode persisted", () => {
    // OpenCode stores a slash-command prompt expanded, so the persisted text
    // never equals what Spur sent; only a newer user message proves it landed.
    const exported = {
      messages: [
        { info: { role: "user", id: "msg_0" }, parts: [] },
        {
          info: { role: "user", id: "msg_1", time: { created: 200 } },
          parts: [{ type: "text", text: "EXPANDED SKILL" }],
        },
        { info: { role: "user", id: "msg_a", time: { created: 100 } }, parts: [] },
        { info: { role: "assistant", id: "msg_2", time: { created: 300 } }, parts: [] },
      ],
    };
    // Newest user message by time; a user message with no time never counts.
    const latest = parseOpenCodeLatestUserMessage(exported);
    expect(latest).toEqual({ createdMs: 200, id: "msg_1" });
    expect(hasOpenCodeUserMessageAfter({ sessionId: "ses_1", after: null }, latest)).toBe(true);
    expect(
      hasOpenCodeUserMessageAfter(
        { sessionId: "ses_1", after: { createdMs: 200, id: "msg_1" } },
        latest,
      ),
    ).toBe(false);
    // Same millisecond: the id breaks the tie.
    expect(
      hasOpenCodeUserMessageAfter(
        { sessionId: "ses_1", after: { createdMs: 200, id: "msg_0" } },
        latest,
      ),
    ).toBe(true);
    expect(hasOpenCodeUserMessageAfter({ sessionId: "ses_1", after: null }, null)).toBe(false);
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
    ).toEqual({ state: "waiting", reason: "assistant completed", activityMs: 123 });
    expect(
      parseOpenCodeState({
        messages: [{ info: { role: "assistant", finish: "stop", time: { completed: 123 } } }],
      }),
    ).toEqual({ state: "waiting", reason: "assistant completed", activityMs: 123 });
    // A step that ended in tool calls leaves the turn running.
    expect(
      parseOpenCodeState({
        messages: [{ info: { role: "assistant", finish: "tool-calls", time: { completed: 123 } } }],
      }),
    ).toEqual({ state: "working", reason: "assistant step ended in tool calls", activityMs: 123 });
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

  it("classifies an aborted turn as waiting, not error, so it does not wedge", () => {
    // Verbatim from opencode-ai 1.18.30 opencode.db (real aborted turn), minus
    // `path` (absolute local paths).
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              parentID: "msg_0278c2c95001O27KIcRuIDMm95",
              role: "assistant",
              mode: "build",
              agent: "build",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: "gemini-3.8-flash",
              providerID: "google",
              time: { created: 1787369893115, completed: 1787369901319 },
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          },
        ],
      }),
    ).toEqual({ state: "waiting", reason: "assistant aborted", activityMs: 1787369901319 });

    // Rate limit takes priority over the abort classification.
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              role: "assistant",
              error: {
                name: "MessageAbortedError",
                data: { statusCode: 429, message: "Too Many Requests" },
              },
            },
          },
        ],
      }),
    ).toEqual({ state: "rate_limited", reason: "assistant rate limit" });

    // A non-allowlisted error with time.completed set still classifies as
    // error — proves the fix did not widen into "any completed turn waits".
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              error: { name: "APIError", data: { statusCode: 404, isRetryable: false } },
            },
          },
        ],
      }),
    ).toEqual({ state: "error", reason: "assistant error", activityMs: 2 });

    // Near-miss on name: substring/case matches must NOT be treated as
    // aborted. The allowlist is exact-match only.
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              error: { name: "MessageAbortedErrorLike", data: { message: "Aborted" } },
            },
          },
        ],
      }),
    ).toEqual({ state: "error", reason: "assistant error", activityMs: 2 });

    // Near-miss on case: lower-cased name must NOT be treated as aborted.
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              error: { name: "messageabortederror", data: { message: "Aborted" } },
            },
          },
        ],
      }),
    ).toEqual({ state: "error", reason: "assistant error", activityMs: 2 });
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

  describe("state reads", () => {
    afterEach(() => {
      resetOpenCodeExportState();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    // Writes one line per invocation, carrying the exported session id, so the
    // test counts spawns per session rather than trusting the cache's own
    // bookkeeping.
    async function stubCountingOpenCode(options?: {
      exitCode?: number;
      output?: unknown;
    }): Promise<{ dir: string; countPath: string }> {
      const dir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
      const countPath = join(dir, "calls.log");
      await writeFile(
        join(dir, "opencode"),
        [
          "#!/usr/bin/env node",
          `require("node:fs").appendFileSync(${JSON.stringify(countPath)}, process.argv[process.argv.length - 1] + "\\n");`,
          ...(options?.exitCode
            ? [`process.exit(${options.exitCode});`]
            : [
                `process.stdout.write(${JSON.stringify(
                  JSON.stringify(
                    options?.output ?? {
                      messages: [{ info: { role: "assistant", time: { completed: 1 } } }],
                    },
                  ),
                )});`,
              ]),
        ].join("\n"),
        "utf8",
      );
      await chmod(join(dir, "opencode"), 0o755);
      vi.stubEnv("SPUR_OPENCODE_BIN", join(dir, "opencode"));
      // No opencode.db here: these reads take the export fallback.
      vi.stubEnv("XDG_DATA_HOME", join(dir, "no-data"));
      return { dir, countPath };
    }

    async function spawnLines(countPath: string): Promise<string[]> {
      try {
        return (await readFile(countPath, "utf8")).split("\n").filter((line) => line.length > 0);
      } catch {
        return [];
      }
    }

    async function spawnCount(countPath: string): Promise<number> {
      return (await spawnLines(countPath)).length;
    }

    async function spawnCountFor(countPath: string, sessionId: string): Promise<number> {
      return (await spawnLines(countPath)).filter((line) => line === sessionId).length;
    }

    it("shares one export across concurrent reads of the same session", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        const results = await Promise.all([
          readOpenCodeState("ses_a"),
          readOpenCodeState("ses_a"),
          readOpenCodeState("ses_a"),
        ]);

        expect(results).toEqual([
          { state: "waiting", reason: "assistant completed", activityMs: 1 },
          { state: "waiting", reason: "assistant completed", activityMs: 1 },
          { state: "waiting", reason: "assistant completed", activityMs: 1 },
        ]);
        expect(await spawnCount(countPath)).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("shares one cached export between state and token usage", async () => {
      const { dir, countPath } = await stubCountingOpenCode({
        output: {
          info: { id: "ses_a" },
          messages: [
            {
              info: {
                id: "msg_a",
                role: "assistant",
                time: { completed: 1 },
                tokens: {
                  input: 10,
                  output: 5,
                  reasoning: 2,
                  cache: { read: 3, write: 1 },
                },
              },
            },
          ],
        },
      });
      try {
        const structured = await readOpenCodeStructuredState("ses_a");
        const state = await readOpenCodeState("ses_a");

        expect(structured.tokenUsage).toMatchObject({
          inputTokens: 14,
          outputTokens: 7,
          totalTokens: 21,
        });
        expect(state).toMatchObject({ state: "waiting", reason: "assistant completed" });
        expect(await spawnCount(countPath)).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("forces one fresh structured export after the agent exits", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        await readOpenCodeStructuredState("ses_a");
        await readOpenCodeStructuredState("ses_a");
        expect(await spawnCount(countPath)).toBe(1);
        await readOpenCodeStructuredState("ses_a", null, true);
        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("serves a repeat read from cache and re-exports once the TTL passes", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await readOpenCodeState("ses_a");
        expect(await spawnCount(countPath)).toBe(1);
        // Anchor on the clock the entry was actually stamped with: with
        // shouldAdvanceTime the stub's own spawn cost moves the fake clock, so
        // an absolute instant would shrink the margin by however long node took
        // to start.
        const cachedAt = Date.now();

        vi.setSystemTime(cachedAt + 4_000);
        await readOpenCodeState("ses_a");
        expect(await spawnCount(countPath)).toBe(1);

        vi.setSystemTime(cachedAt + 6_000);
        await readOpenCodeState("ses_a");
        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("keys the cache per session", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        await readOpenCodeState("ses_a");
        await readOpenCodeState("ses_b");

        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("keeps a silent session cached while another session exports repeatedly", async () => {
      // The cross-session case: a post-export sweep bounded by the TTL deletes
      // every other session's entry on every completion, so one painting pane
      // would drag the whole silent fleet back into exporting. Two sessions are
      // the minimum that can observe that.
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const anchor = Date.now();
        const silent = anchor - 60_000;

        await readOpenCodeState("ses_active", anchor);
        await readOpenCodeState("ses_silent", silent);
        expect(await spawnCountFor(countPath, "ses_active")).toBe(1);
        expect(await spawnCountFor(countPath, "ses_silent")).toBe(1);

        for (let step = 1; step <= 10; step += 1) {
          const at = anchor + step * 6_000;
          vi.setSystemTime(at);
          await readOpenCodeState("ses_active", at);
          await readOpenCodeState("ses_silent", silent);
        }

        expect(await spawnCountFor(countPath, "ses_active")).toBe(11);
        expect(await spawnCountFor(countPath, "ses_silent")).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it("serves the cache past the TTL while the pane has printed nothing", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const silent = Date.now() - 60_000;
        await readOpenCodeState("ses_a", silent);
        expect(await spawnCount(countPath)).toBe(1);

        vi.setSystemTime(Date.now() + 30_000);
        await readOpenCodeState("ses_a", silent);

        expect(await spawnCount(countPath)).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("re-exports once the pane prints again", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const silent = Date.now() - 60_000;
        await readOpenCodeState("ses_a", silent);
        const cachedAt = Date.now();

        vi.setSystemTime(cachedAt + 6_000);
        await readOpenCodeState("ses_a", cachedAt + 5_000);

        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("re-exports at the max-age ceiling with a silent pane", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const silent = Date.now() - 60_000;
        await readOpenCodeState("ses_a", silent);
        const cachedAt = Date.now();

        vi.setSystemTime(cachedAt + 601_000);
        await readOpenCodeState("ses_a", silent);

        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("does not suppress when the activity token is null", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await readOpenCodeState("ses_a", null);
        const cachedAt = Date.now();

        vi.setSystemTime(cachedAt + 6_000);
        await readOpenCodeState("ses_a", null);

        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("does not suppress when the pane printed within the settle margin", async () => {
      const { dir, countPath } = await stubCountingOpenCode();
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // window_activity has one-second resolution, so a paint 0.4s after this
        // export starts still reports this same token. The gate must not trust
        // itself here.
        const justPrinted = Date.now() - 1_000;
        await readOpenCodeState("ses_a", justPrinted);
        const cachedAt = Date.now();

        vi.setSystemTime(cachedAt + 6_000);
        await readOpenCodeState("ses_a", justPrinted);

        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("never pins a failed export on a silent pane", async () => {
      // A failed export caches null and the classifier reads null as "working".
      // Pinning that to the ceiling would hold a wrong live state, not a stale
      // one, so a cached null always retries on the TTL.
      const { dir, countPath } = await stubCountingOpenCode({ exitCode: 1 });
      try {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const silent = Date.now() - 60_000;
        expect(await readOpenCodeState("ses_a", silent)).toBeNull();
        const cachedAt = Date.now();

        vi.setSystemTime(cachedAt + 6_000);
        await readOpenCodeState("ses_a", silent);

        expect(await spawnCount(countPath)).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("saturates the export ceiling and never exceeds it", async () => {
      // Distinct ids, so neither the TTL cache nor the in-flight share applies:
      // what bounds these is the export gate alone. The fan-out is a literal
      // rather than a multiple of the limit — a test that sizes its own
      // workload from the constant it asserts against passes at any value of
      // that constant, including one high enough to bring the storm back.
      const CONCURRENT_READS = 8;
      // Pinned, not merely bounded: the limit is what holds the storm down, so
      // raising it has to fail here and be changed on purpose.
      expect(OPENCODE_EXPORT_MAX_CONCURRENCY).toBe(4);
      expect(OPENCODE_EXPORT_MAX_CONCURRENCY).toBeLessThan(CONCURRENT_READS);

      const dir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
      const logPath = join(dir, "spans.log");
      try {
        await writeFile(
          join(dir, "opencode"),
          [
            "#!/usr/bin/env node",
            'const fs = require("node:fs");',
            `const log = ${JSON.stringify(logPath)};`,
            `const limit = ${JSON.stringify(OPENCODE_EXPORT_MAX_CONCURRENCY)};`,
            "function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }",
            "function liveCount() {",
            '  const spans = fs.readFileSync(log, "utf8");',
            "  let live = 0;",
            '  for (const mark of spans) live += mark === "+" ? 1 : -1;',
            "  return live;",
            "}",
            'fs.appendFileSync(log, "+");',
            // Spawn stagger, not a fixed hold, decides the peak on a loaded
            // host: wait until the log itself shows `limit` exports in
            // flight (polling so a narrow gate is caught rather than
            // trusted), capped so a broken gate fails fast instead of
            // hanging, then hold an extra fixed window so a gate that is
            // too wide still has time to show peak > limit.
            "const deadline = Date.now() + 4_000;",
            "while (liveCount() < limit && Date.now() < deadline) sleep(10);",
            "sleep(300);",
            'fs.appendFileSync(log, "-");',
            'process.stdout.write(JSON.stringify({ messages: [{ info: { role: "assistant", time: { completed: 1 } } }] }));',
          ].join("\n"),
          "utf8",
        );
        await chmod(join(dir, "opencode"), 0o755);
        vi.stubEnv("SPUR_OPENCODE_BIN", join(dir, "opencode"));
        vi.stubEnv("XDG_DATA_HOME", join(dir, "no-data"));

        const ids = Array.from({ length: CONCURRENT_READS }, (_, i) => `ses_${i}`);
        await Promise.all(ids.map((id) => readOpenCodeState(id)));

        const spans = await readFile(logPath, "utf8");
        let live = 0;
        let peak = 0;
        for (const mark of spans) {
          live += mark === "+" ? 1 : -1;
          peak = Math.max(peak, live);
        }
        expect(spans.length).toBe(ids.length * 2);
        // Equality, not an upper bound: demand exceeds the gate here, so a
        // correct gate runs exactly the limit at once. An upper bound alone
        // also passes when the gate never opens far enough to be useful.
        expect(peak).toBe(OPENCODE_EXPORT_MAX_CONCURRENCY);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("releases the export slot when the export fails", async () => {
      // A slot leaked on the throw path is invisible until the limit is used
      // up, and then every export in the process blocks forever. Fail more
      // times than the gate is wide, then read successfully: with a leak, the
      // last read never resolves and this test times out instead of failing an
      // assertion.
      const failDir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
      const okDir = await mkdtemp(join(tmpdir(), "spur-opencode-bin-"));
      try {
        await writeFile(
          join(failDir, "opencode"),
          ["#!/usr/bin/env node", "process.exit(1);"].join("\n"),
          "utf8",
        );
        await chmod(join(failDir, "opencode"), 0o755);
        vi.stubEnv("SPUR_OPENCODE_BIN", join(failDir, "opencode"));
        vi.stubEnv("XDG_DATA_HOME", join(failDir, "no-data"));

        for (let i = 0; i <= OPENCODE_EXPORT_MAX_CONCURRENCY; i += 1) {
          expect(await readOpenCodeState(`ses_fail_${i}`)).toBeNull();
        }

        await writeFile(
          join(okDir, "opencode"),
          [
            "#!/usr/bin/env node",
            'process.stdout.write(JSON.stringify({ messages: [{ info: { role: "assistant", time: { completed: 1 } } }] }));',
          ].join("\n"),
          "utf8",
        );
        await chmod(join(okDir, "opencode"), 0o755);
        vi.stubEnv("SPUR_OPENCODE_BIN", join(okDir, "opencode"));

        expect(await readOpenCodeState("ses_ok")).toEqual({
          state: "waiting",
          reason: "assistant completed",
          activityMs: 1,
        });
      } finally {
        await rm(failDir, { recursive: true, force: true });
        await rm(okDir, { recursive: true, force: true });
      }
      // Explicit, well under the runner default: a leaked slot hangs here, and
      // the point is a fast attributable timeout rather than a 30s stall. The
      // headroom is deliberate — this spawns six stub processes serially, and
      // a contended run near 1s per cold start must not time out, or the
      // timeout stops meaning "leaked slot".
    }, 20_000);
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
        '    { info: { role: "user", id: "msg_1", time: { created: 1790546673635 } }, parts: [{ type: "text", text: "EXPANDED SKILL BODY" }] },',
        "  ],",
        "};",
        "process.stdout.write(JSON.stringify(exported));",
      ].join("\n"),
      "utf8",
    );
    await chmod(binPath, 0o755);
    vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
    // No opencode.db under this data home: the check answers from the CLI export.
    vi.stubEnv("XDG_DATA_HOME", join(binDir, "no-data"));
    try {
      await expect(waitForOpenCodeLaunchMessage("ses_launch", 5_000)).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(binDir, { recursive: true, force: true });
    }
  });

  describe("submit ack from opencode.db", () => {
    async function makeDatabase(dataHome: string): Promise<DatabaseSync> {
      await mkdir(join(dataHome, "opencode"), { recursive: true });
      const database = new DatabaseSync(join(dataHome, "opencode", "opencode.db"));
      database.exec(
        "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
      );
      return database;
    }

    function insert(
      database: DatabaseSync,
      id: string,
      sessionId: string,
      role: string,
      createdMs = 0,
    ): void {
      database
        .prepare("INSERT INTO message VALUES (?, ?, ?, 0, ?)")
        .run(id, sessionId, createdMs, JSON.stringify({ role }));
    }

    it("reads the session's newest user message, by time then id", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      const database = await makeDatabase(dataHome);
      insert(database, "msg_u2", "ses_1", "user", 100);
      insert(database, "msg_u1", "ses_1", "user", 200);
      insert(database, "msg_u0", "ses_1", "user", 200);
      insert(database, "msg_a1", "ses_1", "assistant", 300);
      insert(database, "msg_u9", "ses_other", "user", 400);
      database.close();
      const path = openCodeDatabasePath({ XDG_DATA_HOME: dataHome });
      try {
        await expect(readOpenCodeLatestUserMessageFromDatabase("ses_1", path)).resolves.toEqual({
          createdMs: 200,
          id: "msg_u1",
        });
        await expect(readOpenCodeLatestUserMessageFromDatabase("ses_none", path)).resolves.toBe(
          null,
        );
      } finally {
        await rm(dataHome, { recursive: true, force: true });
      }
    });

    // `opencode export` costs 2-4s per call; the ack scan polls every 250ms.
    it("acks a new user message from the database without spawning the CLI", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      const database = await makeDatabase(dataHome);
      insert(database, "msg_u1", "ses_1", "user");
      const binPath = join(dataHome, "opencode-bin");
      const spawnedMarker = join(dataHome, "spawned");
      await writeFile(
        binPath,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "1");\nprocess.stdout.write("{}");\n`,
        "utf8",
      );
      await chmod(binPath, 0o755);
      vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
      vi.stubEnv("XDG_DATA_HOME", dataHome);
      try {
        const baseline = await captureOpenCodeSubmitBaseline("ses_1");
        if (!baseline) throw new Error("expected a baseline");
        await expect(scanOpenCodeForNewUserMessage(baseline)).resolves.toBe(false);
        insert(database, "msg_u2", "ses_1", "user");
        await expect(scanOpenCodeForNewUserMessage(baseline)).resolves.toBe(true);
        await expect(readFile(spawnedMarker, "utf8")).rejects.toThrow();
      } finally {
        database.close();
        vi.unstubAllEnvs();
        await rm(dataHome, { recursive: true, force: true });
      }
    });

    // The user's own input, or a ToDo nudge, past the watermark is not the
    // ack of a text opencode never got; a slash command is stored expanded.
    it("acks a typed text only by a new user message that carries it, a slash command by any", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      const database = await makeDatabase(dataHome);
      database.exec(
        "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
      );
      const addPart = (id: string, messageId: string, text: string) =>
        database
          .prepare("INSERT INTO part VALUES (?, ?, 'ses_1', 0, 0, ?)")
          .run(id, messageId, JSON.stringify({ type: "text", text }));
      insert(database, "msg_u1", "ses_1", "user", 100);
      addPart("prt_1", "msg_u1", "Marker QA1: reply ok");
      vi.stubEnv("XDG_DATA_HOME", dataHome);
      try {
        const baseline = await captureOpenCodeSubmitBaseline("ses_1");
        if (!baseline) throw new Error("expected a baseline");
        insert(database, "msg_u2", "ses_1", "user", 200);
        addPart("prt_2", "msg_u2", "Reply with the single word pong.");
        await expect(scanOpenCodeForTypedMessage(baseline, "Marker QA1: reply ok")).resolves.toBe(
          false,
        );
        await expect(scanOpenCodeForTypedMessage(baseline, "/review 986")).resolves.toBe(true);
        insert(database, "msg_u3", "ses_1", "user", 300);
        addPart("prt_3", "msg_u3", "Marker   QA1:\r\nreply ok");
        await expect(scanOpenCodeForTypedMessage(baseline, "Marker QA1: reply ok")).resolves.toBe(
          true,
        );
      } finally {
        database.close();
        vi.unstubAllEnvs();
        await rm(dataHome, { recursive: true, force: true });
      }
    });

    it("reads the texts of user messages past a watermark from an export", () => {
      const exported = {
        messages: [
          {
            info: { id: "m1", role: "user", time: { created: 100 } },
            parts: [{ type: "text", text: "old" }],
          },
          {
            info: { id: "m2", role: "assistant", time: { created: 150 } },
            parts: [{ type: "text", text: "a" }],
          },
          {
            info: { id: "m3", role: "user", time: { created: 200 } },
            parts: [{ type: "text", text: "new" }],
          },
        ],
      };
      expect(parseOpenCodeUserTextsAfter(exported, { createdMs: 100, id: "m1" })).toEqual(["new"]);
      expect(parseOpenCodeUserTextsAfter(exported, null)).toEqual(["old", "new"]);
    });
  });

  describe("state from opencode.db", () => {
    afterEach(() => {
      resetOpenCodeExportState();
      vi.unstubAllEnvs();
    });

    it("drops a cached state on a pane write, and never caches a read that spans one", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      await mkdir(join(dataHome, "opencode"), { recursive: true });
      const database = new DatabaseSync(join(dataHome, "opencode", "opencode.db"));
      database.exec(
        "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
      );
      const insert = database.prepare("INSERT INTO message VALUES (?, ?, ?, 0, ?)");
      const completed = JSON.stringify({ role: "assistant", time: { completed: 1 } });
      const user = JSON.stringify({ role: "user", time: { created: 1 } });
      insert.run("msg_1", "ses_1", 100, completed);
      vi.stubEnv("XDG_DATA_HOME", dataHome);
      try {
        expect((await readOpenCodeState("ses_1"))?.state).toBe("waiting");
        // A Send now lands: the cached "waiting" must not survive it.
        insert.run("msg_2", "ses_1", 200, user);
        expect((await readOpenCodeState("ses_1"))?.state).toBe("waiting");
        invalidateOpenCodeState("ses_1");
        expect((await readOpenCodeState("ses_1"))?.state).toBe("working");

        // A read started before a write returns to its caller but is not cached.
        insert.run("msg_3", "ses_1", 300, completed);
        invalidateOpenCodeState("ses_1");
        const spanning = readOpenCodeState("ses_1");
        invalidateOpenCodeState("ses_1");
        expect((await spanning)?.state).toBe("waiting");
        insert.run("msg_4", "ses_1", 400, user);
        expect((await readOpenCodeState("ses_1"))?.state).toBe("working");
      } finally {
        database.close();
        await rm(dataHome, { recursive: true, force: true });
      }
    });

    it("classifies from the session's last message row without spawning the CLI", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      await mkdir(join(dataHome, "opencode"), { recursive: true });
      const database = new DatabaseSync(join(dataHome, "opencode", "opencode.db"));
      database.exec(
        "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
      );
      const insert = database.prepare("INSERT INTO message VALUES (?, ?, ?, 0, ?)");
      insert.run(
        "msg_1",
        "ses_busy",
        100,
        JSON.stringify({ role: "assistant", time: { completed: 1 } }),
      );
      insert.run(
        "msg_2",
        "ses_busy",
        200,
        JSON.stringify({ role: "user", time: { created: 200 } }),
      );
      insert.run(
        "msg_3",
        "ses_idle",
        100,
        JSON.stringify({ role: "user", time: { created: 100 } }),
      );
      // Same millisecond as the user turn: the id orders it last.
      insert.run(
        "msg_4",
        "ses_idle",
        100,
        JSON.stringify({ role: "assistant", time: { created: 100, completed: 150 } }),
      );
      insert.run(
        "msg_5",
        "ses_tools",
        100,
        JSON.stringify({ role: "assistant", finish: "tool-calls", time: { completed: 150 } }),
      );
      database.close();
      const binPath = join(dataHome, "opencode-bin");
      const spawnedMarker = join(dataHome, "spawned");
      await writeFile(
        binPath,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "1");\nprocess.stdout.write("{}");\n`,
        "utf8",
      );
      await chmod(binPath, 0o755);
      vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
      vi.stubEnv("XDG_DATA_HOME", dataHome);
      try {
        await expect(readOpenCodeState("ses_busy")).resolves.toEqual({
          state: "working",
          reason: "last role=user",
          activityMs: 200,
        });
        await expect(readOpenCodeState("ses_idle")).resolves.toEqual({
          state: "waiting",
          reason: "assistant completed",
          activityMs: 150,
        });
        await expect(readOpenCodeState("ses_tools")).resolves.toEqual({
          state: "working",
          reason: "assistant step ended in tool calls",
          activityMs: 150,
        });
        await expect(readOpenCodeState("ses_none")).resolves.toBeNull();
        await expect(readFile(spawnedMarker, "utf8")).rejects.toThrow();
      } finally {
        await rm(dataHome, { recursive: true, force: true });
      }
    });
  });

  describe("conversation from opencode.db", () => {
    async function makeDatabase(dataHome: string): Promise<DatabaseSync> {
      await mkdir(join(dataHome, "opencode"), { recursive: true });
      const database = new DatabaseSync(join(dataHome, "opencode", "opencode.db"));
      database.exec(
        "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
      );
      database.exec(
        "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
      );
      return database;
    }

    function insertMessage(
      database: DatabaseSync,
      message: { id: string; sessionId: string; role: string; createdAt: number },
      parts: Array<{ id: string; data: Record<string, unknown> }>,
    ): void {
      database
        .prepare("INSERT INTO message VALUES (?, ?, ?, 0, ?)")
        .run(
          message.id,
          message.sessionId,
          message.createdAt,
          JSON.stringify({ role: message.role }),
        );
      for (const part of parts) {
        database
          .prepare("INSERT INTO part VALUES (?, ?, ?, 0, 0, ?)")
          .run(part.id, message.id, message.sessionId, JSON.stringify(part.data));
      }
    }

    async function fakeOpenCodeBin(dataHome: string, exportJson: unknown): Promise<string> {
      const binPath = join(dataHome, "opencode-bin");
      const spawnedMarker = join(dataHome, "spawned");
      await writeFile(
        binPath,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "1");\nprocess.stdout.write(${JSON.stringify(JSON.stringify(exportJson))});\n`,
        "utf8",
      );
      await chmod(binPath, 0o755);
      vi.stubEnv("SPUR_OPENCODE_BIN", binPath);
      vi.stubEnv("XDG_DATA_HOME", dataHome);
      return spawnedMarker;
    }

    it("reads the session's text parts in order without spawning the CLI", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      const database = await makeDatabase(dataHome);
      // Inserted out of order: the read orders by message time, then part id.
      insertMessage(
        database,
        { id: "msg_a1", sessionId: "ses_1", role: "assistant", createdAt: 2 },
        [
          { id: "prt_a3", data: { type: "text", text: "world" } },
          { id: "prt_a1", data: { type: "step-start" } },
          { id: "prt_a2", data: { type: "text", text: "hello" } },
          { id: "prt_a4", data: { type: "tool", tool: "bash", state: { output: "ls" } } },
        ],
      );
      insertMessage(database, { id: "msg_u1", sessionId: "ses_1", role: "user", createdAt: 1 }, [
        { id: "prt_u1", data: { type: "text", text: "hi" } },
      ]);
      insertMessage(
        database,
        { id: "msg_o1", sessionId: "ses_other", role: "user", createdAt: 0 },
        [{ id: "prt_o1", data: { type: "text", text: "other session" } }],
      );
      database.close();
      const spawnedMarker = await fakeOpenCodeBin(dataHome, { messages: [] });
      try {
        await expect(readOpenCodeConversation("ses_1")).resolves.toEqual([
          { kind: "message", role: "user", text: "hi" },
          { kind: "message", role: "assistant", text: "hello\nworld" },
        ]);
        await expect(readFile(spawnedMarker, "utf8")).rejects.toThrow();
      } finally {
        vi.unstubAllEnvs();
        await rm(dataHome, { recursive: true, force: true });
      }
    });

    it("falls back to the CLI export when the database is unreadable", async () => {
      const dataHome = await mkdtemp(join(tmpdir(), "spur-opencode-db-"));
      const spawnedMarker = await fakeOpenCodeBin(dataHome, {
        messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "from export" }] }],
      });
      try {
        await expect(readOpenCodeConversation("ses_1")).resolves.toEqual([
          { kind: "message", role: "user", text: "from export" },
        ]);
        await expect(readFile(spawnedMarker, "utf8")).resolves.toBe("1");
      } finally {
        vi.unstubAllEnvs();
        await rm(dataHome, { recursive: true, force: true });
      }
    });
  });
});
