import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OrchestratorConfig, SessionId } from "./types.js";
import { getProjectBaseDir, getSessionsDir } from "./paths.js";

const STATE_VERSION = 1;
const LOCK_STALE_MS = 2 * 60_000;
const LOCK_RETRY_ATTEMPTS = 200;
const LOCK_RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesSessionPrefix(sessionId: string, sessionPrefix: string): boolean {
  const escaped = escapeRegex(sessionPrefix);
  const workerPattern = new RegExp(`^${escaped}-\\d+$`);
  return workerPattern.test(sessionId) || sessionId === `${sessionPrefix}-orchestrator`;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return undefined;
}

function buildDisplayName(firstName?: string, lastName?: string): string | undefined {
  const first = toNonEmptyString(firstName);
  const last = toNonEmptyString(lastName);
  if (!first && !last) return undefined;
  return [first, last].filter(Boolean).join(" ");
}

function isOrchestratorSessionId(sessionId: SessionId): boolean {
  return sessionId.endsWith("-orchestrator");
}

function buildTelegramRoutingSummary(routing: Record<string, unknown>): string | null {
  const chatId = toNonEmptyString(routing["chatId"]);
  if (!chatId) return null;

  const parts = [`chat=${chatId}`];
  const threadId = toOptionalNumber(routing["threadId"]);
  if (threadId !== undefined) {
    parts.push(`thread=${Math.trunc(threadId)}`);
  }

  const messageId = toOptionalNumber(routing["messageId"]);
  if (messageId !== undefined) {
    parts.push(`message=${Math.trunc(messageId)}`);
  }

  const projectId = toNonEmptyString(routing["projectId"]);
  if (projectId) {
    parts.push(`project=${projectId}`);
  }

  const fromDisplayName = toNonEmptyString(routing["fromDisplayName"]);
  const fromUsername = toNonEmptyString(routing["fromUsername"]);
  if (fromDisplayName) {
    parts.push(`from=${fromDisplayName}`);
  } else if (fromUsername) {
    parts.push(`from=@${fromUsername}`);
  }

  return parts.join(", ");
}

function buildJiraRoutingSummary(routing: Record<string, unknown>): string | null {
  const issueKey = toNonEmptyString(routing["issueKey"]);
  if (!issueKey) return null;

  const parts = [`issue=${issueKey}`];
  const commentId = toStringOrUndefined(routing["commentId"]);
  if (commentId) {
    parts.push(`comment=${commentId}`);
  }

  const authorDisplayName = toNonEmptyString(routing["authorDisplayName"]);
  const authorEmail = toNonEmptyString(routing["authorEmail"]);
  if (authorDisplayName) {
    parts.push(`from=${authorDisplayName}`);
  } else if (authorEmail) {
    parts.push(`from=${authorEmail}`);
  }

  return parts.join(", ");
}

