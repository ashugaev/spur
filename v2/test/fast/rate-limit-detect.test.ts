import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectClaudeRateLimit,
  detectCodexRateLimit,
  detectCursorRateLimit,
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
