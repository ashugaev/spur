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

// A row reaches the wrap boundary once its trimmed content fills the row, with
// one column of slack: a TUI (e.g. an agent CLI) wraps its own output one
// column before the terminal's hard-wrap column.
function isWrapBoundary(text: string, cols: number): boolean {
  return text.trimEnd().length >= cols - 1;
}

// A genuine hard-wrapped URL continuation is one unbroken token once its
// leading TUI gutter (hanging indent) and trailing pad are stripped. Anything
// with interior whitespace is prose, not a URL continuation.
function isUnbrokenToken(text: string): boolean {
  return !INTERIOR_WHITESPACE.test(text.trim());
}

export function groupTerminalRows(
  rows: Array<TerminalBufferRow | undefined>,
  cols: number,
): string[] {
  const lines: string[] = [];
  let current: string | null = null;
  let atWrapBoundary = false;

  const finishCurrent = () => {
    if (current === null) return;
    lines.push(current.trimEnd());
    current = null;
    atWrapBoundary = false;
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
      continue;
    }

    const continuation = row.text.replace(LEADING_WHITESPACE, "");

    if (
      current !== null &&
      atWrapBoundary &&
      UNTERMINATED_URL_TAIL.test(current.trimEnd()) &&
      URL_CHAR_LEADING.test(continuation) &&
      !URL_SCHEME_LEADING.test(continuation) &&
      isUnbrokenToken(continuation)
    ) {
      current = current.trimEnd() + continuation;
      atWrapBoundary = isWrapBoundary(row.text, cols);
      continue;
    }

    finishCurrent();
    current = row.text;
    atWrapBoundary = isWrapBoundary(row.text, cols);
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
