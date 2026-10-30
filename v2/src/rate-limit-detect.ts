export interface RateLimitDetection {
  limited: boolean;
  reason: string;
  /** Epoch ms the limit resets at, when the source text carries a parseable reset instant. */
  resetAtMs?: number;
  /** Codex native evidence authority; absent on other providers and legacy readers. */
  codexAuthority?: "hard" | "soft" | "unknown";
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
  "reached its usage limit",
  "spendlimithit: true",
  "spendlimithit:true",
  '"spendlimithit": true',
  '"spendlimithit":true',
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
  "reached its usage limit",
];

// Diff / quote / code-gutter glyphs that mark a line as agent-rendered content
// rather than a genuine banner. A marker on such a line is never a real limit.
const TMUX_GUTTER_GLYPHS: ReadonlySet<string> = new Set(["▎", "│", "┃", "|", ">", "+"]);
const TMUX_QUOTE_CHARS: ReadonlySet<string> = new Set(['"', "'", "`"]);

// The two observed banner-chrome glyphs: claude's "⚠ Usage limit reached ·
// continuing automatically at Sep 2, 8am" and codex's "■ Your workspace is out
// of credits". Deliberately excludes claude's own content bullets and spinner
// frames ("⏺", "●", "✻", "✢") — those prefix ordinary assistant and tool-call
// lines, so admitting them would strip the chrome off agent output that merely
// mentions rate-limit vocabulary.
const TMUX_BANNER_GLYPHS: ReadonlySet<string> = new Set(["■", "⚠"]);

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
    return { limited: true, reason: `codex ${reachedType}`, codexAuthority: "hard" };
  }
  const credits = rateLimits["credits"];
  const creditedMeters =
    (reachedType === undefined || reachedType === null) &&
    (rateLimits["individual_limit"] === undefined || rateLimits["individual_limit"] === null) &&
    (rateLimits["spend_control_reached"] === undefined ||
      rateLimits["spend_control_reached"] === null) &&
    isRecord(credits) &&
    (credits["has_credits"] === undefined || typeof credits["has_credits"] === "boolean") &&
    (credits["unlimited"] === undefined || typeof credits["unlimited"] === "boolean") &&
    (credits["has_credits"] === true || credits["unlimited"] === true);
  const windows = [rateLimits["primary"], rateLimits["secondary"]];
  const knownWindows = windows.every(
    (window) =>
      window === undefined ||
      window === null ||
      (isRecord(window) &&
        typeof window["used_percent"] === "number" &&
        Number.isFinite(window["used_percent"]) &&
        window["used_percent"] >= 0),
  );
  const knownCredits =
    credits === undefined ||
    (isRecord(credits) &&
      (credits["has_credits"] === undefined || typeof credits["has_credits"] === "boolean") &&
      (credits["unlimited"] === undefined || typeof credits["unlimited"] === "boolean") &&
      (typeof credits["has_credits"] === "boolean" || typeof credits["unlimited"] === "boolean"));
  const codexAuthority =
    (reachedType === undefined || reachedType === null) &&
    (rateLimits["individual_limit"] === undefined || rateLimits["individual_limit"] === null) &&
    (rateLimits["spend_control_reached"] === undefined ||
      rateLimits["spend_control_reached"] === null) &&
    knownWindows &&
    knownCredits &&
    (windows.some(usageWindowPresent) || creditedMeters)
      ? "soft"
      : "unknown";
  // Preserve legacy false-credit denial without a live window. HARD authority
  // requires complete known flags and explicit null windows/cap companions.
  if (
    isRecord(credits) &&
    credits["has_credits"] === false &&
    credits["unlimited"] !== true &&
    !usageWindowPresent(rateLimits["primary"]) &&
    !usageWindowPresent(rateLimits["secondary"])
  ) {
    return {
      limited: true,
      reason: "codex out of credits",
      codexAuthority:
        credits["unlimited"] === false &&
        windows.every((window) => window === null) &&
        reachedType === null &&
        rateLimits["individual_limit"] === null &&
        rateLimits["spend_control_reached"] === null
          ? "hard"
          : "unknown",
    };
  }
  if (!creditedMeters && usedPercentExhausted(rateLimits["primary"])) {
    return { limited: true, reason: "codex 5h window exhausted", codexAuthority };
  }
  if (!creditedMeters && usedPercentExhausted(rateLimits["secondary"])) {
    return { limited: true, reason: "codex weekly window exhausted", codexAuthority };
  }
  return { ...NOT_LIMITED, codexAuthority };
}

export interface ClaudeRateLimitRecord {
  type: string;
  rateLimited?: boolean;
  /** Epoch ms the limit resets at, parsed from the record's own banner text. */
  rateLimitResetAtMs?: number;
}

