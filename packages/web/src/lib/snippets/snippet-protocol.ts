// Single source for the snippet protocol: message types, limits, labels, stores and
// the action status derived from `_actions` docs. The SDK at
// public/spur/spur-sdk.v2.js carries copies of the message type strings and status
// labels; spur-sdk.test.ts pins them to this file.

import { PAGE_ID_RE } from "@/lib/store-proxy";

// LIMITS. Every size cap is UTF-8 bytes of JSON.stringify(value).
export const SNIPPET_MAX_MOUNTED = 4;
export const SNIPPET_MAX_FILE_BYTES = 256 * 1024;
export const SNIPPET_MAX_PORT_MESSAGE_BYTES = 128 * 1024;
export const SNIPPET_FLOOD_MAX_MESSAGES = 100;
export const SNIPPET_FLOOD_WINDOW_MS = 10_000;
export const SNIPPET_MAX_PAYLOAD_BYTES = 48 * 1024;
export const SNIPPET_MAX_STATE_BYTES = 64 * 1024;
export const SNIPPET_BUDGET_LIMIT = 10;
export const SNIPPET_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SNIPPET_HELLO_TIMEOUT_MS = 10_000;
export const SNIPPET_FETCH_TIMEOUT_MS = 10_000;
export const SNIPPET_HEIGHT_MIN = 120;
export const SNIPPET_HEIGHT_MAX = 800;
export const SNIPPET_PROTOCOL_VERSION = 2;

export const SNIPPET_SDK_URL = "/spur/spur-sdk.v2.js";
export const SNIPPET_FONT_URLS = {
  regular: { url: "/fonts/JetBrainsMono-Regular.woff2", weight: "400" },
  bold: { url: "/fonts/JetBrainsMono-Bold.woff2", weight: "700" },
} as const;

// NAMES AND PATTERNS
export const SNIPPET_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// Same as the daemon action name pattern (v2/src/store-actions.ts ACTION_NAME_RE minus `_`).
export const SNIPPET_ACTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SNIPPET_INSTANCE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
// Session ids are `${prefix}-${4 hex}` (v2/src/ids.ts); only that shape is reserved.
export const SNIPPET_RESERVED_RE = /^snippet\.[A-Za-z0-9_-]+-[0-9a-f]{4}\./;
// No control chars, quote, backslash, brackets, bidi controls, U+061C, U+2028, U+2029.
export const SNIPPET_TEXT_RE =
  // eslint-disable-next-line no-control-regex -- control characters are the point
  /^[^\u0000-\u001F\u007F-\u009F"\\[\]\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u;

export function snippetFileName(sessionId: string, snippetId: string): string {
  return `snippet.${sessionId}.${snippetId}.html`;
}

// STORES. Actions and agent traffic always go to the owning session's store; data
// goes to the manifest `store` when set.
export function ownerStoreOf(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Valid manifest `store` for a snippet owned by `sessionId`. */
export function isAllowedSnippetStore(store: string, sessionId: string): boolean {
  if (store === ownerStoreOf(sessionId)) return true;
  return store.startsWith("page:") && PAGE_ID_RE.test(store.slice("page:".length));
}

/** `_state` doc id: `snippet-<first 12 hex of sha256(owner)>-<snippetId>`, at most 85 chars. */
export async function snippetStateDocId(sessionId: string, snippetId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
  return `snippet-${hex}-${snippetId}`;
}

// MESSAGES
export const SNIPPET_WINDOW_MSG = { hello: "spur:hello", connect: "spur:connect" } as const;
// Requests carrying a `callId` (db, agent, invoke, fullscreen open) are answered with
// the same `type` and `callId`; invoke answers with `invoke-result`.
export const SNIPPET_TO_HOST = {
  invoke: "invoke",
  stateSet: "state-set",
  db: "db",
  dbSubscribe: "db-subscribe",
  dbUnsubscribe: "db-unsubscribe",
  agent: "agent",
  fullscreen: "fullscreen",
  resize: "resize",
  escape: "escape",
} as const;
export const SNIPPET_TO_FRAME = {
  invokeResult: "invoke-result",
  action: "action",
  theme: "theme",
  fullscreen: "fullscreen",
  availability: "availability",
  dbChange: "db-change",
  dbReset: "db-reset",
  agentEvent: "agent-event",
} as const;

export const SNIPPET_THEME_TOKENS = [
  "bg-base",
  "bg-surface",
  "bg-elevated",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "border-default",
  "border-subtle",
  "accent",
  "status-error",
  "status-ready",
  "input-bg",
  "input-border",
  "text-inverse",
  "status-working",
  "status-attention",
] as const;
export type SnippetThemeToken = (typeof SNIPPET_THEME_TOKENS)[number];
export interface SnippetTheme {
  mode: "light" | "dark";
  tokens: Record<SnippetThemeToken, string>;
}

// STATUS AND REJECTIONS
// Host-local: awaiting_confirm, submitting. Everything else comes from the `_actions` doc.
export type SnippetActionStatus =
  | "awaiting_confirm"
  | "submitting"
  | "queued"
  | "processing"
  | "completed"
  | "error"
  | "timeout";

export type SnippetConfirmReason =
  | "declared"
  | "no_focus"
  | "repeat_in_revision"
  | "budget"
  | "storage_unavailable";

export type SnippetInvokeRejection =
  | "not_connected"
  | "unknown_action"
  | "payload_too_large"
  | "invalid_payload"
  | "session_unavailable"
  | "busy"
  | "declined"
  | "stale";

export interface SnippetAvailability {
  canInvoke: boolean;
  reason: "session_unavailable" | "revision_conflict" | null;
}

export const SNIPPET_TERMINAL_STATUSES: readonly SnippetActionStatus[] = [
  "completed",
  "error",
  "timeout",
];
export const SNIPPET_RETRY_STATUSES: readonly SnippetActionStatus[] = ["error", "timeout"];

export function isTerminalSnippetStatus(status: SnippetActionStatus): boolean {
  return SNIPPET_TERMINAL_STATUSES.includes(status);
}

export const SNIPPET_STATUS_LABELS: Record<Exclude<SnippetActionStatus, "error">, string> = {
  awaiting_confirm: "Confirm to send",
  submitting: "Sent",
  queued: "Queued",
  processing: "Agent working",
  completed: "Done",
  timeout: "No reply in 15 min",
};

export function snippetStatusLabel(action: {
  status: SnippetActionStatus;
  httpStatus?: number;
}): string {
  if (action.status === "error") {
    return action.httpStatus === undefined ? "Failed" : `Send failed · HTTP ${action.httpStatus}`;
  }
  return SNIPPET_STATUS_LABELS[action.status];
}

export const SNIPPET_CONFIRM_REASON_TEXT: Record<SnippetConfirmReason, string> = {
  declared: "This action always asks before sending.",
  no_focus: "Snippet started this without a click inside it.",
  repeat_in_revision: "Second action on this revision. Confirm it is yours.",
  budget: "10 sends without a confirm. Confirm this one.",
  storage_unavailable: "Browser storage unavailable. Each send needs a confirm.",
};

// `_actions` doc status -> panel status. `working` = the owning agent is busy.
export function actionStatusFromDoc(
  data: { status?: unknown; error?: unknown },
  working: boolean,
): SnippetActionStatus {
  if (data.status === "done") return "completed";
  if (data.status === "failed") return data.error === "timeout" ? "timeout" : "error";
  return working ? "processing" : "queued";
}

// BYTES. Infinity when the value cannot be serialized, so it fails every cap.
const encoder = new TextEncoder();
export function snippetByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Number.POSITIVE_INFINITY : encoder.encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
