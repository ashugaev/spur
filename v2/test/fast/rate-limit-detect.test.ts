import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeUsageMenuOptionOneSelected,
  detectClaudeCompacting,
  detectClaudeRateLimit,
  detectClaudeUsageLimitMenu,
  detectCodexMcpPermissionDialog,
  detectCodexRateLimit,
  detectCursorRateLimit,
  parseRateLimitResetAtMs,
  rateLimitExpired,
  scanTmuxRateLimit,
} from "../../src/rate-limit-detect.js";
import { parseJsonlRecord } from "../../src/claude-jsonl-state.js";
import { readCodexRolloutState } from "../../src/agents/codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Real codex token_count rate_limits payloads observed in production rollouts.
const CODEX_OUT_OF_CREDITS = {
  limit_id: "premium",
  primary: null,
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: null },
  plan_type: null,
  rate_limit_reached_type: null,
};
const CODEX_HEALTHY = {
  limit_id: "codex",
  primary: { used_percent: 61, window_minutes: 300 },
  secondary: { used_percent: 12, window_minutes: 10080 },
  credits: { has_credits: true, unlimited: false, balance: null },
  plan_type: "team",
  rate_limit_reached_type: null,
};
// Real ass-22bf false-positive payload: a team/window-metered account reports
// has_credits:false as a benign soft signal alongside a live 0%-used window.
const CODEX_TEAM_SOFT_CREDITS = {
  limit_id: "codex",
  primary: { used_percent: 0.0, window_minutes: 10080 },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: null },
  plan_type: "team",
  rate_limit_reached_type: null,
};

// Real claude synthetic rate-limit transcript record.
const CLAUDE_RATE_LIMIT_LINE = JSON.stringify({
  type: "assistant",
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  error: "rate_limit",
  message: {
    model: "<synthetic>",
    role: "assistant",
    stop_reason: "stop_sequence",
    content: [{ type: "text", text: "You've hit your session limit · resets 1pm (UTC)" }],
  },
});
const CLAUDE_NORMAL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Done." }],
  },
});

// Bookkeeping/pass-through records Claude Code appends after a turn — these
// carry no rate-limit signal and must be skipped when walking the tail
// backward for the last meaningful record.
const CLAUDE_TRAILING_SYSTEM_LINE = JSON.stringify({
  type: "system",
  subtype: "turn_duration",
  durationMs: 1234,
});
const CLAUDE_TRAILING_STOP_HOOK_LINE = JSON.stringify({
  type: "stop_hook_summary",
});
const CLAUDE_TRAILING_FILE_HISTORY_LINE = JSON.stringify({
  type: "file-history-snapshot",
});

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("detectCodexRateLimit", () => {
  it("flags out-of-credits via credits.has_credits=false", () => {
    expect(detectCodexRateLimit(CODEX_OUT_OF_CREDITS)).toEqual({
      limited: true,
      reason: "codex out of credits",
    });
  });

  it("flags a non-null rate_limit_reached_type", () => {
    expect(
      detectCodexRateLimit({ rate_limit_reached_type: "workspace_owner_credits_depleted" }),
    ).toEqual({ limited: true, reason: "codex workspace_owner_credits_depleted" });
  });

  it("flags an exhausted 5h window", () => {
    expect(detectCodexRateLimit({ primary: { used_percent: 100 } })).toEqual({
      limited: true,
      reason: "codex 5h window exhausted",
    });
  });

  it("returns not-limited when usable data shows headroom", () => {
    expect(detectCodexRateLimit(CODEX_HEALTHY)).toEqual({ limited: false, reason: "" });
  });

  it("does not flag has_credits:false when a live usage window is present (team/enterprise soft signal)", () => {
    expect(detectCodexRateLimit(CODEX_TEAM_SOFT_CREDITS)).toEqual({ limited: false, reason: "" });
  });

  it("does not flag has_credits:false when only the secondary window is live (primary null)", () => {
    expect(
      detectCodexRateLimit({
        limit_id: "codex",
        primary: null,
        secondary: { used_percent: 3, window_minutes: 10080 },
        credits: { has_credits: false, unlimited: false, balance: null },
        plan_type: "team",
        rate_limit_reached_type: null,
      }),
    ).toEqual({ limited: false, reason: "" });
  });

  it("still flags an exhausted window even when has_credits is false (guard doesn't mask genuine exhaustion)", () => {
    expect(
      detectCodexRateLimit({
        limit_id: "codex",
        primary: { used_percent: 100, window_minutes: 300 },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: null },
        plan_type: "team",
        rate_limit_reached_type: null,
      }),
    ).toEqual({ limited: true, reason: "codex 5h window exhausted" });
  });

  it("returns null when no usable rate_limits data is present", () => {
    expect(detectCodexRateLimit(null)).toBeNull();
    expect(detectCodexRateLimit(undefined)).toBeNull();
  });
});

