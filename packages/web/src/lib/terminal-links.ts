export interface TerminalBufferRow {
  text: string;
  isWrapped: boolean;
}

export interface TerminalLink {
  url: string;
  hostname: string;
}

const TERMINAL_URL_PATTERN = /https?:\/\/\S+/giu;
const URL_CHAR_CLASS = "A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=%";
const UNTERMINATED_URL_TAIL = new RegExp(`https?://[${URL_CHAR_CLASS}]*$`, "iu");
const URL_CHAR_LEADING = new RegExp(`^[${URL_CHAR_CLASS}]`, "u");
const URL_SCHEME_LEADING = /^https?:\/\//iu;
const SENTENCE_SUFFIX = new Set([".", ",", ":", ";", "!", "?"]);
const QUOTE_SUFFIX = new Set(["'", '"', "`", ">"]);
const DELIMITER_PAIRS = {
  ")": "(",
  "]": "[",
  "}": "{",
} as const;

const LEADING_WHITESPACE = /^\s+/u;
const INTERIOR_WHITESPACE = /\s/u;
const URL_CONTINUATION_LEADING = /^[/.?#&=%]/u;

export const TERMINAL_LINK_DISCOVERY_LIMIT = 100;

// The measured shortfall between a TUI's own hanging-indent wrap column and
// the terminal's hard-wrap column is 2 (head row trimEnd 118 at cols 120).
// Adversarial short lines — a URL-ending sentence followed by an unrelated
// token starting `/ . ? # & = %`, e.g. a bare `.gitignore` under a "Docs:"
// line — stop 93+ columns short. A slack of 2 covers the measured case and
// excludes every adversarial one; do not widen it without a new measurement.
const TERMINAL_LINK_CONTINUATION_SLACK = 2;

// A row reaches a boundary once its trimmed content fills the row within
// `slack` columns: a TUI (e.g. an agent CLI) wraps its own output some
// columns before the terminal's hard-wrap column.
function isWithinSlackOfWrap(text: string, cols: number, slack: number): boolean {
  return text.trimEnd().length >= cols - slack;
}

function isWrapBoundary(text: string, cols: number): boolean {
  return isWithinSlackOfWrap(text, cols, 1);
}

// A genuine hard-wrapped URL continuation is one unbroken token once its
// leading TUI gutter (hanging indent) and trailing pad are stripped. Anything
// with interior whitespace is prose, not a URL continuation.
function isUnbrokenToken(text: string): boolean {
  return !INTERIOR_WHITESPACE.test(text.trim());
}

// A continuation row joins the pending logical line when either the head row
// reached the wrap boundary (PR #711's rule), or the head row stopped short
// of it but within TERMINAL_LINK_CONTINUATION_SLACK columns, the pending text
// still ends mid-URL, and the row below reads as a bare continuation: no
// leading whitespace on the raw row, one unbroken token, no scheme of its
// own, and a first character drawn from the URL path/query grammar rather
// than prose. The slack condition (`nearWrapBoundary`) is what keeps a URL
// row far short of the wrap column — a sentence followed by an unrelated
// `.gitignore` or `/etc/hosts` row — from being folded into it.
function shouldJoinContinuation(
  current: string,
  rowText: string,
  continuation: string,
  atWrapBoundary: boolean,
  nearWrapBoundary: boolean,
): boolean {
  const trimmedCurrent = current.trimEnd();

  const branchA =
    atWrapBoundary &&
    UNTERMINATED_URL_TAIL.test(trimmedCurrent) &&
    URL_CHAR_LEADING.test(continuation) &&
    !URL_SCHEME_LEADING.test(continuation) &&
    isUnbrokenToken(continuation);

  const branchB =
    nearWrapBoundary &&
    UNTERMINATED_URL_TAIL.test(trimmedCurrent) &&
    !LEADING_WHITESPACE.test(rowText) &&
    isUnbrokenToken(continuation) &&
    !URL_SCHEME_LEADING.test(continuation) &&
    URL_CONTINUATION_LEADING.test(continuation);

  return branchA || branchB;
}

export function groupTerminalRows(
  rows: Array<TerminalBufferRow | undefined>,
  cols: number,
): string[] {
  const lines: string[] = [];
  let current: string | null = null;
  let atWrapBoundary = false;
  let nearWrapBoundary = false;

  const finishCurrent = () => {
    if (current === null) return;
    lines.push(current.trimEnd());
    current = null;
    atWrapBoundary = false;
    nearWrapBoundary = false;
  };

  for (const row of rows) {
    if (!row) {
      finishCurrent();
      continue;
    }

    if (row.isWrapped) {
      if (current !== null) {
        current += row.text;
      }
      atWrapBoundary = isWrapBoundary(row.text, cols);
      nearWrapBoundary = isWithinSlackOfWrap(row.text, cols, TERMINAL_LINK_CONTINUATION_SLACK);
      continue;
    }

    const continuation = row.text.replace(LEADING_WHITESPACE, "");

    if (
      current !== null &&
      shouldJoinContinuation(current, row.text, continuation, atWrapBoundary, nearWrapBoundary)
    ) {
      current = current.trimEnd() + continuation;
      atWrapBoundary = isWrapBoundary(row.text, cols);
      nearWrapBoundary = isWithinSlackOfWrap(row.text, cols, TERMINAL_LINK_CONTINUATION_SLACK);
      continue;
    }

    finishCurrent();
    current = row.text;
    atWrapBoundary = isWrapBoundary(row.text, cols);
    nearWrapBoundary = isWithinSlackOfWrap(row.text, cols, TERMINAL_LINK_CONTINUATION_SLACK);
  }

  finishCurrent();
  return lines;
}

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const candidate of value) {
    if (candidate === character) count += 1;
  }
  return count;
}

