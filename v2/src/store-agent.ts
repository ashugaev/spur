import { createHash } from "node:crypto";
import { unwrapPastedContent } from "./agents/claude-submit-ack.js";
import {
  type ConversationMessageClassifier,
  projectConversationPage,
} from "./conversation-page.js";
import {
  assertPagePrefixFree,
  pageProjectId,
  readPageConfig,
  renderPageAgentPrompt,
} from "./pages.js";
import { SessionEndedError } from "./session-service.js";
import { parseActionEnvelope } from "./store-actions.js";
import { StoreClosedError, StoreError, type StoreService, parseStoreId } from "./stores.js";
import type {
  ConversationPage,
  ConversationResponse,
  KillSessionRequest,
  SendMessageRequest,
  SessionRecord,
  SessionState,
  SpawnSessionRequest,
} from "./types.js";

// The agent behind a store: `session:<sid>` -> that session; `page:<id>` -> the page
// agent, spawned lazily and recovered within a persisted budget.

export const AUTO_DELIVERY_BUDGET = 10;
export const RECOVERY_BUDGET = 3;
export const USER_FLOOD_LIMIT = 30;
export const USER_FLOOD_WINDOW_MS = 10 * 60 * 1000;
export const AGENT_MESSAGE_MAX_CHARS = 20_000;

const META_BINDING = "agent.binding";
const META_SPAWNED = "agent.spawned";
const META_AUTO = "budget.auto";
const META_RECOVER = "budget.recover";
const META_RECOVER_AT = "budget.recoverAt";
const META_USER = "budget.user";
const META_CHAT = "chat.sent";
const CHAT_SENT_CAP = 100;
const TERMINAL = new Set<SessionRecord["status"]>(["completed", "killed", "errored"]);

export type AgentStatusState =
  | "none"
  | "working"
  | "idle"
  | "recovering"
  | "error"
  | "rate_limited";
export interface AgentStatus {
  state: AgentStatusState;
  sessionId: string | null;
}

/** The slice of SessionService the store agent drives. */
export interface StoreAgentSessions {
  get(sessionId: string): Promise<{ status: SessionRecord["status"]; state: SessionState }>;
  send(sessionId: string, request: SendMessageRequest): Promise<unknown>;
  restore(sessionId: string): Promise<unknown>;
  spawnInBackground(request: SpawnSessionRequest): Promise<{ id: string }>;
  getConversation(
    sessionId: string,
    options?: { from?: number; preserveEnd?: boolean },
  ): Promise<ConversationResponse>;
  kill(sessionId: string, request?: KillSessionRequest): Promise<unknown>;
}

export interface StoreAgentHost {
  stores: StoreService;
  sessions: StoreAgentSessions;
  dataDir(): string;
  readSession(sessionId: string): Pick<SessionRecord, "id" | "project" | "status"> | null;
  /** Session prefixes of configured and unconfigured projects. */
  projectPrefixes(): string[];
  onStatus?(pageId: string, status: AgentStatus): void;
  now?(): number;
}

function chatHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseAgentMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StoreError(400, "message must be a non-empty string");
  }
  if (value.length > AGENT_MESSAGE_MAX_CHARS) {
    throw new StoreError(400, `message exceeds ${AGENT_MESSAGE_MAX_CHARS} characters`);
  }
  return value;
}

export class StoreAgent {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly recovering = new Set<string>();
  private readonly lastStatus = new Map<string, string>();