describe("detectClaudeRateLimit", () => {
  it("flags a trailing synthetic rate_limit record", () => {
    const record = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    expect(record?.rateLimited).toBe(true);
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    expect(detectClaudeRateLimit([record])).toEqual({
      limited: true,
      reason: "claude rate_limit",
    });
  });

  it("is not limited when the latest meaningful record is normal", () => {
    const limit = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    const normal = parseJsonlRecord(CLAUDE_NORMAL_LINE, 1);
    expect(limit).toBeDefined();
    expect(normal).toBeDefined();
    if (!limit || !normal) {
      return;
    }
    expect(detectClaudeRateLimit([limit, normal])).toEqual({ limited: false, reason: "" });
  });

  it("returns null with no records", () => {
    expect(detectClaudeRateLimit([])).toBeNull();
  });

  it("flags a rate-limit record followed by a trailing system/turn_duration record", () => {
    const limit = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    const trailing = parseJsonlRecord(CLAUDE_TRAILING_SYSTEM_LINE, 1);
    expect(limit).toBeDefined();
    expect(trailing).toBeDefined();
    if (!limit || !trailing) {
      return;
    }
    expect(detectClaudeRateLimit([limit, trailing])).toEqual({
      limited: true,
      reason: "claude rate_limit",
    });
  });

  it("flags a rate-limit record followed by a stack of trailing bookkeeping records", () => {
    const limit = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    const system = parseJsonlRecord(CLAUDE_TRAILING_SYSTEM_LINE, 1);
    const stopHook = parseJsonlRecord(CLAUDE_TRAILING_STOP_HOOK_LINE, 2);
    const fileHistory = parseJsonlRecord(CLAUDE_TRAILING_FILE_HISTORY_LINE, 3);
    expect(limit).toBeDefined();
    expect(system).toBeDefined();
    expect(stopHook).toBeDefined();
    expect(fileHistory).toBeDefined();
    if (!limit || !system || !stopHook || !fileHistory) {
      return;
    }
    expect(detectClaudeRateLimit([limit, system, stopHook, fileHistory])).toEqual({
      limited: true,
      reason: "claude rate_limit",
    });
  });

  it("is not limited when a normal end_turn record is followed by a trailing system record", () => {
    const normal = parseJsonlRecord(CLAUDE_NORMAL_LINE, 0);
    const trailing = parseJsonlRecord(CLAUDE_TRAILING_SYSTEM_LINE, 1);
    expect(normal).toBeDefined();
    expect(trailing).toBeDefined();
    if (!normal || !trailing) {
      return;
    }
    expect(detectClaudeRateLimit([normal, trailing])).toEqual({ limited: false, reason: "" });
  });
});

describe("detectCursorRateLimit", () => {
  it("flags usage-limit marker text", () => {
    expect(detectCursorRateLimit("You've hit your usage limit")).toEqual({
      limited: true,
      reason: "cursor hit your usage limit",
    });
    expect(detectCursorRateLimit("You're out of usage. Switch to auto.")).toEqual({
      limited: true,
      reason: "cursor out of usage",
    });
  });

  it("is not limited for benign assistant text", () => {
    expect(detectCursorRateLimit("Patched the rate limiter middleware.")).toBeNull();
  });

  it("returns null without text", () => {
    expect(detectCursorRateLimit(null)).toBeNull();
  });
});

