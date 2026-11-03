// Host side of one snippet panel, without DOM. `decideInvoke` is the single
// send-validation function (D4); `createSnippetHost` wires the handshake, the
// port, gates, persistence and the action lifecycle behind an injectable
// bridge so every rule is testable without a real iframe.

import type { ConversationMessage } from "@/lib/types";
import type { SnippetManifest } from "./snippet-manifest";
import {
  buildSnippetActionPrompt,
  classifySendOutcome,
  deriveActionStatus,
  isRecord,
  isTerminalSnippetStatus,
  parseSnippetActionPrompt,
  SNIPPET_BUDGET_LIMIT,
  SNIPPET_FLOOD_MAX_MESSAGES,
  SNIPPET_FLOOD_WINDOW_MS,
  SNIPPET_HELLO_TIMEOUT_MS,
  SNIPPET_HEIGHT_MAX,
  SNIPPET_FETCH_TIMEOUT_MS,
  SNIPPET_HEIGHT_MIN,
  SNIPPET_SDK_URL,
  SNIPPET_MAX_PAYLOAD_BYTES,
  SNIPPET_MAX_PORT_MESSAGE_BYTES,
  SNIPPET_MAX_PROMPT_BYTES,
  SNIPPET_MAX_STATE_BYTES,
  SNIPPET_PROTOCOL_VERSION,
  SNIPPET_RETRY_STATUSES,
  SNIPPET_TO_FRAME,
  SNIPPET_TO_HOST,
  SNIPPET_WINDOW_MSG,
  snippetByteLength,
  type SnippetActionEvent,
  type SnippetActionRecord,
  type SnippetAvailability,
  type SnippetConfirmReason,
  type SnippetInvokeRejection,
  type SnippetSendOutcome,
  type SnippetTheme,
} from "./snippet-protocol";
import {
  parseControls,
  readSnippetBudget,
  readSnippetRecord,
  writeSnippetBudget,
  writeSnippetRecord,
  type SnippetRecord,
  type SnippetStorage,
} from "./snippet-store";
import { validateSnippetPayload, type JsonValue, type SnippetSchemaIssue } from "./snippet-schema";

// ---------------------------------------------------------------------------
// decideInvoke

export type GateStorage =
  | { ok: true; unconfirmedRevision: number | null; unconfirmed: number }
  | { ok: false };

export interface DecideInput {
  connected: boolean;
  conflict: boolean;
  manifest: SnippetManifest;
  sessionId: string;
  actionId: string;
  payload: unknown;
  canSend: boolean;
  busy: boolean;
  hasInteraction: boolean;
  gates: GateStorage;
  requestId: string;
  retryOf?: string;
  // Trusted host click (Retry): skips the confirm gates, still passes structure, G1, G5.
  trusted?: boolean;
}

export type DecideResult =
  | { kind: "reject"; reason: SnippetInvokeRejection; issues?: SnippetSchemaIssue[] }
  | {
      kind: "confirm";
      reason: SnippetConfirmReason;
      payload: { [key: string]: JsonValue };
      prompt: string;
      label: string;
    }
  | { kind: "send"; payload: { [key: string]: JsonValue }; prompt: string; label: string };

export function decideInvoke(input: DecideInput): DecideResult {
  const { manifest } = input;
  if (!input.connected) return { kind: "reject", reason: "not_connected" };
  if (input.conflict) return { kind: "reject", reason: "revision_conflict" };
  const action = manifest.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) return { kind: "reject", reason: "unknown_action" };
  if (snippetByteLength(input.payload) > SNIPPET_MAX_PAYLOAD_BYTES) {
    return { kind: "reject", reason: "payload_too_large" };
  }
  const validated = validateSnippetPayload(action.payload, input.payload);
  if (!validated.ok) return { kind: "reject", reason: "invalid_payload", issues: validated.issues };
  const prompt = buildSnippetActionPrompt({
    requestId: input.requestId,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    sessionId: input.sessionId,
    snippetId: manifest.snippetId,
    instanceId: manifest.instanceId,
    revision: manifest.revision,
    actionId: action.id,
    label: action.label,
    payload: validated.payload,
  });
  if (snippetByteLength(prompt) > SNIPPET_MAX_PROMPT_BYTES) {
    return { kind: "reject", reason: "payload_too_large" };
  }
  if (!input.canSend) return { kind: "reject", reason: "session_unavailable" };
  if (input.busy) return { kind: "reject", reason: "busy" };
  const done = { payload: validated.payload, prompt, label: action.label };
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

