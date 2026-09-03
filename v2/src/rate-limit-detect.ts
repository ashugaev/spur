export interface RateLimitDetection {
  limited: boolean;
  reason: string;
  /** Epoch ms the limit resets at, when the source text carries a parseable reset instant. */
  resetAtMs?: number;
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

// Status glyphs an agent TUI renders in front of its own banner line (claude's
// "⚠ Usage limit reached · continuing automatically at Sep 2, 8am", codex's
// "■ ..."). A marker after one of these is a genuine banner, not agent-rendered
// content — the gutter glyphs above stay rejected. Narrow allowlist on purpose:
// accepting any leading non-alphanumeric would re-admit quoted and boxed prose.
const TMUX_BANNER_GLYPHS: ReadonlySet<string> = new Set([
  "■",
  "⚠",
  "✗",
  "✘",
  "●",
  "▲",
  "✻",
  "⏺",
  "✢",
]);

// Emoji presentation selector: "⚠️" is "⚠" + U+FE0F, so the glyph check above
// must consume it or the banner body would start with an invisible codepoint.
const VARIATION_SELECTOR_16 = "\uFE0F";

// Returns the banner body with a single leading status glyph (and its emoji
// selector and following spaces) removed, or null when the line carries no
// such glyph.
function stripBannerGlyph(content: string): string | null {
  const first = content[0];
  if (first === undefined || !TMUX_BANNER_GLYPHS.has(first)) {
    return null;
  }
  const rest = content.slice(1);
  const body = rest.startsWith(VARIATION_SELECTOR_16) ? rest.slice(1) : rest;
  return body.replace(/^\s+/, "");
}

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
  /** Epoch ms the limit resets at, parsed from the record's own banner text. */
  rateLimitResetAtMs?: number;
}

// Matches "resets 7pm (UTC)" / "resets 11:20am (UTC)" (case-insensitive).
// Timezone must be spelled out as "(UTC)" — anything else (or nothing) is
// unparseable, since guessing a timezone would risk a wrong expiry.
const RATE_LIMIT_RESET_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(\s*utc\s*\)/i;

// The only banner scope this parser trusts a reset instant from. RATE_LIMIT_MARKERS
// / TMUX_BANNER_MARKERS also match "hit your weekly limit" and "hit your opus limit",
// which can carry the same "resets HH (UTC)" clause for a reset days away — parsing
// that would still land inside this function's forward-only (anchor, anchor+24h]
// range and report a multi-day limit as expired within a day.
const SESSION_LIMIT_BANNER = "hit your session limit";

// The truncation window a minute-precision banner clock can hide: the true reset can
// land up to 60s after the rendered minute.
const BANNER_CLOCK_TRUNCATION_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Parses a claude session-limit banner's trailing "resets HH[:MM](am|pm) (UTC)"
// clause into an absolute epoch-ms instant, anchored to the record's own
// timestamp (never the caller's clock — see claude-jsonl-state.ts's
// extractRecordTimestampMs). Scope-gated to the session limit: a weekly, opus,
// or otherwise unrecognized banner returns `undefined` and keeps today's
// time-blind, stuck-but-safe behavior — see SESSION_LIMIT_BANNER. Forward-only:
// the returned instant is always strictly after `anchorMs`. The banner's clock
// is minute-truncated, so the true reset can land up to 60s after the rendered
// minute; the common case (the rendered minute is still ahead of the anchor)
// returns that truncated minute as-is, which can be up to 60s earlier than the
// true reset. Only when the anchor has already reached the rendered minute is
// the candidate clamped forward to the end of that minute (candidate + 60s)
// rather than rolled a full day, so it is never earlier than the true reset in
// that same-minute case specifically. Once the anchor is 60s or more past the
// rendered minute, the candidate rolls a full day forward instead. Returns
// `undefined` for any unparseable, out-of-range, or non-UTC form — never a
// guessed timezone or a fallback expiry.
export function parseRateLimitResetAtMs(text: string, anchorMs: number): number | undefined {
  if (!text.toLowerCase().includes(SESSION_LIMIT_BANNER)) {
    return undefined;
  }
  const match = RATE_LIMIT_RESET_RE.exec(text);
  if (!match) {
    return undefined;
  }
  const hourRaw = Number(match[1]);
  const minuteRaw = match[2] !== undefined ? Number(match[2]) : 0;
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isFinite(hourRaw) || hourRaw < 1 || hourRaw > 12) {
    return undefined;
  }
  if (!Number.isFinite(minuteRaw) || minuteRaw > 59) {
    return undefined;
  }
  let hour24 = hourRaw % 12;
  if (meridiem === "pm") {
    hour24 += 12;
  }
  const anchorDate = new Date(anchorMs);
  let candidate = Date.UTC(
    anchorDate.getUTCFullYear(),
    anchorDate.getUTCMonth(),
    anchorDate.getUTCDate(),
    hour24,
    minuteRaw,
    0,
    0,
  );
  if (candidate <= anchorMs) {
    candidate +=
      anchorMs - candidate < BANNER_CLOCK_TRUNCATION_MS ? BANNER_CLOCK_TRUNCATION_MS : DAY_MS;
  }
  return candidate;
}