describe("detectClaudeUsageLimitMenu", () => {
  const MENU_TEXT = [
    "What do you want to do?",
    "",
    "> 1. Stop and wait for limit to reset",
    "  2. Ask your admin for more usage",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");

  it("flags the full realistic usage-limit menu", () => {
    expect(detectClaudeUsageLimitMenu(MENU_TEXT)).toEqual({
      limited: true,
      reason: "claude usage limit menu",
    });
  });

  it.each(["·", "-", "|", "/"])("flags the footer with the %s separator glyph", (separator) => {
    const paneText = [
      "What do you want to do?",
      "",
      "> 1. Stop and wait for limit to reset",
      "  2. Ask your admin for more usage",
      "",
      `Enter to confirm ${separator} Esc to cancel`,
    ].join("\n");
    expect(detectClaudeUsageLimitMenu(paneText)).toEqual({
      limited: true,
      reason: "claude usage limit menu",
    });
  });

  it("flags the menu when the cursor is on option 2 instead of option 1", () => {
    const paneText = [
      "What do you want to do?",
      "",
      "  1. Stop and wait for limit to reset",
      "> 2. Ask your admin for more usage",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(detectClaudeUsageLimitMenu(paneText)).toEqual({
      limited: true,
      reason: "claude usage limit menu",
    });
  });

  it("flags a lowercase/mixed-case variant of the same menu", () => {
    const lowerMenu = [
      "what do you want to do?",
      "",
      "> 1. sTOP and WAIT for limit TO reset",
      "  2. ask YOUR admin FOR more usage",
      "",
      "enter to confirm · esc to cancel",
    ].join("\n");
    expect(detectClaudeUsageLimitMenu(lowerMenu)).toEqual({
      limited: true,
      reason: "claude usage limit menu",
    });
  });

  it("returns null when only the option-1 line is present", () => {
    const paneText = [
      "What do you want to do?",
      "",
      "> 1. Stop and wait for limit to reset",
      "  2. Try again later",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(detectClaudeUsageLimitMenu(paneText)).toBeNull();
  });

  it("returns null when only the option-2 line is present", () => {
    const paneText = [
      "What do you want to do?",
      "",
      "> 1. Retry now",
      "  2. Ask your admin for more usage",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(detectClaudeUsageLimitMenu(paneText)).toBeNull();
  });

  it("returns null when both options are present but the footer line is not", () => {
    const paneText = [
      "What do you want to do?",
      "",
      "> 1. Stop and wait for limit to reset",
      "  2. Ask your admin for more usage",
    ].join("\n");
    expect(detectClaudeUsageLimitMenu(paneText)).toBeNull();
  });

  it("returns null for unrelated normal Claude Code output", () => {
    const paneText = ["Working on the task...", "Editing src/index.ts"].join("\n");
    expect(detectClaudeUsageLimitMenu(paneText)).toBeNull();
  });

  it("returns null for the detector source file's own raw contents (self-match regression guard)", () => {
    const source = readFileSync(resolve(__dirname, "../../src/rate-limit-detect.ts"), "utf8");
    expect(detectClaudeUsageLimitMenu(source)).toBeNull();
  });

  it("returns null for this test file's own raw contents (self-match regression guard)", () => {
    const source = readFileSync(resolve(__dirname, "rate-limit-detect.test.ts"), "utf8");
    expect(detectClaudeUsageLimitMenu(source)).toBeNull();
  });

  it("returns null for session-service.test.ts's raw contents (self-match regression guard)", () => {
    const source = readFileSync(resolve(__dirname, "session-service.test.ts"), "utf8");
    expect(detectClaudeUsageLimitMenu(source)).toBeNull();
  });
});

describe("claudeUsageMenuOptionOneSelected", () => {
  const MENU_TEXT = [
    "What do you want to do?",
    "",
    "> 1. Stop and wait for limit to reset",
    "  2. Ask your admin for more usage",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");

  it("returns true when option 1 carries the cursor", () => {
    expect(claudeUsageMenuOptionOneSelected(MENU_TEXT)).toBe(true);
  });

  it("returns false when the cursor is on option 2 instead of option 1", () => {
    const paneText = [
      "What do you want to do?",
      "",
      "  1. Stop and wait for limit to reset",
      "> 2. Ask your admin for more usage",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(claudeUsageMenuOptionOneSelected(paneText)).toBe(false);
  });

  it("returns false for plain unrelated text", () => {
    expect(claudeUsageMenuOptionOneSelected("just some regular output\nnothing to see here")).toBe(
      false,
    );
  });
});

describe("detectClaudeCompacting", () => {
  it("flags a live spinner line", () => {
    const paneText = ["Some earlier output", "✳ Compacting conversation… (18s)", ""].join("\n");
    expect(detectClaudeCompacting(paneText)).toBe(true);
  });

  it("flags a lowercased variant", () => {
    const paneText = ["compacting conversation... (5s)"].join("\n");
    expect(detectClaudeCompacting(paneText)).toBe(true);
  });

  it("returns false for a prose/quoted mid-line mention", () => {
    const paneText = [
      'Spur must derive session state "working" when the pane renders "Compacting',
      'conversation… (Ns)" spinner.',
    ].join("\n");
    expect(detectClaudeCompacting(paneText)).toBe(false);
  });

  it("returns false for an idle pane", () => {
    const paneText = ["Waiting for the next task."].join("\n");
    expect(detectClaudeCompacting(paneText)).toBe(false);
  });

  it("returns false for the detector source file's own raw contents (self-match regression guard)", () => {
    const source = readFileSync(resolve(__dirname, "../../src/rate-limit-detect.ts"), "utf8");
    expect(detectClaudeCompacting(source)).toBe(false);
  });
});

describe("detectCodexMcpPermissionDialog", () => {
  // Real captured render (session-artifacts/shp-a4bc, intelas-f45c): codex mid
  // tool call, hit the interactive MCP permission gate for playwright.
  const DIALOG_TEXT = [
    "  Field 1/1",
    '  Allow the playwright MCP server to run tool "browser_navigate"?',
    "",
    "  url: https://github.com/intelas/intelas-web/pull/3905/files",
    "",
    "  › 1. Allow                   Run the tool and continue.",
    "    2. Allow for this session  Run the tool and remember this choice for this session.",
    "    3. Always allow            Run the tool and remember this choice for future tool calls.",
    "    4. Cancel                  Cancel this tool call",
    "  enter to submit | esc to cancel",
  ].join("\n");

  it("returns true for the real captured MCP permission dialog render", () => {
    expect(detectCodexMcpPermissionDialog(DIALOG_TEXT)).toBe(true);
  });

  it("returns false for prose that merely mentions similar wording", () => {
    const paneText = [
      "I noticed you could allow the mcp server later if needed.",
      "For now let's keep working on the diff.",
    ].join("\n");
    expect(detectCodexMcpPermissionDialog(paneText)).toBe(false);
  });

  it("returns false for the detector source file's own raw contents (self-match regression guard)", () => {
    const source = readFileSync(resolve(__dirname, "../../src/rate-limit-detect.ts"), "utf8");
    expect(detectCodexMcpPermissionDialog(source)).toBe(false);
  });

  it("returns false for this test file's own raw contents (self-match regression guard)", () => {
    const source = readFileSync(resolve(__dirname, "rate-limit-detect.test.ts"), "utf8");
    expect(detectCodexMcpPermissionDialog(source)).toBe(false);
  });

  it("returns false once the dialog has scrolled out of the pane's recent tail", () => {
    const subsequentOutput = Array.from(
      { length: 25 },
      (_, i) => `  line ${i}: doing unrelated follow-up work`,
    ).join("\n");
    const paneText = `${DIALOG_TEXT}\n${subsequentOutput}`;
    expect(detectCodexMcpPermissionDialog(paneText)).toBe(false);
  });
});

describe("scanTmuxRateLimit", () => {
  // Real captured tmux panes/scrollbacks. The two REAL codex panes render a
  // genuine banner and must classify limited; the two agent-work panes only
  // contain rate-limit vocabulary in prose/diffs and must not.
  const PANES_DIR = resolve(__dirname, "../fixtures/agent-history/tmux-rate-limit-panes");
  const readPane = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");

  it("flags the real codex out-of-credits pane (■-anchored banner)", () => {
    expect(scanTmuxRateLimit(readPane("codex-out-of-credits.pane.txt"))).toEqual({
      limited: true,
      reason: "tmux out of credits",
    });
  });

  it("flags the real codex usage-limit pane", () => {
    // First rendered banner is the ■ out-of-credits line; either marker means limited.
    expect(scanTmuxRateLimit(readPane("codex-usage-limit.pane.txt"))).toEqual({
      limited: true,
      reason: "tmux out of credits",
    });
  });

  it("matches a line-leading usage-limit status banner without ■", () => {
    const pane = [
      "  Usage limit reached",
      "  Request a limit increase from your owner to continue using codex. Request in",
      "",
      "  1. Yes (y)",
      "› 2. No (default) (n)",
    ].join("\n");
    expect(scanTmuxRateLimit(pane)).toEqual({
      limited: true,
      reason: "tmux usage limit reached",
    });
  });

  it("ignores rate-limit vocabulary in the real claude agent-work pane", () => {
    // spur-4a94: prose describing detectCodexRateLimit while editing this code.
    expect(scanTmuxRateLimit(readPane("claude-false-match.pane.txt"))).toBeNull();
  });

  it("ignores a quoted marker on a diff-gutter line in the real cursor scrollback", () => {
    // spur-7443: a ▎-gutter diff line quoting `reason: "cursor out of usage"`.
    expect(scanTmuxRateLimit(readPane("cursor-false-match.scrollback.txt"))).toBeNull();
  });

  it("returns null when no banner is rendered", () => {
    expect(scanTmuxRateLimit("Working on the task...")).toBeNull();
  });
});

describe("readCodexRolloutState rate limits", () => {
  async function makeSessionsDir(line: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "codex-ratelimit-"));
    tempDirs.push(root);
    const dayDir = join(root, "sessions", "2026", "06", "28");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, "rollout-test.jsonl"), line, "utf8");
    return join(root, "sessions");
  }

  it("reads out-of-credits from the latest token_count event", async () => {
    const line = JSON.stringify({
      timestamp: "2026-06-28T09:03:35.949Z",
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: CODEX_OUT_OF_CREDITS },
    });
    const dir = await makeSessionsDir(line);
    expect((await readCodexRolloutState(dir)).rateLimit).toEqual({
      limited: true,
      reason: "codex out of credits",
    });
  });

  it("returns null when rollouts carry no rate_limits data", async () => {
    const line = JSON.stringify({
      timestamp: "2026-06-28T09:03:35.949Z",
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: null },
    });
    const dir = await makeSessionsDir(line);
    expect((await readCodexRolloutState(dir)).rateLimit).toBeNull();
  });
});

