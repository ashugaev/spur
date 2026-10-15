import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { findLatestSessionFile, sessionFileForId, sessionFilePathForId } from "./claude.js";
import { extractTextContent } from "../claude-jsonl-state.js";
import type { NativeUserObservation } from "./index.js";

export interface ClaudeSubmitBaseline {
  file: string;
  size: number;
}

export async function captureClaudeSubmitBaseline(
  worktreePath: string,
  agentSessionId?: string,
  options?: { freshLaunch?: boolean },
): Promise<ClaudeSubmitBaseline | null> {
  const file = agentSessionId
    ? await sessionFileForId(worktreePath, agentSessionId)
    : await findLatestSessionFile(worktreePath);
  if (file) {
    try {
      const fileStat = await stat(file);
      return { file, size: fileStat.size };
    } catch {
      return null;
    }
  }
  if (!agentSessionId || options?.freshLaunch !== true) {
    return null;
  }
  // A freshly launched claude writes `<uuid>.jsonl` only when it persists the
  // first submitted message, so the launch send has no transcript to baseline
  // against — exactly when the ack matters. Bind to the path the pinned id will
  // create; `scanClaudeJsonlForMessage` tolerates a file that is not there yet
  // and re-resolves the id when this candidate never appears.
  return { file: sessionFilePathForId(worktreePath, agentSessionId), size: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractUserMessageText(parsed: Record<string, unknown>): string | null {
  const message = parsed["message"];
  if (!isRecord(message)) {
    return null;
  }
  if (message["role"] !== "user") {
    return null;
  }
  const text = extractTextContent(message);
  return slashCommandText(text) ?? text;
}

// A slash command or skill is recorded as tags, not as the typed line:
// `<command-name>/cmd</command-name>` plus `<command-args>…</command-args>`
// (and `<command-message>`), in either order. Rebuilt as `/cmd args`.
function slashCommandText(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) {
    return null;
  }
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  return args ? `${name} ${args}` : name;
}

// A send typed into a busy pane is queued, and claude writes no `type:"user"`
// record for it until the turn absorbing it ends. The queue `enqueue` record is
// written when Enter lands and carries the submitted text, so it is the ack.
function extractEnqueuedText(parsed: Record<string, unknown>): string | null {
  if (parsed["operation"] !== "enqueue") {
    return null;
  }
  const content = parsed["content"];
  return typeof content === "string" ? content : null;
}

// Claude >=2.1.277 records a long typed paste wrapped as
// `\n\n<pasted_content id="x">\n<text>\n</pasted_content id="x">\n`, in both the
// user and the enqueue record. Unwrap only when that block is the whole record
// and the closing id matches the opening one.
function unwrapPastedContent(text: string): string {
  const inner = /^<pasted_content id="([^"]*)">\n([\s\S]*)\n<\/pasted_content id="\1">$/.exec(
    text.trim(),
  );
  return inner?.[2] ?? text;
}

function extractDeliveredText(parsed: Record<string, unknown>): string | null {
  switch (parsed["type"]) {
    case "user":
      return extractUserMessageText(parsed);
    case "queue-operation":
      return extractEnqueuedText(parsed);
    default:
      return null;
  }
}

const CTRL_U = String.fromCharCode(0x15);

function stripLeadingCtrlU(value: string): string {
  let index = 0;
  while (value[index] === CTRL_U) {
    index += 1;
  }
  return value.slice(index);
}

const normalize = (s: string) =>
  stripLeadingCtrlU(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

export function claudeNativeInputDigest(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

async function scanFileForDeliveredText(
  filePath: string,
  startOffset: number,
  normalizedTarget: string | null,
  native?: {
    sessionId: string;
    bodyDigest: string;
    matches: NativeUserObservation[];
  },
): Promise<boolean> {
  try {
    if (native && startOffset > 0) {
      const file = await open(filePath, "r");
      try {
        const boundary = Buffer.alloc(1);
        const read = await file.read(boundary, 0, 1, startOffset - 1);
        if (read.bytesRead !== 1 || boundary[0] !== 10) return false;
      } finally {
        await file.close();
      }
    }
    const input = createReadStream(filePath, { encoding: "utf-8", start: startOffset });
    let byteOffset = startOffset;
    const framing = { lineFeedOnly: true, terminated: false };
    input.on("data", (chunk: string | Buffer) => {
      if (chunk.includes("\r")) framing.lineFeedOnly = false;
      framing.terminated = chunk.at(-1) === (typeof chunk === "string" ? "\n" : 10);
    });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const rawLine of reader) {
        const rowOffset = byteOffset;
        const rowBytes = Buffer.byteLength(rawLine);
        byteOffset += rowBytes + 1;
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const parsed = tryParseJson(trimmed);
        if (!parsed) continue;
        const text = extractDeliveredText(parsed);
        if (
          native &&
          parsed["type"] === "user" &&
          parsed["sessionId"] === native.sessionId &&
          parsed["isMeta"] !== true &&
          parsed["isCompactSummary"] !== true &&
          parsed["isSidechain"] !== true
        ) {
          const userText = extractUserMessageText(parsed);
          if (userText !== null) {
            const bodyDigests = [userText, unwrapPastedContent(userText)].map(
              claudeNativeInputDigest,
            );
            if (bodyDigests.includes(native.bodyDigest)) {
              native.matches.push({
                nativeSessionId: native.sessionId,
                source: filePath,
                recordId:
                  typeof parsed["uuid"] === "string"
                    ? parsed["uuid"]
                    : `bytes:${rowOffset}:${rowBytes}`,
                recordDigest: createHash("sha256").update(rawLine).digest("hex"),
                bodyDigest: native.bodyDigest,
              });
            }
          }
        }
        // Raw first: a short send that is itself a pasted_content block is
        // recorded as typed, so unwrapping alone would miss it.
        if (
          normalizedTarget !== null &&
          text !== null &&
          (normalize(text) === normalizedTarget ||
            normalize(unwrapPastedContent(text)) === normalizedTarget)
        ) {
          reader.close();
          return true;
        }
      }
      if (native && (!framing.lineFeedOnly || !framing.terminated)) native.matches.length = 0;
    } finally {
      reader.close();
    }
  } catch {
    if (native) native.matches.length = 0;
    return false;
  }
  return false;
}

export async function observeClaudeNativeUsers(
  baseline: ClaudeSubmitBaseline,
  bodyDigest: string,
  agentSessionId: string,
): Promise<NativeUserObservation[]> {
  const matches: NativeUserObservation[] = [];
  await scanFileForDeliveredText(baseline.file, baseline.size, null, {
    sessionId: agentSessionId,
    bodyDigest,
    matches,
  });
  return matches;
}

export async function scanClaudeJsonlForMessage(
  baseline: ClaudeSubmitBaseline,
  text: string,
  worktreePath: string,
  agentSessionId?: string,
): Promise<boolean> {
  const normalizedTarget = normalize(text);

  if (await scanFileForDeliveredText(baseline.file, baseline.size, normalizedTarget)) {
    return true;
  }

  // When a pinned id exists, stay bound to its transcript; otherwise fall back
  // to the newest-mtime scan for legacy sessions.
  const latest = agentSessionId
    ? await sessionFileForId(worktreePath, agentSessionId)
    : await findLatestSessionFile(worktreePath);
  if (!latest || latest === baseline.file) {
    return false;
  }
  return scanFileForDeliveredText(latest, 0, normalizedTarget);
}
