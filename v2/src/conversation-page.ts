import type { ConversationPage, ConversationResponse } from "./types.js";

export const CONVERSATION_PAGE_BYTES = 48 * 1024;
export const CONVERSATION_MESSAGE_CHARACTERS = 8192;

type PageMessage = ConversationPage["messages"][number];

/** Maps a full message to its shown kind and text; null hides it (its index is still consumed). */
export type ConversationMessageClassifier = (message: {
  role: PageMessage["role"];
  text: string;
}) => { kind: NonNullable<PageMessage["kind"]>; text: string } | null;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Bound visible messages before HTTP serialization; cursors count source entries. */
export function projectConversationPage(
  value: ConversationResponse,
  sessionId: string,
  limit: number,
  classify?: ConversationMessageClassifier,
): ConversationPage {
  const messages: ConversationPage["messages"] = [];
  let consumed = 0;
  for (const entry of value.entries.slice(0, limit)) {
    const shown =
      entry.kind !== "message" ? null : classify ? classify(entry) : { text: entry.text };
    if (entry.kind === "message" && shown) {
      const message: PageMessage = {
        index: value.startIndex + consumed,
        role: entry.role,
        ...("kind" in shown ? { kind: shown.kind } : {}),
        text: shown.text.slice(0, CONVERSATION_MESSAGE_CHARACTERS),
        ...(entry.timestampMs !== undefined ? { timestampMs: entry.timestampMs } : {}),
        ...(shown.text.length > CONVERSATION_MESSAGE_CHARACTERS ? { textTruncated: true } : {}),
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