describe("parseRateLimitResetAtMs", () => {
  it("parses the field-reported sample anchored same-day", () => {
    const anchorMs = Date.parse("2026-07-01T11:07:00.000Z");
    expect(parseRateLimitResetAtMs("resets 11:20am (UTC)", anchorMs)).toBe(
      Date.parse("2026-07-01T11:20:00.000Z"),
    );
  });

  it("parses the captured fixture sample anchored same-day", () => {
    const anchorMs = Date.parse("2026-07-12T18:18:45.588Z");
    expect(
      parseRateLimitResetAtMs("You've hit your session limit · resets 7pm (UTC)", anchorMs),
    ).toBe(Date.parse("2026-07-12T19:00:00.000Z"));
  });

  it("rolls over to the next day when the anchor's clock time is already past the reset hour", () => {
    const anchorMs = Date.parse("2026-07-01T23:50:00.000Z");
    expect(parseRateLimitResetAtMs("resets 12:10am (UTC)", anchorMs)).toBe(
      Date.parse("2026-07-02T00:10:00.000Z"),
    );
  });

  it("rolls over forward-only when the reset clock time equals the anchor's own minute (no backward grace)", () => {
    const anchorMs = Date.parse("2026-07-01T11:20:30.000Z");
    const resetAtMs = parseRateLimitResetAtMs("resets 11:20am (UTC)", anchorMs);
    expect(resetAtMs).toBe(Date.parse("2026-07-02T11:20:00.000Z"));
    expect(resetAtMs).toBeGreaterThan(anchorMs);
  });

  it("maps 12pm to noon and 12am to midnight", () => {
    const anchorMs = Date.parse("2026-07-01T00:00:00.000Z");
    expect(parseRateLimitResetAtMs("resets 12pm (UTC)", anchorMs)).toBe(
      Date.parse("2026-07-01T12:00:00.000Z"),
    );
    expect(parseRateLimitResetAtMs("resets 12am (UTC)", anchorMs)).toBe(
      Date.parse("2026-07-02T00:00:00.000Z"),
    );
  });

  it("returns undefined for an hour of 0", () => {
    expect(parseRateLimitResetAtMs("resets 0am (UTC)", 0)).toBeUndefined();
  });

  it("returns undefined for minutes above 59", () => {
    expect(parseRateLimitResetAtMs("resets 11:99am (UTC)", 0)).toBeUndefined();
  });

  it("returns undefined with no resets phrase", () => {
    expect(parseRateLimitResetAtMs("You've hit your usage limit.", 0)).toBeUndefined();
  });

  it("returns undefined with no UTC parenthetical", () => {
    expect(parseRateLimitResetAtMs("resets 3pm", 0)).toBeUndefined();
  });

  it("returns undefined for a non-UTC parenthetical", () => {
    expect(parseRateLimitResetAtMs("resets 3pm (PDT)", 0)).toBeUndefined();
  });
});

