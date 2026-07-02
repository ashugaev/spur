export interface RateLimitDetection {
  limited: boolean;
  reason: string;
}

const NOT_LIMITED: RateLimitDetection = { limited: false, reason: "" };

// Rendered markers that signal a rate-limit / out-of-credits / usage-cap stop.
// Used for cursor transcript text and the tmux pane fallback scan. Lowercased.
export const RATE_LIMIT_MARKERS: readonly string[] = [
  "hit your session limit",
  "hit your weekly limit",
  "hit your usage limit",
  "hit your opus limit",
  "out of usage",
  "out of extra usage",
  "increase limits",
  "out of credits",
  "usage limit reached",
  "rate limit reached",
  "temporarily limiting requests",
  "request rejected (429)",
  "credit balance is too low",
  "rate_limit_reached",
  "resource_exhausted",
];

function matchMarker(text: string): string | null {
  const haystack = text.toLowerCase();
  for (const marker of RATE_LIMIT_MARKERS) {
    if (haystack.includes(marker)) {
      return marker;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usedPercentExhausted(window: unknown): boolean {
  if (!isRecord(window)) {
    return false;
  }
  const used = window["used_percent"];
  return typeof used === "number" && used >= 100;
}

// Codex rollout `token_count.rate_limits`. Returns null when no usable data is
// present (caller may then fall back to the tmux pane scan).
export function detectCodexRateLimit(rateLimits: unknown): RateLimitDetection | null {
  if (!isRecord(rateLimits)) {
    return null;
  }
  const reachedType = rateLimits["rate_limit_reached_type"];
  if (typeof reachedType === "string" && reachedType.length > 0) {
    return { limited: true, reason: `codex ${reachedType}` };
  }
  const credits = rateLimits["credits"];
  if (isRecord(credits) && credits["has_credits"] === false && credits["unlimited"] !== true) {
    return { limited: true, reason: "codex out of credits" };
  }
  if (usedPercentExhausted(rateLimits["primary"])) {
    return { limited: true, reason: "codex 5h window exhausted" };
  }
  if (usedPercentExhausted(rateLimits["secondary"])) {
    return { limited: true, reason: "codex weekly window exhausted" };
  }
  return NOT_LIMITED;
}

export interface ClaudeRateLimitRecord {
  type: string;
  rateLimited?: boolean;
}

// Claude transcript tail. The most recent meaningful record decides: a synthetic
// assistant record flagged `error: "rate_limit"` means the session is blocked.
// Returns null when there is no meaningful record to judge.
export function detectClaudeRateLimit(
  records: readonly ClaudeRateLimitRecord[],
): RateLimitDetection | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record || record.type === "progress") {
      continue;
    }
    if (record.rateLimited) {
      return { limited: true, reason: "claude rate_limit" };
    }
    return NOT_LIMITED;
  }
  return null;
}

// Cursor transcript text from the latest assistant/error record.
export function detectCursorRateLimit(text: string | null): RateLimitDetection | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  const marker = matchMarker(text);
  if (marker) {
    return { limited: true, reason: `cursor ${marker}` };
  }
  return null;
}

// Fallback: scan the rendered tmux pane buffer for any rate-limit marker.
export function scanTmuxRateLimit(paneText: string): RateLimitDetection | null {
  const marker = matchMarker(paneText);
  return marker ? { limited: true, reason: `tmux ${marker}` } : null;
}
