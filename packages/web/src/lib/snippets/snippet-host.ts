// Host side of one snippet panel, without DOM. `decideInvoke` and `decideSend` are
// the send-validation functions; `createSnippetHost` wires the handshake, the port,
// gates and the store bridge behind injectable deps so every rule is testable
// without a real iframe. The host picks every store: data goes to the manifest
// `store` (default `session:<owner>`), actions and agent traffic to `session:<owner>`.

import type { SnippetManifest } from "./snippet-manifest";
import {
  actionStatusFromDoc,
  isRecord,
  isTerminalSnippetStatus,
  ownerStoreOf,
  SNIPPET_BUDGET_LIMIT,
  SNIPPET_FETCH_TIMEOUT_MS,
  SNIPPET_FLOOD_MAX_MESSAGES,
  SNIPPET_FLOOD_WINDOW_MS,
  SNIPPET_HEIGHT_MAX,
  SNIPPET_HEIGHT_MIN,
  SNIPPET_HELLO_TIMEOUT_MS,
  SNIPPET_MAX_PAYLOAD_BYTES,
  SNIPPET_MAX_PORT_MESSAGE_BYTES,
  SNIPPET_MAX_STATE_BYTES,
  SNIPPET_PROTOCOL_VERSION,
  SNIPPET_RETRY_STATUSES,
  SNIPPET_SDK_URL,
  SNIPPET_TO_FRAME,
  SNIPPET_TO_HOST,
  SNIPPET_WINDOW_MSG,
  snippetByteLength,
  snippetStateDocId,
  type SnippetActionStatus,
  type SnippetAvailability,
  type SnippetConfirmReason,
  type SnippetInvokeRejection,
  type SnippetTheme,
} from "./snippet-protocol";
import {
  parseControls,
  readSnippetBudget,
  readSnippetRecord,
  writeSnippetBudget,
  writeSnippetRecord,
  type SnippetControlValue,
  type SnippetRecord,
  type SnippetStorage,
} from "./snippet-store";
import { validateSnippetPayload, type JsonValue, type SnippetSchemaIssue } from "./snippet-schema";
import { resolveStoreProxyTarget, type ProxyMethod } from "@/lib/store-proxy";
import type { StoreChangeEvent, StoreChangePoller } from "@/lib/store-change-poller";
import type { SpurSessionState } from "@/lib/types";

type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// gates

export type GateStorage =
  | { ok: true; unconfirmedRevision: number | null; unconfirmed: number }
  | { ok: false };

export interface DecideInput {
  connected: boolean;
  conflict: boolean;
  manifest: SnippetManifest;
  actionId: string;
  payload: unknown;
  canSend: boolean;
  busy: boolean;
  hasInteraction: boolean;
  gates: GateStorage;
  // Trusted host click (Retry): skips the confirm gates, still passes structure and availability.
  trusted?: boolean;
}

export type DecideResult =
  | { kind: "reject"; reason: SnippetInvokeRejection; issues?: SnippetSchemaIssue[] }
  | { kind: "confirm"; reason: SnippetConfirmReason; payload: JsonObject; label: string }
  | { kind: "send"; payload: JsonObject; label: string };

export function decideInvoke(input: DecideInput): DecideResult {
  const { manifest } = input;
  if (!input.connected) return { kind: "reject", reason: "not_connected" };
  if (input.conflict) return { kind: "reject", reason: "stale" };
  const action = manifest.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) return { kind: "reject", reason: "unknown_action" };
  if (snippetByteLength(input.payload) > SNIPPET_MAX_PAYLOAD_BYTES) {
    return { kind: "reject", reason: "payload_too_large" };
  }
  const validated = validateSnippetPayload(action.payload, input.payload);
  if (!validated.ok) return { kind: "reject", reason: "invalid_payload", issues: validated.issues };
  if (!input.canSend) return { kind: "reject", reason: "session_unavailable" };
  if (input.busy) return { kind: "reject", reason: "busy" };
  const done = { payload: validated.payload, label: action.label };
  if (input.trusted) return { kind: "send", ...done };
  const confirm = (reason: SnippetConfirmReason): DecideResult => ({
    kind: "confirm",
    reason,
    ...done,
  });
  if (action.confirm === "always") return confirm("declared");
  if (!input.hasInteraction) return confirm("no_focus");
  if (!input.gates.ok) return confirm("storage_unavailable");
  if (input.gates.unconfirmedRevision === manifest.revision) return confirm("repeat_in_revision");
  if (input.gates.unconfirmed >= SNIPPET_BUDGET_LIMIT) return confirm("budget");
  return { kind: "send", ...done };
}

export interface DecideSendInput {
  connected: boolean;
  message: unknown;
  canSend: boolean;
  confirmPending: boolean;
  hasInteraction: boolean;
  gates: GateStorage;
}

export type DecideSendResult =
  | { kind: "reject"; reason: SnippetInvokeRejection }
  | { kind: "confirm"; reason: SnippetConfirmReason; message: string }
  | { kind: "send"; message: string };

