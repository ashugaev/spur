import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { findLatestSessionFile } from "./claude.js";
import { extractTextContent } from "../claude-jsonl-state.js";

export interface ClaudeSubmitBaseline {
  file: string;
  size: number;
}

export async function captureClaudeSubmitBaseline(
  worktreePath: string,
): Promise<ClaudeSubmitBaseline | null> {
  const file = await findLatestSessionFile(worktreePath);
  if (!file) {
    return null;
  }
  try {
    const fileStat = await stat(file);
    return { file, size: fileStat.size };
  } catch {
    return null;
  }
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
  if (parsed["type"] !== "user") {
    return null;
  }
  const message = parsed["message"];
  if (!isRecord(message)) {
    return null;
  }
  if (message["role"] !== "user") {
    return null;
  }
  return extractTextContent(message);
}

const normalize = (s: string) =>
  s.replace(/^\u0015+/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

async function scanFileForUserText(
  filePath: string,
  startOffset: number,
  normalizedTarget: string,
): Promise<boolean> {
  try {
    const input = createReadStream(filePath, { encoding: "utf-8", start: startOffset });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const rawLine of reader) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const parsed = tryParseJson(trimmed);
        if (!parsed) continue;
        const text = extractUserMessageText(parsed);
        if (text !== null && normalize(text) === normalizedTarget) {
          reader.close();
          return true;
        }
      }
    } finally {
      reader.close();
    }
  } catch {
    return false;
  }
  return false;
}

export async function scanClaudeJsonlForMessage(
  baseline: ClaudeSubmitBaseline,
  text: string,
  worktreePath: string,
): Promise<boolean> {
  const normalizedTarget = normalize(text);

  if (await scanFileForUserText(baseline.file, baseline.size, normalizedTarget)) {
    return true;
  }

  const latest = await findLatestSessionFile(worktreePath);
  if (!latest || latest === baseline.file) {
    return false;
  }
  return scanFileForUserText(latest, 0, normalizedTarget);
}
