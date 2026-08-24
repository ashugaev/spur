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

// Rendered human banner phrases (lowercase) that appear as ■-prefixed banners
// or line-leading status text in a tmux pane. Deliberately excludes the
// code-token markers `rate_limit_reached` and `resource_exhausted`: those appear
// only in JSON/source and are already covered by detectCodexRateLimit /
// detectClaudeRateLimit, and matching them loosely is what falsely flagged
// agents that merely edit or print rate-limit vocabulary.
const TMUX_BANNER_MARKERS: readonly string[] = [
  "out of credits",
  "usage limit reached",
  "out of usage",
  "out of extra usage",
  "hit your session limit",
  "hit your weekly limit",
  "hit your usage limit",
  "hit your opus limit",
  "increase limits",
  "credit balance is too low",
  "temporarily limiting requests",
  "request rejected (429)",
];

// Diff / quote / code-gutter glyphs that mark a line as agent-rendered content
// rather than a genuine banner. A marker on such a line is never a real limit.
const TMUX_GUTTER_GLYPHS: ReadonlySet<string> = new Set(["▎", "│", "┃", "|", ">", "+"]);
const TMUX_QUOTE_CHARS: ReadonlySet<string> = new Set(['"', "'", "`"]);

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

// True when `window` is a live usage-window object (has a numeric used_percent),
// as opposed to null/absent.
function usageWindowPresent(window: unknown): boolean {
  return isRecord(window) && typeof window["used_percent"] === "number";
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
  // A window-metered account (e.g. team/enterprise, billed via Azure/API key)
  // reports has_credits:false as a benign soft signal alongside a live usage
  // window even at 0% used — it just means "not on the credits plan", not
  // "out of credits". Only treat has_credits:false as a hard limit when no
  // usage window is present at all (the genuine credit-metered-account case);
  // otherwise fall through to the used_percent checks below.
  if (
    isRecord(credits) &&
    credits["has_credits"] === false &&
    credits["unlimited"] !== true &&
    !usageWindowPresent(rateLimits["primary"]) &&
    !usageWindowPresent(rateLimits["secondary"])
  ) {
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

// Bookkeeping / pass-through record types Claude Code appends after a turn
// (e.g. a `system`/`turn_duration` record, hook summaries, file-history
// snapshots). These carry no rate-limit signal of their own and must be
// skipped when walking the tail backward looking for the last meaningful
// record — otherwise a bookkeeping record appended after a rate-limited turn
// would mask the actual rate-limit record one step earlier. Also the single
// source of truth for claude-jsonl-state.ts's own bookkeeping-type checks.
export const CLAUDE_BOOKKEEPING_RECORD_TYPES: ReadonlySet<string> = new Set([
  "progress",
  "system",
  "stop_hook_summary",
  "file-history-snapshot",
]);

// Claude transcript tail. The most recent meaningful record decides: a synthetic
// assistant record flagged `error: "rate_limit"` means the session is blocked.
// Returns null when there is no meaningful record to judge.
export function detectClaudeRateLimit(
  records: readonly ClaudeRateLimitRecord[],
): RateLimitDetection | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record || CLAUDE_BOOKKEEPING_RECORD_TYPES.has(record.type)) {
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

// Claude Code's stop-and-wait / ask-your-admin usage-limit menu, whose
// cursor-selected option line would be rejected by scanTmuxRateLimit's
// gutter/anchor checks. This detector requires three distinct whole physical
// lines — both menu options plus the confirm/cancel footer — rather than a
// whole-buffer substring scan, so prose or fixtures that merely mention the
// menu's wording don't bare-reproduce a matching line and can't self-trigger.
const CLAUDE_USAGE_MENU_OPTION_ONE = /^[^0-9a-z]{0,3}1\.\s*stop and wait for limit to reset$/i;
const CLAUDE_USAGE_MENU_OPTION_TWO = /^[^0-9a-z]{0,3}2\.\s*ask your admin for more usage$/i;
const CLAUDE_USAGE_MENU_FOOTER = /^enter to confirm\s*[·\-|/]\s*esc to cancel$/i;

export function detectClaudeUsageLimitMenu(paneText: string): RateLimitDetection | null {
  const lines = paneText.split("\n").map((line) => line.trim());
  const hasOptionOne = lines.some((line) => CLAUDE_USAGE_MENU_OPTION_ONE.test(line));
  const hasOptionTwo = lines.some((line) => CLAUDE_USAGE_MENU_OPTION_TWO.test(line));
  const hasFooter = lines.some((line) => CLAUDE_USAGE_MENU_FOOTER.test(line));
  if (hasOptionOne && hasOptionTwo && hasFooter) {
    return { limited: true, reason: "claude usage limit menu" };
  }
  return null;
}

const CLAUDE_USAGE_MENU_OPTION_ONE_SELECTED = /^>\s*1\.\s*stop and wait for limit to reset$/i;

// True only when the pane's cursor is on "Stop and wait for limit to reset"
// (option 1), not "Ask your admin for more usage" (option 2). Confirming via
// Enter must be gated on this specifically — detectClaudeUsageLimitMenu only
// proves the menu is showing, not which option is currently highlighted, so
// blindly sending Enter could otherwise select "Ask your admin" instead.
export function claudeUsageMenuOptionOneSelected(paneText: string): boolean {
  return paneText
    .split("\n")
    .map((line) => line.trim())
    .some((line) => CLAUDE_USAGE_MENU_OPTION_ONE_SELECTED.test(line));
}

// Claude Code's compaction spinner ("✳ Compacting conversation… (18s)"). This
// never reaches Claude's persisted status file (it stays "idle" throughout,
// which maps to waiting) and the transcript only gets a compact record after
// completion — so the live tmux pane banner is the only signal available
// while it's in progress. Line-anchored + start-anchored, mirroring
// detectClaudeUsageLimitMenu/detectCodexMcpPermissionDialog's discipline, so
// a quoted/mid-line prose mention of "compacting conversation" (like this
// very comment) can't self-trigger.
const CLAUDE_COMPACTING_LINE = /^[^0-9a-z]{0,1}\s*compacting conversation/i;

export function detectClaudeCompacting(paneText: string): boolean {
  return paneText
    .split("\n")
    .map((line) => line.trim())
    .some((line) => CLAUDE_COMPACTING_LINE.test(line));
}

// Codex's MCP tool-permission confirmation dialog (e.g. "Allow the playwright
// MCP server to run tool "browser_navigate"?" with four numbered options). This
// is a live needs_input prompt, not a rate limit — but the same turn can carry
// soft has_credits:false telemetry that would otherwise force rate_limited.
// Mirrors detectClaudeUsageLimitMenu's anti-self-trigger discipline: requires
// the header line plus all four option lines as distinct whole physical lines,
// so prose that merely mentions "allow the mcp server" can't bare-reproduce a
// matching set of lines and self-trigger. Option lines end with `\b` rather
// than `$` because codex renders a trailing description after each option
// (e.g. "1. Allow                   Run the tool and continue.").
const CODEX_MCP_DIALOG_HEADER = /^allow the .+ mcp server to run tool /i;
const CODEX_MCP_DIALOG_OPTION_ONE = /^[^0-9a-z]{0,3}1\.\s*allow\b/i;
const CODEX_MCP_DIALOG_OPTION_TWO = /^[^0-9a-z]{0,3}2\.\s*allow for this session\b/i;
const CODEX_MCP_DIALOG_OPTION_THREE = /^[^0-9a-z]{0,3}3\.\s*always allow\b/i;
const CODEX_MCP_DIALOG_OPTION_FOUR = /^[^0-9a-z]{0,3}4\.\s*cancel\b/i;

// The dialog blocks the TUI, so a genuinely live one always renders at the
// pane's tail. captureTmuxPane's default 200-line capture is sized for
// scanTmuxRateLimit's banner search, not this check — without a tail bound, an
// already-answered dialog can still match here until ~200 lines of subsequent
// output scroll it out, which would keep wrongly un-masking a real rate limit.
const CODEX_MCP_DIALOG_TAIL_LINES = 20;

export function detectCodexMcpPermissionDialog(paneText: string): boolean {
  const allLines = paneText.split("\n").map((line) => line.trim());
  let end = allLines.length;
  while (end > 0 && allLines[end - 1] === "") end--;
  const lines = allLines.slice(Math.max(0, end - CODEX_MCP_DIALOG_TAIL_LINES), end);
  const hasHeader = lines.some((line) => CODEX_MCP_DIALOG_HEADER.test(line));
  const hasOptionOne = lines.some((line) => CODEX_MCP_DIALOG_OPTION_ONE.test(line));
  const hasOptionTwo = lines.some((line) => CODEX_MCP_DIALOG_OPTION_TWO.test(line));
  const hasOptionThree = lines.some((line) => CODEX_MCP_DIALOG_OPTION_THREE.test(line));
  const hasOptionFour = lines.some((line) => CODEX_MCP_DIALOG_OPTION_FOUR.test(line));
  return hasHeader && hasOptionOne && hasOptionTwo && hasOptionThree && hasOptionFour;
}

// Last-resort fallback: scan the rendered tmux pane for a genuine rate-limit
// banner line. Iterates physical lines and accepts a marker only on a real
// banner — a ■-prefixed banner or a line-leading status banner — rejecting
// diff/quote gutters and quoted code tokens. This keeps an agent whose pane
// merely contains rate-limit vocabulary from being misclassified rate_limited.
export function scanTmuxRateLimit(paneText: string): RateLimitDetection | null {
  for (const line of paneText.split("\n")) {
    const content = line.replace(/^\s+/, "");
    if (content.length === 0) {
      continue;
    }
    const firstChar = content[0];
    if (firstChar !== undefined && TMUX_GUTTER_GLYPHS.has(firstChar)) {
      continue;
    }
    const lower = content.toLowerCase();
    const marker = TMUX_BANNER_MARKERS.find((phrase) => lower.includes(phrase));
    if (marker === undefined) {
      continue;
    }
    const start = lower.indexOf(marker);
    const before = start > 0 ? content[start - 1] : undefined;
    const after = content[start + marker.length];
    if (
      (before !== undefined && TMUX_QUOTE_CHARS.has(before)) ||
      (after !== undefined && TMUX_QUOTE_CHARS.has(after))
    ) {
      continue;
    }
    if (content.startsWith("■") || lower.startsWith(marker)) {
      return { limited: true, reason: `tmux ${marker}` };
    }
  }
  return null;
}