describe("rateLimitExpired", () => {
  it("is true once now reaches the parsed reset instant", () => {
    expect(
      rateLimitExpired({ limited: true, reason: "claude rate_limit", resetAtMs: 100 }, 100),
    ).toBe(true);
    expect(
      rateLimitExpired({ limited: true, reason: "claude rate_limit", resetAtMs: 100 }, 101),
    ).toBe(true);
  });

  it("is false before the parsed reset instant", () => {
    expect(
      rateLimitExpired({ limited: true, reason: "claude rate_limit", resetAtMs: 100 }, 99),
    ).toBe(false);
  });

  it("is false when the detection carries no resetAtMs", () => {
    expect(rateLimitExpired({ limited: true, reason: "claude rate_limit" }, Date.now())).toBe(
      false,
    );
  });
});

describe("detectClaudeRateLimit stays time-free", () => {
  it("returns limited:true for a rate-limited record at any now, and carries resetAtMs through", () => {
    const anchorMs = Date.parse("2026-07-12T18:18:45.588Z");
    const record = parseJsonlRecord(
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        error: "rate_limit",
        timestamp: "2026-07-12T18:18:45.588Z",
        message: {
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "You've hit your session limit · resets 7pm (UTC)" }],
        },
      }),
      anchorMs,
    );
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    const detection = detectClaudeRateLimit([record]);
    expect(detection).toEqual({
      limited: true,
      reason: "claude rate_limit",
      resetAtMs: Date.parse("2026-07-12T19:00:00.000Z"),
    });
    // The detector itself takes no `now` argument — passing different "now"
    // values (simulated by re-invoking with the same records) always
    // reproduces the same detection.
    expect(detectClaudeRateLimit([record])).toEqual(detection);
  });
});
