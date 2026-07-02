import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectClaudeRateLimit,
  detectCodexRateLimit,
  detectCursorRateLimit,
  scanTmuxRateLimit,
} from "../../src/rate-limit-detect.js";
import { parseJsonlRecord } from "../../src/claude-jsonl-state.js";
import { readCodexRolloutState } from "../../src/agents/codex.js";

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

  it("returns null when no usable rate_limits data is present", () => {
    expect(detectCodexRateLimit(null)).toBeNull();
    expect(detectCodexRateLimit(undefined)).toBeNull();
  });
});

describe("detectClaudeRateLimit", () => {
  it("flags a trailing synthetic rate_limit record", () => {
    const record = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    expect(record?.rateLimited).toBe(true);
    expect(detectClaudeRateLimit([record!])).toEqual({
      limited: true,
      reason: "claude rate_limit",
    });
  });

  it("is not limited when the latest meaningful record is normal", () => {
    const limit = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    const normal = parseJsonlRecord(CLAUDE_NORMAL_LINE, 1);
    expect(detectClaudeRateLimit([limit!, normal!])).toEqual({ limited: false, reason: "" });
  });

  it("returns null with no records", () => {
    expect(detectClaudeRateLimit([])).toBeNull();
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

describe("scanTmuxRateLimit", () => {
  // Minimal representative slice of a real codex out-of-credits pane
  // (diary-bot-1381): a ■-prefixed banner interleaved with wake prompts.
  const CODEX_OUT_OF_CREDITS_PANE = [
    "› Scheduled interval wake-up.",
    "  Stop condition: cancel the hourly main pull.",
    "",
    "■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "",
    "› Run /review on my current changes",
  ].join("\n");

  // Line-leading status banner from a real codex usage-limit pane (intelas-65f6).
  const CODEX_USAGE_LIMIT_PANE = [
    "  Usage limit reached",
    "  Request a limit increase from your owner to continue using codex. Request in",
    "",
    "  1. Yes (y)",
    "› 2. No (default) (n)",
  ].join("\n");

  // Real claude pane (spur-4a94) editing rate-limit code — prose mentions the
  // code token but there is no rendered banner. Must not classify limited.
  const CLAUDE_FALSE_MATCH_PANE = [
    "  detectCodexRateLimit no longer treats credits.has_credits:false with a null",
    "  balance as out-of-credits. Genuine limits (numeric balance<=0,",
    "  rate_limit_reached_type set, used_percent>=100) still classify rate_limited.",
    "  Deterministic; no tmux pane scan added.",
  ].join("\n");

  // Real cursor scrollback (spur-7443): a ▎-gutter diff line quoting a
  // `reason: "cursor out of usage"` test assertion. Must not classify limited.
  const CURSOR_FALSE_MATCH_SCROLLBACK = [
    "    Edited cursor-jsonl-state.test.ts +5 -1",
    "",
    "    ▎        limited: true,",
    '    ▎        reason: "cursor out of usage",',
    "    ▎      });",
  ].join("\n");

  it("matches a ■-prefixed out-of-credits banner", () => {
    expect(scanTmuxRateLimit(CODEX_OUT_OF_CREDITS_PANE)).toEqual({
      limited: true,
      reason: "tmux out of credits",
    });
  });

  it("matches a line-leading usage-limit status banner", () => {
    expect(scanTmuxRateLimit(CODEX_USAGE_LIMIT_PANE)).toEqual({
      limited: true,
      reason: "tmux usage limit reached",
    });
  });

  it("ignores rate-limit code tokens in agent-rendered prose", () => {
    expect(scanTmuxRateLimit(CLAUDE_FALSE_MATCH_PANE)).toBeNull();
  });

  it("ignores a quoted marker on a diff-gutter line", () => {
    expect(scanTmuxRateLimit(CURSOR_FALSE_MATCH_SCROLLBACK)).toBeNull();
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