function trimTerminalUrlCandidate(candidate: string): string {
  let trimmed = candidate;
  let changed = true;

  while (changed && trimmed.length > 0) {
    changed = false;
    const suffix = trimmed.at(-1);
    if (!suffix) break;

    if (SENTENCE_SUFFIX.has(suffix) || QUOTE_SUFFIX.has(suffix)) {
      trimmed = trimmed.slice(0, -1);
      changed = true;
      continue;
    }

    if (suffix in DELIMITER_PAIRS) {
      const opener = DELIMITER_PAIRS[suffix as keyof typeof DELIMITER_PAIRS];
      if (countCharacter(trimmed, suffix) > countCharacter(trimmed, opener)) {
        trimmed = trimmed.slice(0, -1);
        changed = true;
      }
    }
  }

  return trimmed;
}

export function extractTerminalLinks(
  rows: Array<TerminalBufferRow | undefined>,
  cols: number,
): TerminalLink[] {
  const occurrences: TerminalLink[] = [];

  for (const line of groupTerminalRows(rows, cols)) {
    for (const match of line.matchAll(TERMINAL_URL_PATTERN)) {
      const url = trimTerminalUrlCandidate(match[0]);
      try {
        const parsed = new URL(url);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
          continue;
        }
        occurrences.push({ url, hostname: parsed.hostname });
      } catch {
        // Ignore malformed visible candidates.
      }
    }
  }

  const seen = new Set<string>();
  const links: TerminalLink[] = [];
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    if (!occurrence || seen.has(occurrence.url)) continue;
    seen.add(occurrence.url);
    links.push(occurrence);
  }
  return links;
}

export function areTerminalLinksEqual(left: TerminalLink[], right: TerminalLink[]): boolean {
  return (
    left.length === right.length && left.every((link, index) => link.url === right[index]?.url)
  );
}

// Folds a fresh scan (newest-first) into the accumulated discovery list
// (oldest-first), deduped by exact URL. Over the limit, evicts oldest-first
// among entries the current scan does not corroborate — never a URL still on
// screen — repeating until at or under the limit or every remaining entry is
// in the scan. A quiescent terminal can therefore sit above the limit by at
// most the scan size; that is preferred over dropping a URL still visible.
export function mergeTerminalLinkDiscoveries(
  discovered: TerminalLink[],
  scanned: TerminalLink[],
  limit: number,
): TerminalLink[] {
  const scannedUrls = new Set(scanned.map((link) => link.url));
  const merged = [...discovered];
  const mergedUrls = new Set(merged.map((link) => link.url));

  for (let index = scanned.length - 1; index >= 0; index -= 1) {
    const link = scanned[index];
    if (!link || mergedUrls.has(link.url)) continue;
    mergedUrls.add(link.url);
    merged.push(link);
  }

  while (merged.length > limit) {
    const evictIndex = merged.findIndex((link) => !scannedUrls.has(link.url));
    if (evictIndex === -1) break;
    merged.splice(evictIndex, 1);
  }

  return merged;
}

// Composes the displayed list: every URL the current scan found, in scan
// order, followed by earlier discoveries (in discovery order) that the scan
// did not find. The scan half is never filtered against `discovered` — a
// keep-mode scan (the resize rescan) deliberately does not merge into
// `discovered`, so a URL that only becomes visible after a reflow would be
// on screen but missing from `discovered` yet; filtering it out here would
// hide something the pty is actually showing, with nothing left to surface
// it once the pty goes idle. Showing it for one frame is correct: it IS on
// screen, and because keep-mode never records it, it drops back out on the
// next scan on its own. In merge mode this changes nothing, since a merge
// adds every scanned URL into `discovered` before eviction, and eviction
// never touches a URL still present in `scanned` — so `scanned` is always a
// subset of `discovered` there.
export function composeTerminalLinkDisplay(
  scanned: TerminalLink[],
  discovered: TerminalLink[],
): TerminalLink[] {
  const scannedUrls = new Set(scanned.map((link) => link.url));
  const leftovers = discovered.filter((link) => !scannedUrls.has(link.url));
  return [...scanned, ...leftovers];
}
