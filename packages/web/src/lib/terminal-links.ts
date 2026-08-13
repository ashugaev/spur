export interface TerminalBufferRow {
  text: string;
  isWrapped: boolean;
}

export interface TerminalLink {
  url: string;
  hostname: string;
}

const TERMINAL_URL_PATTERN = /https?:\/\/\S+/giu;
const SENTENCE_SUFFIX = new Set([".", ",", ":", ";", "!", "?"]);
const QUOTE_SUFFIX = new Set(["'", '"', "`", ">"]);
const DELIMITER_PAIRS = {
  ")": "(",
  "]": "[",
  "}": "{",
} as const;

export function groupTerminalRows(rows: Array<TerminalBufferRow | undefined>): string[] {
  const lines: string[] = [];
  let current: string | null = null;

  const finishCurrent = () => {
    if (current === null) return;
    lines.push(current.trimEnd());
    current = null;
  };

  for (const row of rows) {
    if (!row) {
      finishCurrent();
      continue;
    }

    if (!row.isWrapped) {
      finishCurrent();
      current = row.text;
      continue;
    }

    if (current !== null) {
      current += row.text;
    }
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

export function extractTerminalLinks(rows: Array<TerminalBufferRow | undefined>): TerminalLink[] {
  const occurrences: TerminalLink[] = [];

  for (const line of groupTerminalRows(rows)) {
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