function buildGenericRoutingSummary(routing: Record<string, unknown>): string | null {
  const entries = Object.entries(routing)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}=${String(value)}`)
    .slice(0, 4);

  return entries.length > 0 ? entries.join(", ") : null;
}

export interface TelegramInboundRouting {
  [key: string]: unknown;
  chatId: string;
  messageId: number;
  threadId?: number;
  projectId?: string;
  fromId?: number;
  fromUsername?: string;
  fromDisplayName?: string;
}

export interface JiraInboundRouting {
  [key: string]: unknown;
  issueKey: string;
  commentId?: string;
  authorEmail?: string;
  authorDisplayName?: string;
}

export type InboundSource = "telegram" | (string & {});

export interface FormatInboundMessageForSessionInput {
  sessionId: SessionId;
  source: InboundSource;
  text: string;
  routing?: Record<string, unknown>;
  includeReplyCommand?: boolean;
}

export interface InboundEnvelope {
  id: string;
  sessionId: SessionId;
  source: InboundSource;
  text: string;
  receivedAt: string;
  routing: Record<string, unknown>;
}

export interface EnqueueInboundEnvelopeInput {
  id?: string;
  sessionId: SessionId;
  source: InboundSource;
  text: string;
  receivedAt?: string;
  routing: Record<string, unknown>;
}

interface StoredInboundEnvelope {
  id: string;
  sessionId: SessionId;
  source: InboundSource;
  text: string;
  receivedAt: string;
  routing: Record<string, unknown>;
  dedupeKey?: string;
  ackedAt?: string;
}

interface InboundContextState {
  version: number;
  sessionId: SessionId;
  envelopes: StoredInboundEnvelope[];
}

export interface InboundContextStore {
  enqueue(input: EnqueueInboundEnvelopeInput): Promise<InboundEnvelope>;
  peekNext(sessionId: SessionId): Promise<InboundEnvelope | null>;
  ack(sessionId: SessionId, envelopeId: string): Promise<boolean>;
  listPending(sessionId: SessionId): Promise<InboundEnvelope[]>;
}

function toPublicEnvelope(envelope: StoredInboundEnvelope): InboundEnvelope {
  return {
    id: envelope.id,
    sessionId: envelope.sessionId,
    source: envelope.source,
    text: envelope.text,
    receivedAt: envelope.receivedAt,
    routing: envelope.routing,
  };
}

function createEmptyState(sessionId: SessionId): InboundContextState {
  return { version: STATE_VERSION, sessionId, envelopes: [] };
}

function parseState(raw: string, sessionId: SessionId): InboundContextState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createEmptyState(sessionId);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return createEmptyState(sessionId);
  }

  const obj = parsed as {
    version?: unknown;
    sessionId?: unknown;
    envelopes?: unknown;
  };

  if (obj.version !== STATE_VERSION) {
    return createEmptyState(sessionId);
  }

  const storedSessionId = typeof obj.sessionId === "string" ? obj.sessionId : sessionId;
  if (!Array.isArray(obj.envelopes)) {
    return createEmptyState(storedSessionId);
  }

  const envelopes: StoredInboundEnvelope[] = [];
  for (const item of obj.envelopes) {
    if (typeof item !== "object" || item === null) continue;
    const typed = item as Partial<StoredInboundEnvelope>;

    if (
      typeof typed.id !== "string" ||
      typeof typed.sessionId !== "string" ||
      typeof typed.source !== "string" ||
      typeof typed.text !== "string" ||
      typeof typed.receivedAt !== "string" ||
      typeof typed.routing !== "object" ||
      typed.routing === null ||
      Array.isArray(typed.routing)
    ) {
      continue;
    }

    const ackedAt = typeof typed.ackedAt === "string" ? typed.ackedAt : undefined;
    const dedupeKey = typeof typed.dedupeKey === "string" ? typed.dedupeKey : undefined;

    envelopes.push({
      id: typed.id,
      sessionId: typed.sessionId,
      source: typed.source,
      text: typed.text,
      receivedAt: typed.receivedAt,
      routing: typed.routing as Record<string, unknown>,
      ackedAt,
      dedupeKey,
    });
  }

  return {
    version: STATE_VERSION,
    sessionId: storedSessionId,
    envelopes,
  };
}

function serializeState(state: InboundContextState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function getDedupeKey(envelope: StoredInboundEnvelope): string | null {
  if (envelope.source === "telegram") {
    const chatId = toNonEmptyString(envelope.routing["chatId"]);
    const messageId = toOptionalNumber(envelope.routing["messageId"]);
    if (!chatId || messageId === undefined) return null;
    return `telegram:${chatId}:${Math.trunc(messageId)}`;
  }

  if (envelope.source === "jira") {
    const issueKey = toNonEmptyString(envelope.routing["issueKey"]);
    const commentId = toStringOrUndefined(envelope.routing["commentId"]);
    if (!issueKey || !commentId) return null;
    return `jira:${issueKey}:${commentId}`;
  }

  return null;
}

function buildRoutingSummary(
  source: InboundSource,
  routing?: Record<string, unknown>,
): string | null {
  if (!routing) return null;
  if (source === "telegram") {
    return buildTelegramRoutingSummary(routing);
  }
  if (source === "jira") {
    return buildJiraRoutingSummary(routing);
  }
  return buildGenericRoutingSummary(routing);
}

export function formatInboundMessageForSession(
  input: FormatInboundMessageForSessionInput,
): string {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) {
    throw new Error("Inbound message text is required");
  }

  if (!isOrchestratorSessionId(input.sessionId)) {
    return text;
  }

  const source = toNonEmptyString(input.source) ?? "external";
  const includeReplyCommand = input.includeReplyCommand !== false;
  const routingSummary = buildRoutingSummary(source, input.routing);

  const lines = [`[SOURCE:${source}] inbound message from connected integration.`];
  if (routingSummary) {
    lines.push(`Routing: ${routingSummary}`);
  }

  if (includeReplyCommand) {
    lines.push(`Reply in the same source: ao source-reply ${input.sessionId} "<message>"`);
  } else {
    lines.push("Reply in source is temporarily unavailable (context envelope was not persisted).");
  }

  lines.push("", text);
  return lines.join("\n");
}

function resolveProjectPathForSession(
  config: Pick<OrchestratorConfig, "configPath" | "projects">,
  sessionId: SessionId,
): string | null {
  let prefixMatch: string | null = null;

  for (const [projectId, project] of Object.entries(config.projects)) {
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const sessionPath = join(sessionsDir, sessionId);

    if (existsSync(sessionPath)) {
      return project.path;
    }

    const sessionPrefix = project.sessionPrefix || projectId;
    if (!matchesSessionPrefix(sessionId, sessionPrefix)) continue;

    if (prefixMatch && prefixMatch !== project.path) {
      return null;
    }
    prefixMatch = project.path;
  }

  return prefixMatch;
}

function buildStatePath(
  config: Pick<OrchestratorConfig, "configPath" | "projects">,
  sessionId: SessionId,
): string {
  const projectPath = resolveProjectPathForSession(config, sessionId);
  if (!projectPath) {
    throw new Error(`Could not resolve project for session "${sessionId}"`);
  }

  const baseDir = getProjectBaseDir(config.configPath, projectPath);
  return join(baseDir, "inbound-context", `${sessionId}.json`);
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

async function readStateFile(statePath: string, sessionId: SessionId): Promise<InboundContextState> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf-8");
  } catch (err) {
    if (isNodeErrorWithCode(err, "ENOENT")) {
      return createEmptyState(sessionId);
    }
    throw err;
  }

  return parseState(raw, sessionId);
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;

  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(lockPath, `${token}\n`, { encoding: "utf-8", flag: "wx" });
      try {
        return await fn();
      } finally {
        let shouldRelease = false;
        try {
          const current = (await readFile(lockPath, "utf-8")).trim();
          shouldRelease = current === token;
        } catch (err) {
          if (!isNodeErrorWithCode(err, "ENOENT")) {
            // Best effort release path follows.
          }
        }

        if (shouldRelease) {
          try {
            await unlink(lockPath);
          } catch (err) {
            if (!isNodeErrorWithCode(err, "ENOENT")) {
              // Best effort unlock.
            }
          }
        }
      }
    } catch (err) {
      if (!isNodeErrorWithCode(err, "EEXIST")) {
        throw err;
      }

      try {
        const lockStat = await stat(lockPath);
        const isStale = Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
        if (isStale) {
          try {
            await unlink(lockPath);
          } catch (unlinkErr) {
            if (!isNodeErrorWithCode(unlinkErr, "ENOENT")) {
              // Ignore and retry.
            }
          }
        }
      } catch (statErr) {
        if (!isNodeErrorWithCode(statErr, "ENOENT")) {
          throw statErr;
        }
      }

      if (attempt === LOCK_RETRY_ATTEMPTS - 1) {
        throw new Error(`Timed out acquiring lock for ${lockPath}`, { cause: err });
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Timed out acquiring lock for ${lockPath}`);
}

