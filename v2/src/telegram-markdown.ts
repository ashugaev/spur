/**
 * Agent markdown subset -> Telegram HTML. Pure presentation: every character
 * outside a recognised construct is escaped, so the output never carries a tag
 * the agent did not write as markdown. Recognised: fenced code, `code`,
 * **bold**, ~~strike~~, [text](http/https url), and #-headings (bold line).
 * Underscore and single-asterisk italics are left alone (snake_case).
 */

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

const CODE_SPAN = /`([^`\n]+)`/y;
const BOLD = /\*\*([^\n]+?)\*\*/y;
const STRIKE = /~~([^\n]+?)~~/y;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y;

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

interface InlineRule {
  start: string;
  pattern: RegExp;
  render: (match: RegExpExecArray) => string;
}

const INLINE_RULES: readonly InlineRule[] = [
  {
    start: "`",
    pattern: CODE_SPAN,
    render: (match) => `<code>${escapeTelegramHtml(match[1] ?? "")}</code>`,
  },
  { start: "*", pattern: BOLD, render: (match) => `<b>${renderInline(match[1] ?? "")}</b>` },
  { start: "~", pattern: STRIKE, render: (match) => `<s>${renderInline(match[1] ?? "")}</s>` },
  {
    start: "[",
    pattern: LINK,
    render: (match) =>
      `<a href="${escapeAttribute(match[2] ?? "")}">${escapeTelegramHtml(match[1] ?? "")}</a>`,
  },
];

/** Renders one line's inline constructs; unmatched markers stay literal. */
function renderInline(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const rule = INLINE_RULES.find((candidate) => candidate.start === char);
    const match = rule ? matchAt(rule.pattern, text, index) : null;
    if (rule && match) {
      out += rule.render(match);
      index += match[0].length;
    } else {
      out += escapeTelegramHtml(char);
      index += 1;
    }
  }
  return out;
}

interface OpenFence {
  lang: string;
}

function openTag(fence: OpenFence): string {
  return fence.lang ? `<pre><code class="language-${escapeAttribute(fence.lang)}">` : "<pre>";
}

function closeTag(fence: OpenFence): string {
  return fence.lang ? "</code></pre>" : "</pre>";
}

/**
 * Renders raw chunks (already split for Telegram's size limit) in order. A
 * fence still open at the end of a chunk is closed there and reopened, with
 * the same language, at the start of the next one.
 */
export function renderTelegramHtml(chunks: string[]): string[] {
  let fence: OpenFence | null = null;
  return chunks.map((chunk) => {
    const lines = chunk.split("\n");
    const out: string[] = [];
    let fenceLines: string[] | null = fence ? [] : null;
    const flushFence = (open: OpenFence): void => {
      out.push(`${openTag(open)}${(fenceLines ?? []).join("\n")}${closeTag(open)}`);
      fenceLines = null;
    };
    for (const line of lines) {
      const fenceMatch = /^```([\w+#.-]*)\s*$/.exec(line);
      if (fence === null) {
        if (fenceMatch) {
          fence = { lang: fenceMatch[1] ?? "" };
          fenceLines = [];
          continue;
        }
        const heading = /^#{1,6}\s+(.+)$/.exec(line);
        out.push(heading ? `<b>${renderInline(heading[1] ?? "")}</b>` : renderInline(line));
      } else if (fenceMatch && fenceMatch[1] === "") {
        flushFence(fence);
        fence = null;
      } else {
        fenceLines?.push(escapeTelegramHtml(line));
      }
    }
    // Still inside a fence at chunk end: close it here, reopen in the next chunk.
    if (fence !== null && fenceLines !== null) flushFence(fence);
    return out.join("\n");
  });
}
