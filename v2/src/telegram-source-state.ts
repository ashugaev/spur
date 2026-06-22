import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TelegramSourceConfig } from "./types.js";

export interface TelegramBinding {
  chatId: number;
  messageThreadId?: number;
  sessionId: string;
}

interface TelegramBindingsFile {
  bindings: TelegramBinding[];
}

export interface TelegramReplyTarget {
  sessionId: string;
  projectId: string;
  sourceId: string;
  chatId: number;
  messageThreadId?: number;
  updatedAt: string;
}

export function telegramBindingFilePath(
  dataDir: string,
  projectId: string,
  sourceId: string,
): string {
  return join(dataDir, "source-state", "telegram", projectId, `${sourceId}.json`);
}

export function telegramBindingKey(chatId: number, messageThreadId?: number): string {
  return `${chatId}:${messageThreadId ?? "main"}`;
}

export function readTelegramBindings(path: string): Map<string, TelegramBinding> {
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TelegramBindingsFile;
    if (!Array.isArray(parsed.bindings)) return new Map();
    const bindings = parsed.bindings.filter(
      (entry): entry is TelegramBinding =>
        typeof entry.chatId === "number" &&
        Number.isInteger(entry.chatId) &&
        (entry.messageThreadId === undefined ||
          (typeof entry.messageThreadId === "number" && Number.isInteger(entry.messageThreadId))) &&
        typeof entry.sessionId === "string" &&
        entry.sessionId.trim().length > 0,
    );
    return new Map(
      bindings.map((entry) => [telegramBindingKey(entry.chatId, entry.messageThreadId), entry]),
    );
  } catch {
    return new Map();
  }
}

export function writeTelegramBindings(path: string, bindings: Map<string, TelegramBinding>): void {
  mkdirSync(dirname(path), { recursive: true });
  const value: TelegramBindingsFile = {
    bindings: [...bindings.values()].sort((left, right) => {
      const chatOrder = left.chatId - right.chatId;
      if (chatOrder !== 0) return chatOrder;
      return (left.messageThreadId ?? 0) - (right.messageThreadId ?? 0);
    }),
  };
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function replyTargetDir(dataDir: string): string {
  return join(dataDir, "source-state", "telegram", "reply-targets");
}

function replyTargetPath(dataDir: string, sessionId: string): string {
  return join(replyTargetDir(dataDir), `${encodeURIComponent(sessionId)}.json`);
}

function isTelegramReplyTarget(value: unknown): value is TelegramReplyTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<TelegramReplyTarget>;
  return (
    typeof target.sessionId === "string" &&
    target.sessionId.trim().length > 0 &&
    typeof target.projectId === "string" &&
    target.projectId.trim().length > 0 &&
    typeof target.sourceId === "string" &&
    target.sourceId.trim().length > 0 &&
    typeof target.chatId === "number" &&
    Number.isInteger(target.chatId) &&
    (target.messageThreadId === undefined ||
      (typeof target.messageThreadId === "number" && Number.isInteger(target.messageThreadId))) &&
    typeof target.updatedAt === "string"
  );
}

export function writeTelegramReplyTarget(
  dataDir: string,
  target: Omit<TelegramReplyTarget, "updatedAt">,
): void {
  const dir = replyTargetDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = replyTargetPath(dataDir, target.sessionId);
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  const value: TelegramReplyTarget = { ...target, updatedAt: new Date().toISOString() };
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function readTelegramReplyTarget(
  dataDir: string,
  sessionId: string,
): TelegramReplyTarget | null {
  const path = replyTargetPath(dataDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isTelegramReplyTarget(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeTelegramReplyTarget(dataDir: string, sessionId: string): void {
  const path = replyTargetPath(dataDir, sessionId);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best effort only.
  }
}

export async function sendTelegramReply(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId">,
  text: string,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: target.chatId,
      text,
      ...(target.messageThreadId !== undefined
        ? { message_thread_id: target.messageThreadId }
        : {}),
    }),
  });
  if (response.ok) return;

  let description = response.statusText;
  try {
    const payload = (await response.json()) as { description?: unknown };
    if (typeof payload.description === "string") {
      description = payload.description;
    }
  } catch {
    // Use status text.
  }
  throw new Error(`Telegram reply failed: ${description}`);
}
