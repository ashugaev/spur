import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentLaunchPlan } from "../../src/agents/index.js";
import {
  findOpenCodeSessionId,
  readOpenCodeJson,
  readOpenCodeState,
  resetOpenCodeExportState,
  buildOpenCodePlan,
  buildOpenCodeConfig,
  buildOpenCodeResumePlan,
  diffOpenCodeSessionIds,
  hasNewOpenCodeUserMessage,
  isSupportedOpenCodeVersion,
  OPENCODE_EXPORT_MAX_CONCURRENCY,
  OPENCODE_RESTRICT_WRITES_CONFIG,
  parseOpenCodeExport,
  parseOpenCodeSessionListOutput,
  parseOpenCodeState,
  waitForOpenCodeLaunchMessage,
  parseOpenCodeUserMessageIds,
  withOpenCodeLaunchIdentityLock,
} from "../../src/agents/opencode.js";

describe("OpenCode adapter", () => {
  it("keeps deferred controls out of the launch command", () => {
    const handle = `ap1_${"a".repeat(43)}`;
    const plan = buildAgentLaunchPlan("opencode", "ordinary prompt", undefined, {
      text: handle,
      sensitive: true,
    });
    expect(plan.launchCommand).toContain("ordinary prompt");
    expect(plan.launchCommand).not.toContain(handle);
    expect(plan.initialMessage).not.toContain(handle);
    expect(plan.deferredSensitiveInitialMessage).toEqual({ text: handle, sensitive: true });
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
                'process.stdout.write(JSON.stringify({ messages: [{ info: { role: "assistant", time: { completed: 1 } } }] }));',
              ]),
        ].join("\n"),
        "utf8",
      );
      await chmod(join(dir, "opencode"), 0o755);
      vi.stubEnv("SPUR_OPENCODE_BIN", join(dir, "opencode"));
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
          { state: "waiting", reason: "assistant completed" },
          { state: "waiting", reason: "assistant completed" },
          { state: "waiting", reason: "assistant completed" },
        ]);
        expect(await spawnCount(countPath)).toBe(1);
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
            'fs.appendFileSync(log, "+");',
            "setTimeout(() => {",
            '  fs.appendFileSync(log, "-");',
            '  process.stdout.write(JSON.stringify({ messages: [{ info: { role: "assistant", time: { completed: 1 } } }] }));',
            // Held long enough that spawn stagger cannot decide the peak: at an
            // 80ms hold an early export can finish before the last one starts,
            // and the exact assertion below false-fails on a loaded host.
            "}, 500);",
          ].join("\n"),
          "utf8",
        );
        await chmod(join(dir, "opencode"), 0o755);
        vi.stubEnv("SPUR_OPENCODE_BIN", join(dir, "opencode"));

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