export interface SnippetHostDeps {
  sessionId: string;
  postToFrame(message: unknown, transfer: unknown[]): void;
  createChannel(): SnippetChannel;
  send(prompt: string): Promise<SnippetSendOutcome>;
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

export interface PendingConfirm {
  requestId: string;
  actionId: string;
  label: string;
  reason: SnippetConfirmReason;
  payload: { [key: string]: JsonValue };
  prompt: string;
  retryOf?: string;
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
  action: SnippetActionRecord | null;
  confirm: PendingConfirm | null;
  height: number | null;
  fullscreen: boolean;
}

export interface SnippetSessionUpdate {
  canSend: boolean;
  state: Parameters<typeof deriveActionStatus>[1]["state"];
  queuedMessages: readonly string[];
  messages: readonly ConversationMessage[];
  fileSettled: boolean;
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
  // trusted host chrome
  confirmSend(trusted: boolean): void;
  confirmDiscard(trusted: boolean): void;
  retry(trusted: boolean): void;
  reload(trusted: boolean): void;
  setFullscreen(open: boolean): void;
  dispose(): void;
}

function eventOf(action: SnippetActionRecord): SnippetActionEvent {
  return {
    requestId: action.requestId,
    actionId: action.actionId,
    status: action.status,
    ...(action.confirmReason ? { confirmReason: action.confirmReason } : {}),
    ...(action.retryOf ? { retryOf: action.retryOf } : {}),
    ...(action.httpStatus !== undefined ? { httpStatus: action.httpStatus } : {}),
  };
}

export function createSnippetHost(
  deps: SnippetHostDeps,
  initial: { manifest: SnippetManifest; html: string },
): SnippetHost {
  const { sessionId } = deps;
  const listeners = new Set<() => void>();
  let disposed = false;
  let mountCount = 0;
  let port: SnippetPort | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let blurObserved = false;
  let loads = 0;
  let floodTimes: number[] = [];
  let canSend = true;
  let pendingCallId: string | null = null;
  let session: SnippetSessionUpdate | null = null;
  let sdkAttempt = 0;
  let previousRevision: number | null = null;
  // Action shown before a confirm strip opened; restored on Discard.
  let actionBeforeConfirm: SnippetActionRecord | null = null;

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

  // Read-modify-write on the snippet record. Returns false when storage fails.
  function updateRecord(mutate: (record: SnippetRecord) => void): boolean {
    const read = readSnippetRecord(deps.storage, sessionId, state.manifest.snippetId);
    if (!read.ok) return false;
    const record: SnippetRecord =
      read.value && read.value.instanceId === state.manifest.instanceId
        ? read.value
        : {
            instanceId: state.manifest.instanceId,
            lastRevision: state.manifest.revision,
            unconfirmedRevision: null,
            state: { app: null, controls: [] },
            action: null,
            updatedAt: deps.now(),
          };
    mutate(record);
    record.updatedAt = deps.now();
    return writeSnippetRecord(deps.storage, sessionId, state.manifest.snippetId, record).ok;
  }

  function publishAction(action: SnippetActionRecord | null, persist: boolean): void {
    set({ action });
    if (persist) updateRecord((record) => void (record.action = action));
    if (action) postToSnippet({ type: SNIPPET_TO_FRAME.action, action: eventOf(action) });
  }

  function closePort(): void {
    if (port) {
      port.onmessage = null;
      port.close();
      port = null;
    }
    clearTimeout(helloTimer);
  }

  function fail(error: PanelRuntimeError): void {
    closePort();
    resolvePending({ ok: false, reason: "not_connected" });
    set({ phase: "error", error });
  }

  function startHelloTimer(): void {
    clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
      if (state.phase === "connecting") fail("hello_timeout");
    }, SNIPPET_HELLO_TIMEOUT_MS);
  }

  function beginMount(refetchSdk: boolean): void {
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
        set({ phase: "error", error: "hello_timeout" });
      },
    );
  }

  function resolvePending(result: Record<string, unknown>): void {
    const callId = pendingCallId;
    pendingCallId = null;
    if (callId !== null) postToSnippet({ type: SNIPPET_TO_FRAME.invokeResult, callId, ...result });
  }

  function buildContext(): Record<string, unknown> {
    const { manifest } = state;
    const read = readSnippetRecord(deps.storage, sessionId, manifest.snippetId);
    const record = read.ok && read.value?.instanceId === manifest.instanceId ? read.value : null;
    const fonts = deps.getFonts();
    return {
      sessionId,
      snippetId: manifest.snippetId,
      instanceId: manifest.instanceId,
      revision: manifest.revision,
      previousRevision,
      state: record?.state.app ?? null,
      controls: record?.state.controls ?? [],
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
    const read = readSnippetRecord(deps.storage, sessionId, manifest.snippetId);
    const stored = read.ok ? read.value : null;
    previousRevision = stored?.instanceId === manifest.instanceId ? stored.lastRevision : null;
    updateRecord((record) => void (record.lastRevision = manifest.revision));
  }

  function hasInteraction(): boolean {
    return blurObserved || deps.isFrameFocused();
  }

  function readGates(): GateStorage {
    const record = readSnippetRecord(deps.storage, sessionId, state.manifest.snippetId);
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

  function decide(
    actionId: string,
    payload: unknown,
    retryOf: string | undefined,
    trusted: boolean,
  ): { decision: DecideResult; requestId: string } {
    const requestId = deps.uuid();
    const decision = decideInvoke({
      connected: state.phase === "connected",
      conflict: state.conflict,
      manifest: state.manifest,
      sessionId,
      actionId,
      payload,
      canSend,
      busy: isBusy(),
      hasInteraction: hasInteraction(),
      gates: readGates(),
      requestId,
      ...(retryOf ? { retryOf } : {}),
      trusted,
    });
    return { decision, requestId };
  }

  function beginConfirm(
    decision: Extract<DecideResult, { kind: "confirm" }>,
    requestId: string,
    actionId: string,
    retryOf: string | undefined,
    callId: string | null,
  ): void {
    pendingCallId = callId;
    actionBeforeConfirm = state.action;
    const confirm: PendingConfirm = {
      requestId,
      actionId,
      label: decision.label,
      reason: decision.reason,
      payload: decision.payload,
      prompt: decision.prompt,
      ...(retryOf ? { retryOf } : {}),
    };
    set({ confirm });
    publishAction(
      {
        requestId,
        actionId,
        status: "awaiting_confirm",
        confirmReason: decision.reason,
        ...(retryOf ? { retryOf } : {}),
        prompt: decision.prompt,
        instanceId: state.manifest.instanceId,
        baseRevision: state.manifest.revision,
        dispatchedAt: deps.now(),
      },
      false,
    );
  }

  // G3 and G4 are written before the POST. Any write failure means the caller
  // must confirm instead.
  function commitUnconfirmed(): boolean {
    const budget = readSnippetBudget(deps.storage, sessionId);
    if (!budget.ok) return false;
    const wroteRecord = updateRecord(
      (record) => void (record.unconfirmedRevision = state.manifest.revision),
    );
    return (
      wroteRecord &&
      writeSnippetBudget(deps.storage, sessionId, budget.value.unconfirmed + 1, deps.now())
    );
  }

  function dispatch(
    requestId: string,
    actionId: string,
    prompt: string,
    retryOf: string | undefined,
    confirmReason?: SnippetConfirmReason,
  ): void {
    const record: SnippetActionRecord = {
      requestId,
      actionId,
      status: "submitting",
      prompt,
      instanceId: state.manifest.instanceId,
      baseRevision: state.manifest.revision,
      dispatchedAt: deps.now(),
      ...(retryOf ? { retryOf } : {}),
      ...(confirmReason ? { confirmReason } : {}),
    };
    set({ confirm: null });
    publishAction(record, true);
    resolvePending({ ok: true, requestId });
    void deps.send(prompt).then(
      (outcome) => settleSend(requestId, outcome),
      () => settleSend(requestId, { kind: "failure" }),
    );
  }

  function settleSend(requestId: string, outcome: SnippetSendOutcome): void {
    const current = state.action;
    if (
      disposed ||
      !current ||
      current.requestId !== requestId ||
      current.status !== "submitting"
    ) {
      return;
    }
    const result = classifySendOutcome(outcome);
    const next: SnippetActionRecord = { ...current, status: result.status };
    if (result.status === "accepted") next.acceptedAt = deps.now();
    if ("httpStatus" in result && result.httpStatus !== undefined)
      next.httpStatus = result.httpStatus;
    publishAction(next, true);
    if (session) updateSession(session);
  }

  function updateSession(update: SnippetSessionUpdate): void {
    session = update;
    if (canSend !== update.canSend) {
      canSend = update.canSend;
      setAvailability(state.conflict);
    }
    const { action } = state;
    if (!action) return;
    const next = deriveActionStatus(
      action,
      update,
      update.messages,
      {
        instanceId: state.manifest.instanceId,
        revision: state.manifest.revision,
        ...(state.manifest.respondsToRequestId
          ? { respondsToRequestId: state.manifest.respondsToRequestId }
          : {}),
      },
      deps.now(),
    );
    if (next !== action.status) publishAction({ ...action, status: next }, true);
  }

  // ----- invoke from the snippet

  function handleInvoke(message: Record<string, unknown>): void {
    const { callId } = message;
    if (typeof callId !== "string" || typeof message.actionId !== "string") return;
    const retryOf = typeof message.retryOf === "string" ? message.retryOf : undefined;
    const reply = (result: Record<string, unknown>): void =>
      postToSnippet({ type: SNIPPET_TO_FRAME.invokeResult, callId, ...result });

    let { actionId } = message as { actionId: string };
    let payload: unknown = message.payload;
    if (retryOf !== undefined) {
      const last = state.action;
      const parsed = last ? parseSnippetActionPrompt(last.prompt) : null;
      if (
        !last ||
        !parsed ||
        last.requestId !== retryOf ||
        !SNIPPET_RETRY_STATUSES.includes(last.status)
      ) {
        reply({
          ok: false,
          reason: "invalid_payload",
          issues: [{ path: "/retryOf", code: "required" }],
        });
        return;
      }
      actionId = last.actionId;
      payload = parsed.payload;
    }
    const { decision, requestId } = decide(actionId, payload, retryOf, false);
    if (decision.kind === "reject") {
      reply({
        ok: false,
        reason: decision.reason,
        ...(decision.issues ? { issues: decision.issues } : {}),
      });
      return;
    }
    if (decision.kind === "confirm") {
      beginConfirm(decision, requestId, actionId, retryOf, callId);
      return;
    }
    if (!commitUnconfirmed()) {
      beginConfirm(
        { ...decision, kind: "confirm", reason: "storage_unavailable" },
        requestId,
        actionId,
        retryOf,
        callId,
      );
      return;
    }
    pendingCallId = callId;
    dispatch(requestId, actionId, decision.prompt, retryOf);
  }

  function handleStateSet(message: Record<string, unknown>): void {
    const { callId } = message;
    if (typeof callId !== "string") return;
    const controls = parseControls(message.controls ?? []);
    const app = (message.app ?? null) as JsonValue | null;
    const ok =
      controls !== null &&
      snippetByteLength({ app, controls }) <= SNIPPET_MAX_STATE_BYTES &&
      updateRecord((record) => {
        record.state = { app, controls };
      });
    postToSnippet({ type: SNIPPET_TO_FRAME.stateAck, callId, ok });
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
    if (state.phase !== "connecting" || !fromFrame) return;
    if (!isRecord(data) || data.type !== SNIPPET_WINDOW_MSG.hello || data.nonce !== state.nonce)
      return;
    if (data.protocolVersion !== SNIPPET_PROTOCOL_VERSION) {
      fail("protocol");
      return;
    }
    clearTimeout(helloTimer);
    const channel = deps.createChannel();
    port = channel.hostPort;
    port.onmessage = (event) => onPortMessage(event.data);
    set({ phase: "connected" });
    deps.postToFrame({ type: SNIPPET_WINDOW_MSG.connect, context: buildContext() }, [
      channel.framePort,
    ]);
  }

  // ----- file changes (D8)

  function applyFile(manifest: SnippetManifest, html: string): ApplyFileResult {
    const current = state.manifest;
    if (manifest.instanceId === current.instanceId) {
      if (manifest.revision === current.revision) {
        if (html === state.html) return "ignored";
        setAvailability(true);
        return "conflict";
      }
      if (manifest.revision < current.revision) return "lower_revision";
    }
    resolvePending({ ok: false, reason: "stale" });
    set({ confirm: null, manifest, html, conflict: false, availability: availabilityFor(false) });
    if (state.action?.status === "awaiting_confirm") set({ action: actionBeforeConfirm });
    recordMount();
    beginMount(false);
    updateSession(
      session ?? {
        canSend,
        state: "working",
        queuedMessages: [],
        messages: [],
        fileSettled: false,
      },
    );
    return "mounted";
  }

  // ----- trusted host chrome

  function confirmSend(trusted: boolean): void {
    const pending = state.confirm;
    if (!trusted || !pending) return;
    writeSnippetBudget(deps.storage, sessionId, 0, deps.now());
    dispatch(pending.requestId, pending.actionId, pending.prompt, pending.retryOf, pending.reason);
  }

  function confirmDiscard(trusted: boolean): void {
    if (!trusted || !state.confirm) return;
    resolvePending({ ok: false, reason: "declined" });
    set({ confirm: null, action: actionBeforeConfirm });
  }

  function retry(trusted: boolean): void {
    const last = state.action;
    if (!trusted || !last || !SNIPPET_RETRY_STATUSES.includes(last.status)) return;
    const parsed = parseSnippetActionPrompt(last.prompt);
    if (!parsed) return;
    const { decision, requestId } = decide(last.actionId, parsed.payload, last.requestId, true);
    if (decision.kind !== "send") return;
    writeSnippetBudget(deps.storage, sessionId, 0, deps.now());
    dispatch(requestId, last.actionId, decision.prompt, last.requestId);
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

  // ----- init: restore the last action, reload during submitting = delivery_unknown

  const restored = readSnippetRecord(deps.storage, sessionId, initial.manifest.snippetId);
  if (restored.ok && restored.value && restored.value.instanceId === initial.manifest.instanceId) {
    const { action } = restored.value;
    if (action) {
      state = {
        ...state,
        action: action.status === "submitting" ? { ...action, status: "delivery_unknown" } : action,
      };
    }
  }
  recordMount();
  if (state.action && restored.ok && restored.value?.action?.status === "submitting") {
    updateRecord((record) => void (record.action = state.action));
  }
  beginMount(false);

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
      blurObserved = true;
    },
    confirmSend,
    confirmDiscard,
    retry,
    reload,
    setFullscreen,
    dispose() {
      disposed = true;
      resolvePending({ ok: false, reason: "stale" });
      closePort();
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