function toStoredEnvelope(input: EnqueueInboundEnvelopeInput): StoredInboundEnvelope {
  const id = toNonEmptyString(input.id) ?? randomUUID();
  const sessionId = toNonEmptyString(input.sessionId);
  if (!sessionId) {
    throw new Error("sessionId is required for inbound envelope");
  }

  const source = toNonEmptyString(input.source);
  if (!source) {
    throw new Error("source is required for inbound envelope");
  }

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) {
    throw new Error("text is required for inbound envelope");
  }

  if (typeof input.routing !== "object" || input.routing === null || Array.isArray(input.routing)) {
    throw new Error("routing payload must be an object");
  }

  return {
    id,
    sessionId,
    source,
    text,
    receivedAt: toNonEmptyString(input.receivedAt) ?? new Date().toISOString(),
    routing: input.routing,
  };
}

export function buildTelegramInboundRouting(payload: {
  chatId: unknown;
  messageId: unknown;
  messageThreadId?: unknown;
  projectId?: unknown;
  fromId?: unknown;
  fromUsername?: unknown;
  fromFirstName?: unknown;
  fromLastName?: unknown;
}): TelegramInboundRouting {
  const chatId = toNonEmptyString(payload.chatId);
  if (!chatId) {
    throw new Error("Telegram routing requires chatId");
  }

  const rawMessageId = toOptionalNumber(payload.messageId);
  if (rawMessageId === undefined) {
    throw new Error("Telegram routing requires messageId");
  }

  const routing: TelegramInboundRouting = {
    chatId,
    messageId: Math.trunc(rawMessageId),
  };

  const threadId = toOptionalNumber(payload.messageThreadId);
  if (threadId !== undefined) {
    routing.threadId = Math.trunc(threadId);
  }

  const projectId = toNonEmptyString(payload.projectId);
  if (projectId) {
    routing.projectId = projectId;
  }

  const fromId = toOptionalNumber(payload.fromId);
  if (fromId !== undefined) {
    routing.fromId = Math.trunc(fromId);
  }

  const username = toNonEmptyString(payload.fromUsername);
  if (username) {
    routing.fromUsername = username;
  }

  const displayName = buildDisplayName(
    typeof payload.fromFirstName === "string" ? payload.fromFirstName : undefined,
    typeof payload.fromLastName === "string" ? payload.fromLastName : undefined,
  );
  if (displayName) {
    routing.fromDisplayName = displayName;
  }

  return routing;
}