// `spur.agent.send` and `<spur-chat>`: same interaction, storage and budget gates as
// invoke, no per-revision repeat gate (a chat sends several times per revision).
export function decideSend(input: DecideSendInput): DecideSendResult {
  if (!input.connected) return { kind: "reject", reason: "not_connected" };
  const { message } = input;
  if (typeof message !== "string" || message.trim().length === 0) {
    return { kind: "reject", reason: "invalid_payload" };
  }
  if (snippetByteLength(message) > SNIPPET_MAX_PAYLOAD_BYTES) {
    return { kind: "reject", reason: "payload_too_large" };
  }
  if (!input.canSend) return { kind: "reject", reason: "session_unavailable" };
  if (input.confirmPending) return { kind: "reject", reason: "busy" };
  if (!input.hasInteraction) return { kind: "confirm", reason: "no_focus", message };
  if (!input.gates.ok) return { kind: "confirm", reason: "storage_unavailable", message };
  if (input.gates.unconfirmed >= SNIPPET_BUDGET_LIMIT) {
    return { kind: "confirm", reason: "budget", message };
  }
  return { kind: "send", message };
}

// ---------------------------------------------------------------------------
// controller

export interface SnippetPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface SnippetChannel {
  hostPort: SnippetPort;
  framePort: unknown;
}

export interface SnippetFontBuffer {
  family: "Spur Mono";
  weight: string;
  data: ArrayBuffer;
}

export interface StoreResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface SnippetHostDeps {
  sessionId: string;
  postToFrame(message: unknown, transfer: unknown[]): void;
  createChannel(): SnippetChannel;
  // JSON request against the web store proxy; network failure resolves status 0.
  request(method: ProxyMethod, url: string, body?: unknown): Promise<StoreResponse>;
  poller: StoreChangePoller;
  loadSdk(refetch: boolean): Promise<string>;
  getFonts(): SnippetFontBuffer[];
  getTheme(): SnippetTheme;
  storage: SnippetStorage;
  now(): number;
  uuid(): string;
  nonce(): string;
  // document.hasFocus() && document.activeElement === the iframe
  isFrameFocused(): boolean;
  onFullscreenRequest(open: boolean): void;
}

export type PanelRuntimeError = "hello_timeout" | "navigated" | "flood" | "protocol";
export const RELOADABLE_ERRORS: readonly PanelRuntimeError[] = [
  "hello_timeout",
  "navigated",
  "flood",
];

export interface InvokeDraft {
  id: string;
  actionId: string;
  label: string;
  payload: JsonObject;
  retryOf?: string;
}

export type PendingConfirm =
  | ({ kind: "invoke"; reason: SnippetConfirmReason } & InvokeDraft)
  | { kind: "send"; reason: SnippetConfirmReason; message: string };

export interface SnippetAction {
  id: string;
  actionId: string;
  label: string;
  payload: JsonObject;
  status: SnippetActionStatus;
  createdAt: number;
  // `_actions` doc revision last applied; null until the doc was read.
  rev: number | null;
  retryOf?: string;
  confirmReason?: SnippetConfirmReason;
  error?: string;
  result?: JsonValue;
  // POST refused before a doc existed.
  httpStatus?: number;
}

export interface SnippetHostState {
  manifest: SnippetManifest;
  html: string;
  mountKey: string;
  nonce: string;
  sdkSource: string | null;
  phase: "loading" | "connecting" | "connected" | "error";
  error: PanelRuntimeError | null;
  conflict: boolean;
  availability: SnippetAvailability;
  action: SnippetAction | null;
  confirm: PendingConfirm | null;
  height: number | null;
  fullscreen: boolean;
}

export interface SnippetSessionUpdate {
  canSend: boolean;
  state: SpurSessionState;
}

export type ApplyFileResult = "mounted" | "ignored" | "conflict" | "lower_revision";

export interface SnippetHost {
  getState(): SnippetHostState;
  subscribe(listener: () => void): () => void;
  applyFile(manifest: SnippetManifest, html: string): ApplyFileResult;
  updateSession(update: SnippetSessionUpdate): void;
  // iframe events from the React shell
  onWindowMessage(data: unknown, fromFrame: boolean): void;
  frameLoaded(): void;
  noteFrameFocus(): void;
  themeChanged(): void;
  // trusted host chrome
  confirmSend(trusted: boolean): void;
  confirmDiscard(trusted: boolean): void;
  retry(trusted: boolean): void;
  reload(trusted: boolean): void;
  setFullscreen(open: boolean): void;
  dispose(): void;
}

export function storeUrl(store: string, segments: readonly string[], search = ""): string {
  return `/api/stores/${encodeURIComponent(store)}/${segments.map(encodeURIComponent).join("/")}${search}`;
}

export function dataStoreOf(manifest: SnippetManifest): string {
  return manifest.store ?? ownerStoreOf(manifest.ownerSessionId);
}

function eventOf(action: SnippetAction): Record<string, unknown> {
  return {
    id: action.id,
    action: action.actionId,
    payload: action.payload,
    status: action.status,
    ...(action.error !== undefined ? { error: action.error } : {}),
    ...(action.result !== undefined ? { result: action.result } : {}),
  };
}