// Matches "resets 7pm (UTC)" / "resets 11:20am (UTC)" / "resets Sep 16, 8am (UTC)"
// (case-insensitive). Timezone must be spelled out as "(UTC)" — anything else
// (or nothing) is unparseable, since guessing a timezone would risk a wrong expiry.
const RATE_LIMIT_RESET_RE =
  /resets\s+(?:([a-z]{3})\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(\s*utc\s*\)/i;

const MONTH_ABBREVIATIONS: readonly string[] = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

// The banner scopes this parser trusts a reset instant from. Claude renders a
// weekly reset time-only while it is under 24h away and adds "Mon D," beyond
// that (every weekly record in observed transcripts), so a time-only clause
// resolves inside the forward-only (anchor, anchor+24h] range for every scope.
// The opus banner is assumed to share that formatter.
const RESET_BANNERS: readonly string[] = [
  "hit your session limit",
  "hit your weekly limit",
  "hit your opus limit",
];

// The truncation window a minute-precision banner clock can hide: the true reset can
// land up to 60s after the rendered minute.
const BANNER_CLOCK_TRUNCATION_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Parses a claude limit banner's trailing "resets [Mon D, ]HH[:MM](am|pm) (UTC)"
// clause into an absolute epoch-ms instant, anchored to the record's own
// timestamp (never the caller's clock — see claude-jsonl-state.ts's
// extractRecordTimestampMs). Scope-gated to RESET_BANNERS: any other banner
// returns `undefined` and keeps the time-blind, stuck-but-safe behavior.
// Forward-only: the returned instant is always strictly after `anchorMs`. The
// banner's clock is minute-truncated, so the true reset can land up to 60s after
// the rendered minute; the common case (the rendered minute is still ahead of
// the anchor) returns that truncated minute as-is, which can be up to 60s earlier
// than the true reset. Only when the anchor has already reached the rendered
// minute is the candidate clamped forward to the end of that minute (candidate +
// 60s), so it is never earlier than the true reset in that same-minute case
// specifically. Once the anchor is 60s or more past the rendered minute, a
// time-only candidate rolls a full day forward and a dated candidate rolls a
// full year forward (the banner omits the year). Returns `undefined` for any
// unparseable, out-of-range, or non-UTC form — never a guessed timezone or a
// fallback expiry.
export function parseRateLimitResetAtMs(text: string, anchorMs: number): number | undefined {
  const lower = text.toLowerCase();
  if (!RESET_BANNERS.some((banner) => lower.includes(banner))) {
    return undefined;
  }
  const match = RATE_LIMIT_RESET_RE.exec(text);
  if (!match) {
    return undefined;
  }
  const monthRaw = match[1];
  const month =
    monthRaw !== undefined ? MONTH_ABBREVIATIONS.indexOf(monthRaw.toLowerCase()) : undefined;
  const dayRaw = match[2] !== undefined ? Number(match[2]) : undefined;
  if (month === -1) {
    return undefined;
  }
  const hourRaw = Number(match[3]);
  const minuteRaw = match[4] !== undefined ? Number(match[4]) : 0;
  const meridiem = (match[5] ?? "").toLowerCase();
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
  const year = anchorDate.getUTCFullYear();
  if (month !== undefined && dayRaw !== undefined) {
    const dated = (y: number): number | undefined => {
      const instant = Date.UTC(y, month, dayRaw, hour24, minuteRaw, 0, 0);
      // Date.UTC normalizes overflow ("Feb 31" -> Mar 3); reject it instead.
      return new Date(instant).getUTCDate() === dayRaw ? instant : undefined;
    };
    const candidate = dated(year);
    if (candidate === undefined || candidate > anchorMs) {
      return candidate;
    }
    if (anchorMs - candidate < BANNER_CLOCK_TRUNCATION_MS) {
      return candidate + BANNER_CLOCK_TRUNCATION_MS;
    }
    return dated(year + 1);
  }
  let candidate = Date.UTC(
    year,
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

// Session-metadata records: `cost-state` is written when the claude process
// exits, `last-prompt` alongside prompts. Kept out of
// CLAUDE_BOOKKEEPING_RECORD_TYPES because classifyClaudeJsonlState maps that set
// to "waiting", while it already walks past these as unknown types.
const CLAUDE_SESSION_META_RECORD_TYPES: ReadonlySet<string> = new Set([
  "cost-state",
  "last-prompt",
]);

// Claude transcript tail. The most recent meaningful record decides: a synthetic
// assistant record flagged `error: "rate_limit"` means the session is blocked.
// Returns null when there is no meaningful record to judge.
export function detectClaudeRateLimit(
  records: readonly ClaudeRateLimitRecord[],
): RateLimitDetection | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (
      !record ||
      CLAUDE_BOOKKEEPING_RECORD_TYPES.has(record.type) ||
      CLAUDE_SESSION_META_RECORD_TYPES.has(record.type)
    ) {
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

// Claude Code's usage-limit menu ("What do you want to do?"), whose
// cursor-selected option line would be rejected by scanTmuxRateLimit's
// gutter/anchor checks. Claude Code 2.1.291 renders a variable option set: the
// stop label ("Stop and wait for limit to reset"), an optional "Wait here, then
// continue automatically ..." or "Don't continue automatically" slot, and the
// extra-usage options ("Ask your admin for more usage", "Add funds to continue
// with usage credits", "Switch to usage credits") plus "Upgrade your plan", in
// an order that depends on the account. The menu is therefore recognised by
// shape: header, numbered/blank lines only, footer, with at least two distinct
// known labels. Whole physical lines are required so prose or fixtures that
// merely mention the wording can't self-trigger.
const CLAUDE_USAGE_MENU_HEADER = /^what do you want to do\?$/i;
const CLAUDE_USAGE_MENU_NUMBERED = /^[^0-9a-z]{0,3}\d\.\s+\S/i;
const CLAUDE_USAGE_MENU_KNOWN_LABEL =
  /^[^0-9a-z]{0,3}\d\.\s*(stop and wait for limit to reset|wait here, then continue automatically(?: shortly| at (?:[a-z]{3} \d{1,2}, (?:\d{4}, )?)?\d{1,2}(?::\d{2})?[ap]m| when the limit resets)?|don[’']t continue automatically|ask your admin for more usage|add funds to continue with usage(?: credits)?|switch to usage(?: credits)?|upgrade your plan)$/i;
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

// Numbered option lines (wrapped continuations joined by a space) of the live
// menu block, or null when the pane tail does not end in a header + numbered/blank
// lines + footer block. The footer must be the last tail line: content after it
// means a newer dialog or output, so an older complete menu is stale. An option
// that took a wrapped continuation must then match a known label exactly.
function extractClaudeUsageMenuBlock(paneText: string): string[] | null {
  const allLines = paneText.split("\n").map((line) => line.trim());
  let end = allLines.length;
  while (end > 0 && allLines[end - 1] === "") end--;
  const lines = allLines.slice(Math.max(0, end - CLAUDE_USAGE_MENU_TAIL_LINES), end);
  const footerIndex = lines.length - 1;
  if (footerIndex < 0 || !CLAUDE_USAGE_MENU_FOOTER.test(lines[footerIndex] ?? "")) return null;
  let headerIndex = footerIndex - 1;
  while (headerIndex >= 0 && !CLAUDE_USAGE_MENU_HEADER.test(lines[headerIndex] ?? ""))
    headerIndex--;
  if (headerIndex < 0) return null;
  const options: string[] = [];
  const wrapped = new Set<number>();
  for (const line of lines.slice(headerIndex + 1, footerIndex)) {
    if (line === "") continue;
    if (CLAUDE_USAGE_MENU_NUMBERED.test(line)) {
      options.push(line);
      continue;
    }
    // Narrow panes wrap a long option label onto an unnumbered next line.
    const last = options.pop();
    if (last === undefined) return null;
    options.push(`${last} ${line}`);
    wrapped.add(options.length - 1);
  }
  for (const index of wrapped) {
    if (!CLAUDE_USAGE_MENU_KNOWN_LABEL.test(options[index] ?? "")) return null;
  }
  return options;
}

export function detectClaudeUsageLimitMenu(paneText: string): RateLimitDetection | null {
  const options = extractClaudeUsageMenuBlock(paneText);
  if (!options) return null;
  const labels = new Set<string>();
  for (const line of options) {
    const label = CLAUDE_USAGE_MENU_KNOWN_LABEL.exec(line)?.[1];
    if (label) labels.add(label.toLowerCase());
  }
  return labels.size >= 2 ? { limited: true, reason: "claude usage limit menu" } : null;
}

// Claude Code renders the selection cursor as "❯" (U+276F) in its current TUI
// and as ">" in older builds; both mean option 1 is highlighted.
const CLAUDE_USAGE_MENU_OPTION_ONE_SELECTED = /^[>❯]\s*1\.\s*stop and wait for limit to reset$/i;

// True only when the live menu block's cursor is on "Stop and wait for limit to
// reset" (option 1), not on any other option. Confirming via Enter must be gated
// on this specifically — detectClaudeUsageLimitMenu only proves the menu is
// showing, not which option is highlighted, and on reordered menus option 1 is
// "Add funds", where Enter would buy credits. Scrollback never counts.
export function claudeUsageMenuOptionOneSelected(paneText: string): boolean {
  const options = extractClaudeUsageMenuBlock(paneText);
  return options?.some((line) => CLAUDE_USAGE_MENU_OPTION_ONE_SELECTED.test(line)) ?? false;
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
    // strip it so the marker is judged against the line's real start.
    const body = stripBannerGlyph(content) ?? content;
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
    // Only codex's "■" keeps the marker-anywhere allowance: its banner reads
    // "■ Your workspace is out of credits …", marker mid-line. Every other
    // status glyph buys nothing but the strip — the marker must still lead the
    // line underneath, because claude prefixes its OWN assistant and tool-call
    // lines with "⏺"/"●"/"✻"/"✢", so a line like "⏺ Updated the usage limit
    // reached marker handling" would otherwise flag a healthy session.
    if (content.startsWith("■") || lower.startsWith(marker)) {
      return { limited: true, reason: `tmux ${marker}` };
    }
  }
  return null;
}