// True when `detection` carries a parsed reset instant that has already
// passed as of `nowMs`. A detection with no `resetAtMs` (no parseable reset
// text, or the source never carries one, e.g. pane banners) is never
// expired — that's today's safe, time-blind fallback.
export function rateLimitExpired(detection: RateLimitDetection, nowMs: number): boolean {
  return detection.resetAtMs !== undefined && nowMs >= detection.resetAtMs;
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
      return {
        limited: true,
        reason: "claude rate_limit",
        ...(record.rateLimitResetAtMs !== undefined
          ? { resetAtMs: record.rateLimitResetAtMs }
          : {}),
      };
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
// Claude Code renders the admin option as "2." on the two-option menu and as
// "3." on the newer three-option one, whose extra middle option is "2. Wait
// here, then continue automatically at <date>". Matching either index keeps
// one detector for both layouts; the three required distinct physical lines
// stay option one, the admin option, and the footer.
const CLAUDE_USAGE_MENU_OPTION_ONE = /^[^0-9a-z]{0,3}1\.\s*stop and wait for limit to reset$/i;
const CLAUDE_USAGE_MENU_OPTION_ADMIN = /^[^0-9a-z]{0,3}[23]\.\s*ask your admin for more usage$/i;
const CLAUDE_USAGE_MENU_FOOTER = /^enter to confirm\s*[·\-|/]\s*esc to cancel$/i;

// captureTmuxPane's default 200-line capture is sized for scanTmuxRateLimit's
// banner search, not this check — without a tail bound, an already-dismissed menu
// could still match here until ~200 lines of subsequent output scroll it out.
// Bounded the same way as detectCodexMcpPermissionDialog's CODEX_MCP_DIALOG_TAIL_LINES:
// only a menu inside the pane's last 20 non-blank lines matches. Unlike the codex
// dialog, confirming this menu (Enter) produces no further pane output — the
// session just goes idle — so "at the tail" narrows the false-positive window but
// does not prove the menu is still live.
const CLAUDE_USAGE_MENU_TAIL_LINES = 20;

export function detectClaudeUsageLimitMenu(paneText: string): RateLimitDetection | null {
  const allLines = paneText.split("\n").map((line) => line.trim());
  let end = allLines.length;
  while (end > 0 && allLines[end - 1] === "") end--;
  const lines = allLines.slice(Math.max(0, end - CLAUDE_USAGE_MENU_TAIL_LINES), end);
  const hasOptionOne = lines.some((line) => CLAUDE_USAGE_MENU_OPTION_ONE.test(line));
  const hasAdminOption = lines.some((line) => CLAUDE_USAGE_MENU_OPTION_ADMIN.test(line));
  const hasFooter = lines.some((line) => CLAUDE_USAGE_MENU_FOOTER.test(line));
  if (hasOptionOne && hasAdminOption && hasFooter) {
    return { limited: true, reason: "claude usage limit menu" };
  }
  return null;
}

// Claude Code renders the selection cursor as "❯" (U+276F) in its current TUI
// and as ">" in older builds; both mean option 1 is highlighted.
const CLAUDE_USAGE_MENU_OPTION_ONE_SELECTED = /^[>❯]\s*1\.\s*stop and wait for limit to reset$/i;

// True only when the pane's cursor is on "Stop and wait for limit to reset"
// (option 1), not on any other option ("Wait here, then continue
// automatically at <date>", "Ask your admin for more usage"). Confirming via
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
    // A leading status glyph is part of the banner chrome, not of its text:
    // strip it so the marker still counts as line-leading underneath.
    const glyphBody = stripBannerGlyph(content);
    const body = glyphBody ?? content;
    const lower = body.toLowerCase();
    const marker = TMUX_BANNER_MARKERS.find((phrase) => lower.includes(phrase));
    if (marker === undefined) {
      continue;
    }
    const start = lower.indexOf(marker);
    const before = start > 0 ? body[start - 1] : undefined;
    const after = body[start + marker.length];
    if (
      (before !== undefined && TMUX_QUOTE_CHARS.has(before)) ||
      (after !== undefined && TMUX_QUOTE_CHARS.has(after))
    ) {
      continue;
    }
    if (glyphBody !== null || lower.startsWith(marker)) {
      return { limited: true, reason: `tmux ${marker}` };
    }
  }
  return null;
}