  constructor(private readonly host: StoreAgentHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  /** Runs `run` after every earlier operation on the same store. */
  private serialize<T>(storeId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(storeId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(storeId, settled);
    void settled.then(() => {
      if (this.chains.get(storeId) === settled) this.chains.delete(storeId);
    });
    return next;
  }

  /** Records a chat send for the chat view, then delivers it like any message. */
  async deliverChat(
    storeId: string,
    message: string,
    userGesture: boolean,
  ): Promise<{ sessionId: string }> {
    // Recorded after the delivery checks and before the send: a rejected send is not
    // chat, and a poll must never consume the message before it is known.
    const hash = chatHash(message);
    let added = false;
    try {
      return await this.ensureAndDeliver(storeId, message, userGesture, () =>
        this.host.stores.transactMeta(storeId, (meta) => {
          const stored = meta.get(META_CHAT);
          const known = (Array.isArray(stored) ? stored : []).filter(
            (value): value is string => typeof value === "string",
          );
          added = !known.includes(hash);
          meta.set(
            META_CHAT,
            [...known.filter((value) => value !== hash), hash].slice(-CHAT_SENT_CAP),
          );
        }),
      );
    } catch (error) {
      // A send that failed after recording is not chat. A hash recorded earlier stays.
      if (added) {
        await this.host.stores.transactMeta(storeId, (meta) => {
          const stored = meta.get(META_CHAT);
          meta.set(
            META_CHAT,
            (Array.isArray(stored) ? stored : []).filter((value) => value !== hash),
          );
        });
      }
      throw error;
    }
  }

  /** Delivers one message to the store's owner, spawning or recovering a page agent. */
  ensureAndDeliver(
    storeId: string,
    message: string,
    userGesture: boolean,
    onAccepted?: () => Promise<unknown>,
  ): Promise<{ sessionId: string }> {
    const ref = parseStoreId(storeId);
    return this.serialize(storeId, async () => {
      if (ref.kind === "session") {
        const record = this.host.readSession(ref.sessionId);
        if (!record) throw new StoreError(404, `Session not found: ${ref.sessionId}`);
        if (TERMINAL.has(record.status)) throw new StoreClosedError(storeId);
        await this.chargeDelivery(storeId, userGesture);
        await onAccepted?.();
        await this.host.sessions.send(record.id, { message, queue: true });
        return { sessionId: record.id };
      }
      return this.deliverToPage(ref.pageId, storeId, message, userGesture, onAccepted);
    });
  }

  private async chargeDelivery(storeId: string, userGesture: boolean): Promise<void> {
    const now = this.now();
    await this.host.stores.transactMeta(storeId, (meta) => {
      if (userGesture) {
        const stored = meta.get(META_USER);
        const recent = (Array.isArray(stored) ? stored : []).filter(
          (at): at is number => typeof at === "number" && now - at < USER_FLOOD_WINDOW_MS,
        );
        if (recent.length >= USER_FLOOD_LIMIT) {
          throw new StoreError(429, `More than ${USER_FLOOD_LIMIT} user messages in 10 minutes`);
        }
        meta.set(META_USER, [...recent, now]);
        // User progress resets both loop guards.
        meta.set(META_AUTO, 0);
        meta.set(META_RECOVER, 0);
        return;
      }
      const auto = count(meta.get(META_AUTO));
      if (auto >= AUTO_DELIVERY_BUDGET) {
        throw new StoreError(
          429,
          `Automated delivery budget (${AUTO_DELIVERY_BUDGET}) exhausted; a user action resets it`,
        );
      }
      meta.set(META_AUTO, auto + 1);
    });
  }

  private boundRecord(storeId: string, pageId: string, binding: unknown) {
    const sessionId =
      typeof binding === "object" && binding !== null && "sessionId" in binding
        ? (binding as { sessionId: unknown }).sessionId
        : undefined;
    if (typeof sessionId !== "string") return null;
    const record = this.host.readSession(sessionId);
    // A binding counts only for this page's own agent project.
    return record && record.project === pageProjectId(pageId) ? record : null;
  }

  private async resetOnAgentProgress(storeId: string, sessionId: string): Promise<void> {
    const [recover, recoverAt] = await Promise.all([
      this.host.stores.readMeta(storeId, META_RECOVER),
      this.host.stores.readMeta(storeId, META_RECOVER_AT),
    ]);
    if (count(recover) === 0) return;
    let conversation: ConversationResponse;
    try {
      conversation = await this.host.sessions.getConversation(sessionId, { preserveEnd: true });
    } catch {
      return;
    }
    const since = count(recoverAt);
    const replied = conversation.entries.some(
      (entry) =>
        entry.kind === "message" && entry.role === "assistant" && (entry.timestampMs ?? 0) > since,
    );
    if (replied && conversation.state !== "working") {
      await this.host.stores.transactMeta(storeId, (meta) => meta.set(META_RECOVER, 0));
    }
  }

  private async deliverToPage(
    pageId: string,
    storeId: string,
    message: string,
    userGesture: boolean,
    onAccepted?: () => Promise<unknown>,
  ): Promise<{ sessionId: string }> {
    const page = readPageConfig(this.host.dataDir(), pageId);
    await this.chargeDelivery(storeId, userGesture);
    await onAccepted?.();
    const { stores, sessions } = this.host;
    let record = this.boundRecord(storeId, pageId, await stores.readMeta(storeId, META_BINDING));
    if (record) await this.resetOnAgentProgress(storeId, record.id);

    let charged = false;
    const charge = async (): Promise<void> => {
      if (charged) return;
      charged = true;
      const now = this.now();
      try {
        await stores.transactMeta(storeId, (meta) => {
          const recover = count(meta.get(META_RECOVER));
          if (recover >= RECOVERY_BUDGET) {
            throw new StoreError(
              503,
              `Page agent recovery budget (${RECOVERY_BUDGET}) exhausted; it resets when the agent replies or the user acts`,
            );
          }
          meta.set(META_RECOVER, recover + 1);
          meta.set(META_RECOVER_AT, now);
        });
      } catch (error) {
        this.emit(pageId, { state: "error", sessionId: record?.id ?? null });
        throw error;
      }
      this.recovering.add(pageId);
      this.emit(pageId, { state: "recovering", sessionId: record?.id ?? null });
    };
    const spawnFresh = async (): Promise<string> => {
      assertPagePrefixFree(pageId, this.host.projectPrefixes());
      if ((await stores.readMeta(storeId, META_SPAWNED)) === true) await charge();
      const view = await sessions.spawnInBackground({
        project: pageProjectId(pageId),
        prompt: renderPageAgentPrompt(pageId, page),
        agent: page.agent.runtime,
        ...(page.agent.model ? { model: page.agent.model } : {}),
      });
      await stores.transactMeta(storeId, (meta) => {
        meta.set(META_BINDING, { sessionId: view.id });
        meta.set(META_SPAWNED, true);
      });
      return view.id;
    };

    try {
      let sessionId: string;
      if (!record || record.status === "completed" || record.status === "killed") {
        sessionId = await spawnFresh();
      } else if (record.status === "errored") {
        await charge();
        try {
          await sessions.restore(record.id);
          sessionId = record.id;
        } catch {
          sessionId = await spawnFresh();
        }
      } else if (record.status === "stopped" || record.status === "paused") {
        await charge();
        sessionId = record.id;
      } else if (record.status === "budget_limited") {
        sessionId = record.id;
      } else {
        const view = await sessions.get(record.id);
        if (view.state === "stopped") await charge();
        sessionId = record.id;
      }
      try {
        await sessions.send(sessionId, { message, queue: true });
      } catch (error) {
        if (!(error instanceof SessionEndedError)) throw error;
        record = null;
        sessionId = await spawnFresh();
        await sessions.send(sessionId, { message, queue: true });
      }
      return { sessionId };
    } finally {
      if (this.recovering.delete(pageId)) {
        void this.status(storeId)
          .then((status) => this.emit(pageId, status))
          .catch(() => undefined);
      }
    }
  }

  private emit(pageId: string, status: AgentStatus): void {
    const key = `${status.state}:${status.sessionId ?? ""}`;
    if (this.lastStatus.get(pageId) === key) return;
    this.lastStatus.set(pageId, key);
    this.host.onStatus?.(pageId, status);
  }

  private async ownerSessionId(storeId: string): Promise<string | null> {
    const ref = parseStoreId(storeId);
    this.host.stores.resolve(storeId, "read");
    if (ref.kind === "session") return ref.sessionId;
    readPageConfig(this.host.dataDir(), ref.pageId);
    const record = this.boundRecord(
      storeId,
      ref.pageId,
      await this.host.stores.readMeta(storeId, META_BINDING),
    );
    return record?.id ?? null;
  }

  async status(storeId: string): Promise<AgentStatus> {
    const ref = parseStoreId(storeId);
    const sessionId = await this.ownerSessionId(storeId);
    if (ref.kind === "page" && this.recovering.has(ref.pageId))
      return { state: "recovering", sessionId };
    if (sessionId === null) return { state: "none", sessionId };
    let view: { status: SessionRecord["status"]; state: SessionState };
    try {
      view = await this.host.sessions.get(sessionId);
    } catch {
      return {
        state: ref.kind === "page" ? "none" : "error",
        sessionId: ref.kind === "page" ? null : sessionId,
      };
    }
    return { state: mapAgentState(view), sessionId };
  }

  async messages(
    storeId: string,
    options: { from?: number; limit: number },
  ): Promise<(ConversationPage | { sessionId: null; messages: [] }) & { status: AgentStatus }> {
    const status = await this.status(storeId);
    if (status.sessionId === null) return { sessionId: null, messages: [], status };
    const conversation = await this.host.sessions.getConversation(status.sessionId, {
      ...(options.from !== undefined ? { from: options.from } : {}),
      preserveEnd: true,
    });
    const classify = await this.chatClassifier(storeId);
    return {
      ...projectConversationPage(conversation, status.sessionId, options.limit, classify),
      status,
    };
  }

  /** Chat view: chat sends, this store's action envelopes as their label, agent replies. */
  private async chatClassifier(storeId: string): Promise<ConversationMessageClassifier> {
    const stored = await this.host.stores.readMeta(storeId, META_CHAT);
    const sent = new Set<unknown>(Array.isArray(stored) ? stored : []);
    return ({ role, text }) => {
      if (role === "assistant") return { kind: "reply", text };
      for (const candidate of [text.trim(), unwrapPastedContent(text).trim()]) {
        const action = parseActionEnvelope(candidate);
        if (action?.store === storeId) return { kind: "action", text: action.label };
        if (sent.has(chatHash(candidate))) return { kind: "chat", text: candidate };
      }
      return null;
    };
  }

  /** Samples page agent status for open page streams; emits only on change. */
  async sample(pageIds: Iterable<string>): Promise<void> {
    for (const pageId of pageIds) {
      try {
        this.emit(pageId, await this.status(`page:${pageId}`));
      } catch {
        // Page removed between listing and sampling.
      }
    }
  }

  /** Kills the bound page agent, then runs `remove`, after every queued delivery. */
  deletePage(pageId: string, remove: () => void): Promise<void> {
    const storeId = `page:${pageId}`;
    parseStoreId(storeId);
    return this.serialize(storeId, async () => {
      const record = this.boundRecord(
        storeId,
        pageId,
        await this.host.stores.readMeta(storeId, META_BINDING),
      );
      if (record && !TERMINAL.has(record.status)) {
        await this.host.sessions.kill(record.id, { skipPrCheck: true });
      }
      remove();
      this.lastStatus.delete(pageId);
    });
  }
}

export function mapAgentState(view: {
  status: SessionRecord["status"];
  state: SessionState;
}): AgentStatusState {
  if (TERMINAL.has(view.status) || view.state === "error" || view.state === "killed")
    return "error";
  if (view.state === "working") return "working";
  if (view.state === "rate_limited" || view.status === "budget_limited") return "rate_limited";
  return "idle";
}
