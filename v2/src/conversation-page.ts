import type { ConversationPage, ConversationResponse } from "./types.js";

export const CONVERSATION_PAGE_BYTES = 48 * 1024;
export const CONVERSATION_MESSAGE_CHARACTERS = 8192;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Bound visible messages before HTTP serialization; cursors count source entries. */
export function projectConversationPage(
  value: ConversationResponse,
  sessionId: string,
  limit: number,
): ConversationPage {
  const messages: ConversationPage["messages"] = [];
  let consumed = 0;
  for (const entry of value.entries.slice(0, limit)) {
    if (entry.kind === "message") {
      const message = {
        index: value.startIndex + consumed,
        role: entry.role,
        text: entry.text.slice(0, CONVERSATION_MESSAGE_CHARACTERS),
        ...(entry.timestampMs !== undefined ? { timestampMs: entry.timestampMs } : {}),
        ...(entry.text.length > CONVERSATION_MESSAGE_CHARACTERS ? { textTruncated: true } : {}),
      };
      while (messages.length === 0 && bytes(message) > CONVERSATION_PAGE_BYTES - 2048) {
        message.text = message.text.slice(0, Math.floor(message.text.length / 2));
        message.textTruncated = true;
      }
      if (bytes(messages) + bytes(message) > CONVERSATION_PAGE_BYTES - 2048) break;
      messages.push(message);
    }
    consumed++;
  }
  const nextFrom = value.startIndex + consumed;
  return {
    sessionId,
    state: value.state,
    messages,
    startIndex: value.startIndex,
    totalEntries: value.totalEntries,
    nextFrom,
    hasMoreBefore: value.startIndex > 0,
    hasMoreAfter: nextFrom < value.totalEntries,
  };
}