export function buildJiraInboundRouting(payload: {
  issueKey: unknown;
  commentId?: unknown;
  authorEmail?: unknown;
  authorDisplayName?: unknown;
}): JiraInboundRouting {
  const issueKey = toNonEmptyString(payload.issueKey);
  if (!issueKey) {
    throw new Error("Jira routing requires issueKey");
  }

  const routing: JiraInboundRouting = { issueKey };

  const commentId = toStringOrUndefined(payload.commentId);
  if (commentId) {
    routing.commentId = commentId;
  }

  const authorEmail = toNonEmptyString(payload.authorEmail);
  if (authorEmail) {
    routing.authorEmail = authorEmail;
  }

  const authorDisplayName = toNonEmptyString(payload.authorDisplayName);
  if (authorDisplayName) {
    routing.authorDisplayName = authorDisplayName;
  }

  return routing;
}

export function createInboundContextStore(
  config: Pick<OrchestratorConfig, "configPath" | "projects">,
): InboundContextStore {
  async function enqueue(input: EnqueueInboundEnvelopeInput): Promise<InboundEnvelope> {
    const envelope = toStoredEnvelope(input);
    const statePath = buildStatePath(config, envelope.sessionId);
    const lockPath = `${statePath}.lock`;

    return withFileLock(lockPath, async () => {
      const state = await readStateFile(statePath, envelope.sessionId);
      const dedupeKey = getDedupeKey(envelope);
      if (dedupeKey) {
        const existing = state.envelopes.find((entry) => entry.dedupeKey === dedupeKey);
        if (existing) {
          return toPublicEnvelope(existing);
        }
      }

      const stored: StoredInboundEnvelope = {
        ...envelope,
        dedupeKey: dedupeKey ?? undefined,
      };
      state.version = STATE_VERSION;
      state.sessionId = envelope.sessionId;
      state.envelopes.push(stored);
      await atomicWriteFile(statePath, serializeState(state));
      return toPublicEnvelope(stored);
    });
  }

  async function peekNext(sessionId: SessionId): Promise<InboundEnvelope | null> {
    const statePath = buildStatePath(config, sessionId);
    const state = await readStateFile(statePath, sessionId);

    const next = state.envelopes.find((entry) => !entry.ackedAt);
    return next ? toPublicEnvelope(next) : null;
  }

  async function listPending(sessionId: SessionId): Promise<InboundEnvelope[]> {
    const statePath = buildStatePath(config, sessionId);
    const state = await readStateFile(statePath, sessionId);
    return state.envelopes.filter((entry) => !entry.ackedAt).map(toPublicEnvelope);
  }

  async function ack(sessionId: SessionId, envelopeId: string): Promise<boolean> {
    const normalizedEnvelopeId = toNonEmptyString(envelopeId);
    if (!normalizedEnvelopeId) return false;

    const statePath = buildStatePath(config, sessionId);
    const lockPath = `${statePath}.lock`;

    return withFileLock(lockPath, async () => {
      const state = await readStateFile(statePath, sessionId);
      const target = state.envelopes.find((entry) => entry.id === normalizedEnvelopeId && !entry.ackedAt);
      if (!target) {
        return false;
      }

      target.ackedAt = new Date().toISOString();
      await atomicWriteFile(statePath, serializeState(state));
      return true;
    });
  }

  return {
    enqueue,
    peekNext,
    ack,
    listPending,
  };
}

export function isTelegramInboundEnvelope(envelope: InboundEnvelope): envelope is InboundEnvelope & {
  source: "telegram";
  routing: TelegramInboundRouting;
} {
  if (envelope.source !== "telegram") return false;

  const chatId = toNonEmptyString(envelope.routing["chatId"]);
  const messageId = toOptionalNumber(envelope.routing["messageId"]);
  return Boolean(chatId) && messageId !== undefined;
}

export function isJiraInboundEnvelope(envelope: InboundEnvelope): envelope is InboundEnvelope & {
  source: "jira";
  routing: JiraInboundRouting;
} {
  if (envelope.source !== "jira") return false;
  const issueKey = toNonEmptyString(envelope.routing["issueKey"]);
  return Boolean(issueKey);
}

export function getInboundContextStatePath(
  config: Pick<OrchestratorConfig, "configPath" | "projects">,
  sessionId: SessionId,
): string {
  return buildStatePath(config, sessionId);
}