// Final invoke resolution for a terminal action, same shape as the page transport.
function resultOf(action: SnippetAction): Record<string, unknown> {
  if (action.status === "completed") return { ok: true, id: action.id, result: action.result };
  if (action.status === "timeout") return { ok: false, reason: "timeout", id: action.id };
  if (action.httpStatus !== undefined) {
    const reason: SnippetInvokeRejection =
      action.httpStatus === 400
        ? "invalid_payload"
        : action.httpStatus === 413
          ? "payload_too_large"
          : "session_unavailable";
    return { ok: false, reason };
  }
  return { ok: false, reason: "failed", id: action.id, error: action.error };
}

interface ActionDoc {
  id: string;
  rev: number;
  createdAt: string;
  data: Record<string, unknown>;
}

function parseActionDoc(value: unknown): ActionDoc | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const { id, rev, createdAt } = value;
  if (typeof id !== "string" || typeof rev !== "number" || typeof createdAt !== "string") {
    return null;
  }
  return { id, rev, createdAt, data: value.data };
}

const DB_HEADS = new Set(["docs", "query", "changes"]);
const DB_METHODS = new Set<string>(["GET", "POST", "PATCH", "DELETE"]);

// Frame db path -> decoded segments, or null when it leaves the data store's doc routes.
function parseDbPath(store: string, method: string, path: unknown): string[] | null {
  if (typeof path !== "string" || !DB_METHODS.has(method)) return null;
  let segments: string[];
  try {
    segments = path.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (!DB_HEADS.has(segments[0] ?? "")) return null;
  return resolveStoreProxyTarget(store, segments, method) === null ? null : segments;
}

export function createSnippetHost(
  deps: SnippetHostDeps,
  initial: { manifest: SnippetManifest; html: string },
): SnippetHost {
  const { sessionId } = deps;
  const ownerStore = ownerStoreOf(sessionId);
  const snippetId = initial.manifest.snippetId;
  const stateDocId = snippetStateDocId(sessionId, snippetId);
  // Handled at hello (error card); this only keeps an early rejection from going unhandled.
  stateDocId.catch(() => undefined);
  const listeners = new Set<() => void>();
  let disposed = false;
  let mountCount = 0;
  let port: SnippetPort | null = null;
  let handshaking = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let blurObserved = false;
  let loads = 0;
  let floodTimes: number[] = [];
  let canSend = true;
  let agentWorking = false;
  // Invoke promise in the frame waiting for its action's final status.
  let invokeCall: { callId: string; actionId: string } | null = null;
  // Frame call waiting on the confirm strip (invoke-result or agent reply).
  let confirmCallId: string | null = null;
  let sdkAttempt = 0;
  let previousRevision: number | null = null;
  let restoreAttempt = 0;
  let dataUnsubscribe: (() => void) | null = null;
  // Action shown before a confirm strip opened; restored on Discard.
  let actionBeforeConfirm: SnippetAction | null = null;

  let state: SnippetHostState = {
    manifest: initial.manifest,
    html: initial.html,
    mountKey: "",
    nonce: "",
    sdkSource: null,
    phase: "loading",
    error: null,
    conflict: false,
    availability: { canInvoke: true, reason: null },
    action: null,
    confirm: null,
    height: null,
    fullscreen: false,
  };

  function set(patch: Partial<SnippetHostState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function availabilityFor(conflict: boolean): SnippetAvailability {
    if (conflict) return { canInvoke: false, reason: "revision_conflict" };
    if (!canSend) return { canInvoke: false, reason: "session_unavailable" };
    return { canInvoke: true, reason: null };
  }

  function postToSnippet(message: unknown): void {
    if (state.phase === "connected" && port) port.postMessage(message);
  }

  function setAvailability(conflict: boolean): void {
    const next = availabilityFor(conflict);
    const changed =
      next.canInvoke !== state.availability.canInvoke || next.reason !== state.availability.reason;
    set({ conflict, availability: next });
    if (changed) postToSnippet({ type: SNIPPET_TO_FRAME.availability, availability: next });
  }

  // Read-modify-write on the gate record. Returns false when storage fails.
  function updateRecord(mutate: (record: SnippetRecord) => void): boolean {
    const read = readSnippetRecord(deps.storage, sessionId, snippetId);
    if (!read.ok) return false;
    const record: SnippetRecord =
      read.value && read.value.instanceId === state.manifest.instanceId
        ? read.value
        : {
            instanceId: state.manifest.instanceId,
            lastRevision: state.manifest.revision,
            unconfirmedRevision: null,
            updatedAt: deps.now(),
          };
    mutate(record);
    record.updatedAt = deps.now();
    return writeSnippetRecord(deps.storage, sessionId, snippetId, record);
  }

  function replyInvoke(callId: string, result: Record<string, unknown>): void {
    postToSnippet({ type: SNIPPET_TO_FRAME.invokeResult, callId, ...result });
  }

  function replyAgent(callId: string, response: StoreResponse): void {
    postToSnippet({ type: SNIPPET_TO_HOST.agent, callId, ...response });
  }

  function publishAction(action: SnippetAction | null): void {
    set({ action });
    if (!action) return;
    postToSnippet({ type: SNIPPET_TO_FRAME.action, action: eventOf(action) });
    if (invokeCall?.actionId === action.id && isTerminalSnippetStatus(action.status)) {
      const { callId } = invokeCall;
      invokeCall = null;
      replyInvoke(callId, resultOf(action));
    }
  }

  function applyDoc(doc: ActionDoc): void {
    const current = state.action;
    if (!current || current.id !== doc.id) return;
    if (current.rev !== null && doc.rev < current.rev) return;
    const { data } = doc;
    publishAction({
      ...current,
      status: actionStatusFromDoc(data, agentWorking),
      rev: doc.rev,
      ...(typeof data.error === "string" ? { error: data.error } : {}),
      ...(data.result !== undefined ? { result: data.result as JsonValue } : {}),
    });
  }

  async function readActionDoc(id: string): Promise<ActionDoc | null> {
    const response = await deps.request("GET", storeUrl(ownerStore, ["docs", "_actions", id]));
    return response.ok ? parseActionDoc(response.body) : null;
  }

  function refreshAction(): void {
    const current = state.action;
    if (!current || current.status === "awaiting_confirm") return;
    void readActionDoc(current.id).then((doc) => {
      if (!disposed && doc) applyDoc(doc);
    });
  }

  function onOwnerChange(event: StoreChangeEvent): void {
    const current = state.action;
    if (!current || isTerminalSnippetStatus(current.status)) return;
    if (
      event.type === "reset" ||
      event.changes.some((change) => change.collection === "_actions" && change.id === current.id)
    ) {
      refreshAction();
    }
  }

  const ownerUnsubscribe = deps.poller.subscribe(ownerStore, onOwnerChange);

  // Changes in the data store reach the frame once per collection per poll; the SDK
  // reruns every snapshot of that collection.
  function onDataChange(event: StoreChangeEvent): void {
    if (event.type === "reset") {
      postToSnippet({ type: SNIPPET_TO_FRAME.dbReset });
      return;
    }
    const last = new Map<string, unknown>();
    for (const change of event.changes) last.set(change.collection, change);
    for (const change of last.values()) postToSnippet({ type: SNIPPET_TO_FRAME.dbChange, change });
  }

  function dropDataSubscription(): void {
    dataUnsubscribe?.();
    dataUnsubscribe = null;
  }

  // Mount restore: the latest action of this snippet instance, from the owner store.
  function restoreAction(): void {
    const attempt = (restoreAttempt += 1);
    const { instanceId } = state.manifest;
    void deps
      .request("POST", storeUrl(ownerStore, ["query", "_actions"]), {
        where: [
          { field: "source.snippetId", op: "==", value: snippetId },
          { field: "source.instanceId", op: "==", value: instanceId },
        ],
        orderBy: { field: "createdAt", direction: "desc" },
        limit: 1,
      })
      .then((response) => {
        if (disposed || attempt !== restoreAttempt || state.action !== null) return;
        const docs = isRecord(response.body) ? response.body.docs : null;
        const doc = response.ok && Array.isArray(docs) ? parseActionDoc(docs[0]) : null;
        if (!doc || typeof doc.data.action !== "string") return;
        const { data } = doc;
        publishAction({
          id: doc.id,
          actionId: data.action as string,
          label: typeof data.label === "string" ? data.label : (data.action as string),
          payload: isRecord(data.payload) ? (data.payload as JsonObject) : {},
          status: actionStatusFromDoc(data, agentWorking),
          createdAt: Date.parse(doc.createdAt),
          rev: doc.rev,
          ...(typeof data.retryOf === "string" ? { retryOf: data.retryOf } : {}),
          ...(typeof data.error === "string" ? { error: data.error } : {}),
          ...(data.result !== undefined ? { result: data.result as JsonValue } : {}),
        });
      });
  }

  function closePort(): void {
    if (port) {
      port.onmessage = null;
      port.close();
      port = null;
    }
    handshaking = false;
    dropDataSubscription();
    clearTimeout(helloTimer);
  }

  function resolveConfirmCall(reason: SnippetInvokeRejection): void {
    const callId = confirmCallId;
    confirmCallId = null;
    if (callId === null || !state.confirm) return;
    if (state.confirm.kind === "invoke") replyInvoke(callId, { ok: false, reason });
    else replyAgent(callId, { ok: false, status: 0, body: { error: reason } });
  }

  // A pending confirm belongs to one document in one session state. Any change
  // that voids it resolves the snippet's call as stale and drops the strip.
  function staleConfirm(): void {
    if (!state.confirm) return;
    resolveConfirmCall("stale");
    const wasInvoke = state.confirm.kind === "invoke";
    set({ confirm: null });
    if (wasInvoke && state.action?.status === "awaiting_confirm")
      set({ action: actionBeforeConfirm });
  }

  function failInvokeCall(): void {
    if (invokeCall) replyInvoke(invokeCall.callId, { ok: false, reason: "not_connected" });
    invokeCall = null;
  }

  function fail(error: PanelRuntimeError): void {
    staleConfirm();
    failInvokeCall();
    closePort();
    // Hand the dialog back to the shell (exit path), then drop the flag.
    if (state.fullscreen) deps.onFullscreenRequest(false);
    set({ phase: "error", error, fullscreen: false });
  }

  function startHelloTimer(): void {
    clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
      if (state.phase === "connecting") fail("hello_timeout");
    }, SNIPPET_HELLO_TIMEOUT_MS);
  }

  function beginMount(refetchSdk: boolean): void {
    staleConfirm();
    invokeCall = null;
    closePort();
    mountCount += 1;
    blurObserved = false;
    loads = 0;
    floodTimes = [];
    const { manifest } = state;
    set({
      mountKey: `${manifest.instanceId}:${manifest.revision}:${mountCount}`,
      nonce: deps.nonce(),
      error: null,
      phase: state.sdkSource && !refetchSdk ? "connecting" : "loading",
      height: null,
    });
    if (state.phase === "connecting") {
      startHelloTimer();
      return;
    }
    const attempt = (sdkAttempt += 1);
    deps.loadSdk(refetchSdk).then(
      (source) => {
        if (disposed || attempt !== sdkAttempt) return;
        set({ sdkSource: source, phase: "connecting" });
        startHelloTimer();
      },
      () => {
        if (disposed || attempt !== sdkAttempt) return;
        fail("hello_timeout");
      },
    );
  }

  async function loadState(): Promise<{ app: JsonValue | null; controls: SnippetControlValue[] }> {
    const empty = { app: null, controls: [] };
    const docId = await stateDocId;
    const response = await deps.request(
      "GET",
      storeUrl(dataStoreOf(state.manifest), ["docs", "_state", docId]),
    );
    if (!response.ok || !isRecord(response.body) || !isRecord(response.body.data)) return empty;
    const { data } = response.body;
    const controls = parseControls(data.controls ?? []);
    if (data.instanceId !== state.manifest.instanceId || controls === null) return empty;
    return { app: (data.app ?? null) as JsonValue | null, controls };
  }

  function buildContext(saved: {
    app: JsonValue | null;
    controls: SnippetControlValue[];
  }): Record<string, unknown> {
    const { manifest } = state;
    const fonts = deps.getFonts();
    return {
      sessionId,
      snippetId: manifest.snippetId,
      instanceId: manifest.instanceId,
      revision: manifest.revision,
      previousRevision,
      dataStore: dataStoreOf(manifest),
      agentStore: ownerStore,
      state: saved.app,
      controls: saved.controls,
      action: state.action ? eventOf(state.action) : null,
      actions: manifest.actions.map((action) => ({ id: action.id, label: action.label })),
      theme: deps.getTheme(),
      fullscreen: state.fullscreen,
      availability: state.availability,
      ...(fonts.length > 0 ? { fonts } : {}),
    };
  }

  function recordMount(): void {
    const { manifest } = state;
    const read = readSnippetRecord(deps.storage, sessionId, snippetId);
    const stored = read.ok ? read.value : null;
    previousRevision = stored?.instanceId === manifest.instanceId ? stored.lastRevision : null;
    updateRecord((record) => void (record.lastRevision = manifest.revision));
  }

  function hasInteraction(): boolean {
    return blurObserved || deps.isFrameFocused();
  }

  function readGates(): GateStorage {
    const record = readSnippetRecord(deps.storage, sessionId, snippetId);
    const budget = readSnippetBudget(deps.storage, sessionId);
    if (!record.ok || !budget.ok) return { ok: false };
    const unconfirmedRevision =
      record.value && record.value.instanceId === state.manifest.instanceId
        ? record.value.unconfirmedRevision
        : null;
    return { ok: true, unconfirmedRevision, unconfirmed: budget.value.unconfirmed };
  }

  function isBusy(): boolean {
    return (
      state.confirm !== null ||
      (state.action !== null && !isTerminalSnippetStatus(state.action.status))
    );
  }

  function beginConfirm(confirm: PendingConfirm, callId: string | null): void {
    confirmCallId = callId;
    set({ confirm });
    if (confirm.kind !== "invoke") return;
    actionBeforeConfirm = state.action;
    publishAction({
      id: confirm.id,
      actionId: confirm.actionId,
      label: confirm.label,
      payload: confirm.payload,
      status: "awaiting_confirm",
      confirmReason: confirm.reason,
      createdAt: deps.now(),
      rev: null,
      ...(confirm.retryOf ? { retryOf: confirm.retryOf } : {}),
    });
  }

  // The unconfirmed budget (and, for invokes, the per-revision mark) is written
  // before the POST. Any write failure means the caller must confirm instead.
  function commitUnconfirmed(markRevision: boolean): boolean {
    const budget = readSnippetBudget(deps.storage, sessionId);
    if (!budget.ok) return false;
    const wroteRecord =
      !markRevision ||
      updateRecord((record) => void (record.unconfirmedRevision = state.manifest.revision));
    return (
      wroteRecord &&
      writeSnippetBudget(deps.storage, sessionId, budget.value.unconfirmed + 1, deps.now())
    );
  }

  function dispatch(
    invoke: InvokeDraft,
    callId: string | null,
    confirmReason?: SnippetConfirmReason,
  ): void {
    const { manifest } = state;
    const action: SnippetAction = {
      id: invoke.id,
      actionId: invoke.actionId,
      label: invoke.label,
      payload: invoke.payload,
      status: "submitting",
      createdAt: deps.now(),
      rev: null,
      ...(invoke.retryOf ? { retryOf: invoke.retryOf } : {}),
      ...(confirmReason ? { confirmReason } : {}),
    };
    set({ confirm: null });
    invokeCall = callId === null ? null : { callId, actionId: action.id };
    publishAction(action);
    // Only gated invokes reach this point, so every one carries the user gesture.
    void deps
      .request("POST", storeUrl(ownerStore, ["actions"]), {
        id: action.id,
        action: action.actionId,
        label: action.label,
        source: {
          kind: "snippet",
          snippetId,
          instanceId: manifest.instanceId,
          revision: manifest.revision,
        },
        payload: action.payload,
        userGesture: true,
        ...(action.retryOf ? { retryOf: action.retryOf } : {}),
      })
      .then(async (response) => {
        if (disposed || state.action?.id !== action.id) return;
        const doc = response.ok ? parseActionDoc(response.body) : await readActionDoc(action.id);
        if (disposed || state.action?.id !== action.id) return;
        if (doc) {
          applyDoc(doc);
          return;
        }
        const error = isRecord(response.body) ? response.body.error : undefined;
        publishAction({
          ...state.action,
          status: "error",
          httpStatus: response.status,
          ...(typeof error === "string" ? { error } : {}),
        });
      });
  }

  function postSend(message: string, callId: string | null): void {
    void deps
      .request("POST", storeUrl(ownerStore, ["agent", "send"]), { message, userGesture: true })
      .then((response) => {
        if (!disposed && callId !== null) replyAgent(callId, response);
      });
  }

  // Payload of a retry: from the failed `_actions` doc (new id, retryOf), or the local
  // payload when the POST never created a doc.
  async function retrySource(
    last: SnippetAction,
  ): Promise<{ actionId: string; payload: unknown; retryOf?: string } | null> {
    if (last.httpStatus !== undefined) return { actionId: last.actionId, payload: last.payload };
    const doc = await readActionDoc(last.id);
    if (!doc || doc.data.status !== "failed" || typeof doc.data.action !== "string") return null;
    return { actionId: doc.data.action, payload: doc.data.payload, retryOf: last.id };
  }

  function retryable(last: SnippetAction | null): last is SnippetAction {
    return last !== null && SNIPPET_RETRY_STATUSES.includes(last.status);
  }

  // ----- invoke from the snippet

  function startInvoke(
    callId: string,
    actionId: string,
    payload: unknown,
    retryOf: string | undefined,
  ): void {
    const decision = decideInvoke({
      connected: state.phase === "connected",
      conflict: state.conflict,
      manifest: state.manifest,
      actionId,
      payload,
      canSend,
      busy: isBusy(),
      hasInteraction: hasInteraction(),
      gates: readGates(),
    });
    if (decision.kind === "reject") {
      replyInvoke(callId, {
        ok: false,
        reason: decision.reason,
        ...(decision.issues ? { issues: decision.issues } : {}),
      });
      return;
    }
    const invoke: InvokeDraft = {
      id: deps.uuid(),
      actionId,
      label: decision.label,
      payload: decision.payload,
      ...(retryOf ? { retryOf } : {}),
    };
    if (decision.kind === "confirm") {
      beginConfirm({ kind: "invoke", reason: decision.reason, ...invoke }, callId);
      return;
    }
    if (!commitUnconfirmed(true)) {
      beginConfirm({ kind: "invoke", reason: "storage_unavailable", ...invoke }, callId);
      return;
    }
    dispatch(invoke, callId);
  }

  function handleInvoke(message: Record<string, unknown>): void {
    const { callId } = message;
    if (typeof callId !== "string") return;
    if (message.retry !== true) {
      if (typeof message.action !== "string") return;
      startInvoke(callId, message.action, message.payload, undefined);
      return;
    }
    const last = state.action;
    if (!retryable(last)) {
      replyInvoke(callId, { ok: false, reason: "stale" });
      return;
    }
    const mount = mountCount;
    void retrySource(last).then((source) => {
      if (disposed || mount !== mountCount) return;
      if (!source || state.action !== last) {
        replyInvoke(callId, { ok: false, reason: "stale" });
        return;
      }
      startInvoke(callId, source.actionId, source.payload, source.retryOf);
    });
  }

  function handleAgent(message: Record<string, unknown>): void {
    const { callId, op } = message;
    if (typeof callId !== "string") return;
    if (op === "status") {
      void deps
        .request("GET", storeUrl(ownerStore, ["agent", "status"]))
        .then((response) => replyAgent(callId, response));
      return;
    }
    if (op === "messages") {
      const { from } = message;
      const search =
        typeof from === "number" && Number.isInteger(from) && from >= 0 ? `?from=${from}` : "";
      void deps
        .request("GET", storeUrl(ownerStore, ["agent", "messages"], search))
        .then((response) => replyAgent(callId, response));
      return;
    }
    if (op !== "send") return;
    const decision = decideSend({
      connected: state.phase === "connected",
      message: message.message,
      canSend,
      confirmPending: state.confirm !== null,
      hasInteraction: hasInteraction(),
      gates: readGates(),
    });
    if (decision.kind === "reject") {
      replyAgent(callId, { ok: false, status: 0, body: { error: decision.reason } });
      return;
    }
    if (decision.kind === "confirm") {
      beginConfirm({ kind: "send", reason: decision.reason, message: decision.message }, callId);
      return;
    }
    if (!commitUnconfirmed(false)) {
      beginConfirm(
        { kind: "send", reason: "storage_unavailable", message: decision.message },
        callId,
      );
      return;
    }
    postSend(decision.message, callId);
  }

  function handleDb(message: Record<string, unknown>): void {
    const { callId, method, body } = message;
    if (typeof callId !== "string" || typeof method !== "string") return;
    const store = dataStoreOf(state.manifest);
    const segments = parseDbPath(store, method, message.path);
    if (!segments) {
      postToSnippet({
        type: SNIPPET_TO_HOST.db,
        callId,
        ok: false,
        status: 400,
        body: { error: "Store path not allowed" },
      });
      return;
    }
    void deps
      .request(method as ProxyMethod, storeUrl(store, segments), body)
      .then((response) => postToSnippet({ type: SNIPPET_TO_HOST.db, callId, ...response }));
  }

  function handleStateSet(message: Record<string, unknown>): void {
    const controls = parseControls(message.controls ?? []);
    const app = (message.app ?? null) as JsonValue | null;
    if (controls === null || snippetByteLength({ app, controls }) > SNIPPET_MAX_STATE_BYTES) return;
    const { instanceId } = state.manifest;
    const store = dataStoreOf(state.manifest);
    void stateDocId.then((docId) =>
      deps.request("POST", storeUrl(store, ["docs", "_state", docId]), {
        data: { instanceId, app, controls },
      }),
    );
  }

  function handleFullscreen(message: Record<string, unknown>): void {
    const open = message.open === true;
    const callId = typeof message.callId === "string" ? message.callId : null;
    if (open && !hasInteraction()) {
      if (callId !== null) {
        postToSnippet({
          type: SNIPPET_TO_FRAME.fullscreen,
          callId,
          granted: false,
          fullscreen: state.fullscreen,
        });
      }
      return;
    }
    deps.onFullscreenRequest(open);
    if (callId !== null) {
      postToSnippet({ type: SNIPPET_TO_FRAME.fullscreen, callId, granted: true, fullscreen: open });
    }
  }

  function onPortMessage(data: unknown): void {
    const now = deps.now();
    floodTimes = floodTimes.filter((time) => now - time < SNIPPET_FLOOD_WINDOW_MS);
    floodTimes.push(now);
    if (floodTimes.length > SNIPPET_FLOOD_MAX_MESSAGES) {
      fail("flood");
      return;
    }
    if (snippetByteLength(data) > SNIPPET_MAX_PORT_MESSAGE_BYTES) return;
    if (!isRecord(data) || typeof data.type !== "string") return;
    switch (data.type) {
      case SNIPPET_TO_HOST.invoke:
        handleInvoke(data);
        return;
      case SNIPPET_TO_HOST.db:
        handleDb(data);
        return;
      case SNIPPET_TO_HOST.dbSubscribe:
        // The frame never names a store: the subscription is always the data store.
        if (!dataUnsubscribe) {
          dataUnsubscribe = deps.poller.subscribe(dataStoreOf(state.manifest), onDataChange);
        }
        return;
      case SNIPPET_TO_HOST.dbUnsubscribe:
        dropDataSubscription();
        return;
      case SNIPPET_TO_HOST.agent:
        handleAgent(data);
        return;
      case SNIPPET_TO_HOST.stateSet:
        handleStateSet(data);
        return;
      case SNIPPET_TO_HOST.fullscreen:
        handleFullscreen(data);
        return;
      case SNIPPET_TO_HOST.resize:
        if (typeof data.height === "number" && Number.isFinite(data.height)) {
          const height = Math.min(
            SNIPPET_HEIGHT_MAX,
            Math.max(SNIPPET_HEIGHT_MIN, Math.ceil(data.height)),
          );
          if (height !== state.height) set({ height });
        }
        return;
      case SNIPPET_TO_HOST.escape:
        if (state.fullscreen) deps.onFullscreenRequest(false);
        return;
      default:
    }
  }

  function onWindowMessage(data: unknown, fromFrame: boolean): void {
    if (state.phase !== "connecting" || !fromFrame || handshaking) return;
    if (!isRecord(data) || data.type !== SNIPPET_WINDOW_MSG.hello || data.nonce !== state.nonce)
      return;
    if (data.protocolVersion !== SNIPPET_PROTOCOL_VERSION) {
      fail("protocol");
      return;
    }
    clearTimeout(helloTimer);
    handshaking = true;
    const mount = mountCount;
    const current = () => !disposed && mount === mountCount && state.phase === "connecting";
    loadState().then(
      (saved) => {
        if (!current()) return;
        handshaking = false;
        const channel = deps.createChannel();
        port = channel.hostPort;
        port.onmessage = (event) => onPortMessage(event.data);
        set({ phase: "connected" });
        deps.postToFrame({ type: SNIPPET_WINDOW_MSG.connect, context: buildContext(saved) }, [
          channel.framePort,
        ]);
      },
      // No state doc id (crypto.subtle missing outside a secure context): no connect.
      () => {
        if (!current()) return;
        handshaking = false;
        fail("protocol");
      },
    );
  }

  // ----- file changes

  function applyFile(manifest: SnippetManifest, html: string): ApplyFileResult {
    const current = state.manifest;
    if (manifest.instanceId === current.instanceId) {
      if (manifest.revision === current.revision) {
        if (html === state.html) return "ignored";
        staleConfirm();
        setAvailability(true);
        return "conflict";
      }
      if (manifest.revision < current.revision) return "lower_revision";
    }
    staleConfirm();
    // A new instance is a new snippet: its predecessor's action is not shown or retried.
    const newInstance = manifest.instanceId !== current.instanceId;
    set({
      manifest,
      html,
      conflict: false,
      availability: availabilityFor(false),
      ...(newInstance ? { action: null } : {}),
    });
    recordMount();
    beginMount(false);
    if (newInstance) restoreAction();
    return "mounted";
  }

  function updateSession(update: SnippetSessionUpdate): void {
    agentWorking = update.state === "working";
    if (canSend !== update.canSend) {
      canSend = update.canSend;
      if (!canSend) staleConfirm();
      setAvailability(state.conflict);
    }
    const { action } = state;
    if (action && (action.status === "queued" || action.status === "processing")) {
      const next = agentWorking ? "processing" : "queued";
      if (next !== action.status) publishAction({ ...action, status: next });
    }
  }

  // ----- trusted host chrome

  function confirmSend(trusted: boolean): void {
    const pending = state.confirm;
    if (!trusted || !pending) return;
    // Structural checks again at click time: the session may have stopped, the
    // document changed or the port closed while the strip was open.
    if (state.phase !== "connected" || state.conflict || !canSend) {
      staleConfirm();
      return;
    }
    writeSnippetBudget(deps.storage, sessionId, 0, deps.now());
    const callId = confirmCallId;
    confirmCallId = null;
    if (pending.kind === "invoke") {
      dispatch(pending, callId, pending.reason);
      return;
    }
    set({ confirm: null });
    postSend(pending.message, callId);
  }

  function confirmDiscard(trusted: boolean): void {
    const pending = state.confirm;
    if (!trusted || !pending) return;
    resolveConfirmCall("declined");
    set({ confirm: null });
    if (pending.kind === "invoke") set({ action: actionBeforeConfirm });
  }

  function retry(trusted: boolean): void {
    const last = state.action;
    if (!trusted || !retryable(last)) return;
    const mount = mountCount;
    void retrySource(last).then((source) => {
      if (disposed || mount !== mountCount || !source || state.action !== last) return;
      const decision = decideInvoke({
        connected: state.phase === "connected",
        conflict: state.conflict,
        manifest: state.manifest,
        actionId: source.actionId,
        payload: source.payload,
        canSend,
        busy: isBusy(),
        hasInteraction: hasInteraction(),
        gates: readGates(),
        trusted: true,
      });
      if (decision.kind !== "send") return;
      writeSnippetBudget(deps.storage, sessionId, 0, deps.now());
      dispatch(
        {
          id: deps.uuid(),
          actionId: source.actionId,
          label: decision.label,
          payload: decision.payload,
          ...(source.retryOf ? { retryOf: source.retryOf } : {}),
        },
        null,
      );
    });
  }

  function reload(trusted: boolean): void {
    if (!trusted || state.phase !== "error" || !state.error) return;
    if (!RELOADABLE_ERRORS.includes(state.error)) return;
    beginMount(state.sdkSource === null);
  }

  function setFullscreen(open: boolean): void {
    if (open === state.fullscreen) return;
    set({ fullscreen: open });
    postToSnippet({ type: SNIPPET_TO_FRAME.fullscreen, fullscreen: open });
  }

  // ----- init

  recordMount();
  beginMount(false);
  restoreAction();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    applyFile,
    updateSession,
    onWindowMessage,
    frameLoaded() {
      loads += 1;
      if (loads >= 2 && state.phase !== "error") fail("navigated");
    },
    noteFrameFocus() {
      // Only a blur observed after connect counts.
      if (state.phase === "connected") blurObserved = true;
    },
    themeChanged() {
      postToSnippet({ type: SNIPPET_TO_FRAME.theme, theme: deps.getTheme() });
    },
    confirmSend,
    confirmDiscard,
    retry,
    reload,
    setFullscreen,
    dispose() {
      staleConfirm();
      failInvokeCall();
      disposed = true;
      closePort();
      ownerUnsubscribe();
      listeners.clear();
    },
  };
}

// One SDK fetch per page. Failure or a 10 s stall rejects and clears the
// cache, so Reload refetches.
export function createSdkLoader(
  fetchText: (url: string, signal: AbortSignal) => Promise<string>,
  timeoutMs = SNIPPET_FETCH_TIMEOUT_MS,
): (refetch: boolean) => Promise<string> {
  let cached: Promise<string> | null = null;
  return (refetch) => {
    if (cached && !refetch) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const pending = fetchText(SNIPPET_SDK_URL, controller.signal).finally(() =>
      clearTimeout(timer),
    );
    const tracked = pending.catch((error: unknown) => {
      if (cached === tracked) cached = null;
      throw error;
    });
    cached = tracked;
    return tracked;
  };
}
