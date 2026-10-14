// Shared SessionService fast-test harness: module mocks, mock handles,
// fixtures, and per-test reset/teardown. A test file must import this module
// before any other src module so the vi.mock registrations below are in place
// when those modules load. session-service.js itself is only ever loaded
// through loadSessionServiceModule(), never statically.
import type * as cryptoModule from "node:crypto";
import { randomUUID } from "node:crypto";
import type * as timersPromisesModule from "node:timers/promises";
// Exported untyped mocks are annotated `Mock`: vi.fn()'s inferred
// Mock<Procedure> names a vitest-internal type that declaration checking
// rejects (TS2742) on an exported binding.
import { type Mock, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentProcessRef,
  AgentTerminationOutcome,
  SessionAgentScan,
} from "../../src/agent-processes.js";
import type * as eventLogModule from "../../src/event-log.js";
import type * as sessionSlotsModule from "../../src/session-slots.js";
import type * as telegramSourceStateModule from "../../src/telegram-source-state.js";
import type * as interfaceConsentModule from "../../src/review-interface-consent.js";
import type * as claudeJsonlStateModule from "../../src/claude-jsonl-state.js";
import type * as jsonlLogIoModule from "../../src/jsonl-log-io.js";
import type * as agentsIndexModule from "../../src/agents/index.js";
import type * as claudeModule from "../../src/agents/claude.js";
import type * as codexModule from "../../src/agents/codex.js";
import type * as openCodeModule from "../../src/agents/opencode.js";
import type * as ghModule from "../../src/gh.js";
import type * as registryModule from "../../src/registry.js";
import type * as sessionPrModule from "../../src/session-pr.js";
import type * as releasesCacheModule from "../../src/releases-cache.js";
import type * as sessionMemoryModule from "../../src/session-memory.js";
import type * as sharedMemoryModule from "../../src/shared-memory.js";
import type * as todoModule from "../../src/todo.js";
import type * as reapModule from "../../src/sidecars/reap.js";
import type * as runtimeTmuxModule from "../../src/runtime-tmux.js";
import type { ProcSnapshot } from "../../src/sidecars/reap.js";
import type { ListenerSnapshot } from "../../src/port-probe.js";
import type {
  ServiceInstanceRecord,
  SessionRecord,
  SessionState,
  SessionView,
} from "../../src/types.js";
// Type-only, so it never bypasses the mocked module registry below.
import type * as sessionServiceModule from "../../src/session-service.js";
import type { AgentSendOutcome } from "../../src/session-service.js";

type IsHostPortFree = (port: number) => Promise<boolean>;
type ClearPortListener = (port: number) => Promise<void>;
type HasEstablishedConnections = (port: number) => Promise<"established" | "none" | "unknown">;
type SnapshotProcesses = () => Promise<ProcSnapshot>;

const upsertConfigRegistryPathMock: Mock = vi.fn();
const addUnconfiguredProjectMock: Mock = vi.fn();
const removeUnconfiguredProjectMock: Mock = vi.fn();
const readConfigRegistryFileMock: Mock = vi.fn();
const mutateConfigRegistryMock: Mock = vi.fn();
const invalidateRemovedRegistryPathsMock: Mock = vi.fn();
const buildAgentLaunchPlanMock: Mock = vi.fn();
const buildAgentRestorePlanMock: Mock = vi.fn();
const buildAgentResumePlanMock: Mock = vi.fn();
const findAgentSessionIdMock: Mock = vi.fn();
const readAgentConversationMock: Mock = vi.fn();
const agentProcessMatchersMock: Mock = vi.fn();
const agentLaunchUsesForeignBinaryMock: Mock = vi.fn();
const agentBusyQueuedSendAwaitsPromptMock: Mock = vi.fn();
const agentInterruptKeysMock: Mock = vi.fn();
const agentQueuedSendPromptGraceMsMock: Mock = vi.fn();
const agentSessionConfigMock: Mock = vi.fn();
const agentStateStrategyMock: Mock = vi.fn();
const agentWaitsForSubmitAckMock: Mock = vi.fn();
const agentSubmitAckPacingMock: Mock = vi.fn();
const agentEarlySubmitResendAllowedMock: Mock = vi.fn();
const agentHasLaunchSubmitAckMock: Mock = vi.fn();
const createAgentSubmitAckBindingMock: Mock = vi.fn();
const resumeAgentSubmitAckBindingMock: Mock = vi.fn();
const invalidateAgentStateMock: Mock = vi.fn();
const parseAgentNameMock = vi.fn((agent: string) => agent);
const setupAgentHooksMock: Mock = vi.fn();
const captureOpenCodeSessionBaselineMock: Mock = vi.fn();
const resolveNewOpenCodeSessionIdMock: Mock = vi.fn();
const waitForOpenCodeLaunchMessageMock: Mock = vi.fn();
const withOpenCodeLaunchIdentityLockMock: Mock = vi.fn();
const readOpenCodeStateMock: Mock = vi.fn();
const readOpenCodeStructuredStateMock: Mock = vi.fn();
const resolveCursorLaunchModelMock = vi.fn(
  async (model: string | undefined): Promise<string | undefined> => model,
);
const validateOpenCodeModelMock = vi.fn(async (model: string): Promise<string> => model);
const resolveAgentReasoningEffortMock: Mock = vi.fn();
const deleteAgentHookStateMock: Mock = vi.fn();
const readAgentHookStateMock: Mock = vi.fn();
const loadConfigMock: Mock = vi.fn();
const loadProjectConfigMock: Mock = vi.fn();
const findProjectConfigPathInDirectoryMock: Mock = vi.fn();
// Only reached by the auto-update wiring tests (issue #754): every other
// test's fake-timer advances never reach REAP_INTERVAL_MS, so these mocks
// are never invoked by them (see session-service.test.ts's own timer-advance
// ceiling of 1_000ms).
const loadInstanceConfigReadOnlyMock: Mock = vi.fn();
const startDeploySwitchMock: Mock = vi.fn();
const getReleasesMock: Mock = vi.fn();
const getVersionMock: Mock = vi.fn();
const reserveNextSessionIdMock: Mock = vi.fn();
const listSessionsMock: Mock = vi.fn();
const archiveSessionsMock = vi.fn(() => ({ archivedIds: [], archiveDir: "/tmp/sessions-archive" }));
const readAvailableBacklogItemsMock: Mock = vi.fn();
const readSessionMock: Mock = vi.fn();
const writeSessionMock: Mock = vi.fn();
const requestGitHubMergeConflictRestoreReplayMock: Mock = vi.fn();
const clearGitHubPollDisabledSessionMock: Mock = vi.fn();
const listGitHubPollDisabledSourceIdsMock: Mock = vi.fn();
const deleteServiceInstanceMock: Mock = vi.fn();
const deleteServiceInstancesForSessionMock: Mock = vi.fn();
const deleteRuntimeLogCursorsForSessionMock: Mock = vi.fn();
const deleteServiceSourceStatesForServiceMock: Mock = vi.fn();
const deleteServiceSourceStatesForSessionMock: Mock = vi.fn();
const deleteTelegramSourceStateForSessionMock: Mock = vi.fn();
const deleteTelegramReplyTargetMock: Mock = vi.fn();
const hasPendingTelegramSendMock: Mock = vi.fn();
const listActiveServiceProblemsMock: Mock = vi.fn();
const listServiceInstancesMock: Mock = vi.fn();
const listServiceInstancesForSessionMock: Mock = vi.fn();
const readServiceInstanceMock: Mock = vi.fn();
const writeServiceInstanceMock: Mock = vi.fn();
const serviceRecords = new Map<string, ServiceInstanceRecord>();
const captureTmuxPaneMock = vi.fn((): Promise<string | null> => Promise.resolve(""));
const captureTmuxPaneOrEmptyMock = vi.fn(() => Promise.resolve(""));
const createTmuxSessionMock: Mock = vi.fn();
const createTmuxCommandSessionMock: Mock = vi.fn();
const createTmuxSidecarSessionMock: Mock = vi.fn();
const sweepLeakedPlaywrightMock: Mock = vi.fn();
const waitForPlaywrightReadyMock: Mock = vi.fn();
const resolvePlaywrightSidecarCommandMock = vi.fn<() => string | undefined>();
const isHostPortFreeMock = vi.fn<IsHostPortFree>().mockResolvedValue(true);
const clearPortListenerMock = vi.fn<ClearPortListener>().mockResolvedValue(undefined);
const readFreeKbMock = vi.fn<(path: string, timeoutMs?: number) => Promise<number | undefined>>();
const readDiskBudgetReportMock: Mock = vi.fn();
const measureDiskBudgetMock: Mock = vi.fn();
const realDuMock: Mock = vi.fn();
// Default "none": most tests declare no sidecar ports at all, and this must
// never silently default to "unknown" (which would mask a real assertion
// that a probe failure keeps rather than reaps) or "established" (which
// would mask the opposite).
const hasEstablishedConnectionsMock = vi.fn<HasEstablishedConnections>().mockResolvedValue("none");
// Default: no listener on any port — `stopSidecarLocked`'s recorded-port
// term (spur#859 B1) calls this unconditionally on every stop, and most
// fixtures here declare no `sidecarPorts` at all (recordedPorts === []), so
// this never actually runs in those tests; the handful that DO set
// sidecarPorts override it per test.
const findListenerPidsMock = vi.fn<(port: number) => Promise<number[]>>().mockResolvedValue([]);
const snapshotListenersMock = vi
  .fn<() => Promise<ListenerSnapshot>>()
  .mockResolvedValue({ ok: false });
// Default: no real `ps` fork in the fast tier. A real subprocess spawn here
// (the pre-fix default) is slow and non-fake-timer-bound, and every
// SessionService construction fires one unawaited via the attention
// monitor's immediate baseline pass — under a 700+ test file that leaves a
// window for one test's still-in-flight fork to resolve during a later
// test's turn and write through that later test's own session-store mock.
// Tests that need a specific pid to resolve set this explicitly.
const snapshotProcessesMock = vi
  .fn<SnapshotProcesses>()
  .mockResolvedValue({ ok: true, byPid: new Map(), byPgid: new Map() });
const sidecarTmuxAliveMock: Mock = vi.fn();
const refreshTmuxFleetSnapshotMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const sidecarTmuxSessionMock = vi.fn((id: string, name: string) => `${id}--${name}`);
const listTmuxSessionNamesMock = vi.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set());
const getTmuxSessionActivityMock: Mock = vi.fn();
const getTmuxPanePidMock = vi.fn(() => Promise.resolve<number | null>(null));
const lookupTmuxPanePidMock = vi.fn((_sessionName?: string, _options?: { fresh?: boolean }) =>
  Promise.resolve<{ status: "ok"; panePid: number | null } | { status: "unavailable" }>({
    status: "ok",
    panePid: null,
  }),
);
const getFleetSessionRssBytesMock = vi
  .fn<(liveSessionByWorkspaceId?: ReadonlyMap<string, string>) => Promise<Map<string, number>>>()
  .mockResolvedValue(new Map());
const readHostMemoryMock = vi.fn<
  () => {
    totalBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
  } | null
>();
const readCgroupPressureMock: Mock = vi.fn();
const readCgroupMemorySnapshotMock: Mock = vi.fn();
const isSystemdOomdPresentMock: Mock = vi.fn();
const isProcessRunningInTmuxMock: Mock = vi.fn();
// Defaults to delegating to isProcessRunningInTmuxMock (see beforeEach) so
// every existing isProcessRunningInTmuxMock-driven test keeps controlling
// probeAgentProcess's single probeTmuxProcessMatch call unchanged. A test
// that needs to express a genuine matcher/pane_child disagreement (alive
// true, matchedByName false) overrides this mock directly instead — a plain
// boolean delegate cannot produce that shape.
const probeTmuxProcessMatchMock = vi.fn<
  (
    sessionName: string,
    matchers: string[],
    options?: { fresh?: boolean; paneChildFallback?: boolean },
  ) => Promise<{
    alive: boolean;
    matchedByName: boolean;
    unresponsive: boolean;
    diagnostic?: string;
  }>
>();
const killTmuxSessionMock: Mock = vi.fn();
const captureAgentProcessesForLaunchMock = vi.fn(() =>
  Promise.resolve<{ status: "ok"; processes: AgentProcessRef[] } | { status: "unavailable" }>({
    status: "ok",
    processes: [],
  }),
);
const capturePaneAgentProcessesMock = vi.fn(() =>
  Promise.resolve<{ status: "ok"; processes: AgentProcessRef[] } | { status: "unavailable" }>({
    status: "ok",
    processes: [],
  }),
);
const terminateAgentProcessesMock = vi.fn<
  (processes: readonly AgentProcessRef[]) => Promise<AgentTerminationOutcome>
>(() => Promise.resolve({ status: "clear" }));
// "unavailable" is the safe default: it is what a real host without a
// readable process environment (e.g. macOS, or a CI sandbox without procfs)
// returns, and matches the P2 guard's own never-blocks-on-what-it-cannot-see
// contract, so no unrelated restore/relaunch/switchAuth test below has to
// know this guard exists.
const findForeignAgentProcessesForSessionMock = vi.fn(() =>
  Promise.resolve<SessionAgentScan>({ status: "unavailable" }),
);
const killTmuxSessionTreeMock: Mock = vi.fn();
const sendMessageToTmuxMock: Mock = vi.fn();
const sendInterruptKeysToTmuxMock: Mock = vi.fn();
const sendSensitiveMessageToTmuxMock: Mock = vi.fn();
const sendSubmitKeyToTmuxMock: Mock = vi.fn();
const sendMenuSelectionKeysMock: Mock = vi.fn();
const setTmuxSocketNameMock: Mock = vi.fn();
const tmuxPaneDeadMock: Mock = vi.fn();
const tmuxSessionExistsMock: Mock = vi.fn();
// Default implementations delegate to tmuxSessionExistsMock/tmuxPaneDeadMock
// so every existing call site that drives readRuntimeSnapshot's behavior
// through those two mocks keeps working unchanged; `unresponsive` defaults to
// false and is overridden per-test only where a timeout-kill scenario is
// exercised (see the probe_unresponsive/AC9/AC10 tests).
// Forwards `options` only when the caller actually passed it, matching the
// arity of every existing direct tmuxSessionExists/tmuxPaneDead call site so
// mock.calls assertions written against those two mocks don't have to change.
const getTmuxSessionPresenceMock = vi.fn(
  async (
    name: string,
    options?: { fresh?: boolean },
  ): Promise<{ present: boolean; unresponsive: boolean; diagnostic?: string }> => ({
    present: await (options ? tmuxSessionExistsMock(name, options) : tmuxSessionExistsMock(name)),
    unresponsive: false,
  }),
);
const getTmuxPanePresenceMock = vi.fn(
  async (
    name: string,
    options?: { fresh?: boolean },
  ): Promise<{ dead: boolean; unresponsive: boolean; diagnostic?: string }> => ({
    dead: await (options ? tmuxPaneDeadMock(name, options) : tmuxPaneDeadMock(name)),
    unresponsive: false,
  }),
);
// Same delegation for the sidecar-name composition: existing sidecar-start
// tests keep driving this call site through sidecarTmuxAliveMock.
const getSidecarTmuxPresenceMock = vi.fn(
  async (
    sessionId: string,
    sidecarName: string,
  ): Promise<{ present: boolean; unresponsive: boolean; diagnostic?: string }> => ({
    present: await sidecarTmuxAliveMock(sessionId, sidecarName),
    unresponsive: false,
  }),
);
const waitForTmuxReadyMock: Mock = vi.fn();
const createWorktreeMock: Mock = vi.fn();
const findWorktreePathForBranchMock: Mock = vi.fn();
const hasUncommittedChangesMock: Mock = vi.fn();
const isGitWorktreeMock: Mock = vi.fn();
const hasUnpushedCommitsMock: Mock = vi.fn();
const readCurrentBranchMock: Mock = vi.fn();
const readRemoteUrlsMock: Mock = vi.fn();
const removeWorktreeMock: Mock = vi.fn();
const pruneRepoWorktreesMock: Mock = vi.fn();
const resolveRepoPathFromWorktreeMock: Mock = vi.fn();
const branchRefsExistMock: Mock = vi.fn();
const workspaceExistsMock: Mock = vi.fn();
const probeWorkspaceMock: Mock = vi.fn();
const applySlotsUpdateMock: Mock = vi.fn();
const normalizeSlotLinksMock: Mock = vi.fn();
const applySlotsUpdateWithResultMock: Mock = vi.fn();
const applyNormalizedSlotsUpdateMock: Mock = vi.fn();
const ensureSessionSlotToolMock: Mock = vi.fn();
const removeSessionSlotToolMock: Mock = vi.fn();
const withSessionSlotInstructionsMock: Mock = vi.fn();
const deleteSessionArtifactsExceptMock: Mock = vi.fn();
const deleteSessionArtifactByIdMock: Mock = vi.fn();
const listSessionArtifactsMock: Mock = vi.fn();
const readSessionArtifactMock: Mock = vi.fn();
const setSessionArtifactOriginMock: Mock = vi.fn();
const setSessionArtifactUserAddedMock: Mock = vi.fn();
const listSessionMemoryRecordsMock: Mock = vi.fn();
const getSessionMemoryRecordMock: Mock = vi.fn();
const setSessionMemoryRecordMock: Mock = vi.fn();
const resolveSessionMemoryRecordMock: Mock = vi.fn();
const listSharedMemoryKeysMock: Mock = vi.fn();
const getSharedMemoryMock: Mock = vi.fn();
const setSharedMemoryMock: Mock = vi.fn();
const removeSharedMemoryMock: Mock = vi.fn();
const withSharedMemoryInstructionsMock: Mock = vi.fn();
const runSpawnPreflightMock: Mock = vi.fn();
class MockPreflightBranchValidationError extends Error {
  constructor(
    readonly branch: string,
    regex: string,
  ) {
    super(`preflight branch "${branch}" must match ${regex}`);
    this.name = "PreflightBranchValidationError";
  }
}
const logSpurEventMock: Mock = vi.fn();
const flushEventLogCollapseMock: Mock = vi.fn();
const tryRotateMock: Mock = vi.fn();
const readClaudeJsonlStateMock: Mock = vi.fn();
const readClaudeConversationTailMock: Mock = vi.fn();
const readClaudeSessionStatusMock: Mock = vi.fn();
const listAccountsMock: Mock = vi.fn();
const findAccountMock: Mock = vi.fn();
const isAccountAuthenticatedMock: Mock = vi.fn();
const isAccountReadyMock: Mock = vi.fn();
const addAccountMock: Mock = vi.fn();
const removeAccountMock: Mock = vi.fn();
const touchAccountUsedMock: Mock = vi.fn();
const ensureDefaultAccountMock: Mock = vi.fn();
const seedSessionHomeMock: Mock = vi.fn();
const swapSessionCredentialsMock: Mock = vi.fn();

interface TestAccount {
  id: string;
  label?: string;
  configDir: string;
  createdAt: string;
  lastUsedAt?: string;
  authenticated: boolean;
}
// The account list is owned by the calling test file and read through
// `accounts` on every call, so a test reassigning its own list is seen here.
function resetAccountStoreMocks(accounts: () => TestAccount[]): void {
  listAccountsMock.mockReset().mockImplementation(() => accounts());
  findAccountMock
    .mockReset()
    .mockImplementation((_dataDir: string, id: string) => accounts().find((a) => a.id === id));
  isAccountAuthenticatedMock
    .mockReset()
    .mockImplementation((account: TestAccount) => account.authenticated);
  isAccountReadyMock
    .mockReset()
    .mockImplementation((account: TestAccount) => account.authenticated);
  touchAccountUsedMock.mockReset().mockImplementation((_dataDir: string, id: string) => {
    const account = accounts().find((a) => a.id === id);
    if (account) account.lastUsedAt = "2026-03-18T10:05:00.000Z";
  });
  addAccountMock.mockReset();
  removeAccountMock.mockReset();
  ensureDefaultAccountMock.mockReset();
  seedSessionHomeMock.mockReset();
  swapSessionCredentialsMock.mockReset();
}
const readCursorJsonlStateMock: Mock = vi.fn();
const readCursorTokenUsageMock: Mock = vi.fn();
const configureCursorTurnEndedStoreMock: Mock = vi.fn();
const sendDesktopNotificationMock: Mock = vi.fn();
const findLatestClaudeSessionFileMock: Mock = vi.fn();
const codexHookHomePathMock = vi.fn((sessionToolDir: string) => `${sessionToolDir}/codex-home`);
const captureCodexRolloutBaselineMock: Mock = vi.fn();
const findLatestCodexSessionFileMock: Mock = vi.fn();
const readCodexRolloutStateMock: Mock = vi.fn();
const scanCodexRolloutForMessageMock: Mock = vi.fn();
const ghMock: Mock = vi.fn();
const TEST_ARTIFACTS_ROOT = resolve(`/tmp/spur-session-artifacts-test-${process.pid}`);
const artifactDirForSession = (sessionId: string) => resolve(TEST_ARTIFACTS_ROOT, sessionId);
let TEST_DATA_DIR = resolve(`/tmp/spur-session-service-test-${process.pid}`);

const writeTelegramOfferMock: Mock = vi.fn();
const readInterfaceConsentMock: Mock = vi.fn();
const writeInterfaceConsentMock: Mock = vi.fn();
const consentPolicyMock: Mock = vi.fn();
const consentRepositoryMock: Mock = vi.fn();
const readTelegramBindingsMock: Mock = vi.fn();
const readTelegramReplyTargetMock: Mock = vi.fn();
const sendTelegramReplyMock: Mock = vi.fn();
const sendTelegramChatActionMock: Mock = vi.fn();
const editTelegramTopicMock: Mock = vi.fn();
const closeTelegramTopicMock: Mock = vi.fn();
const writeTelegramBindingsMock: Mock = vi.fn();
const writeTelegramReplyTargetMock: Mock = vi.fn();
const recordTelegramMessagesMock: Mock = vi.fn();
const activeSessionServices: Array<{
  settleBackgroundSpawns(): Promise<void>;
  dispose(): void;
}> = [];
const timerPromisesSleepMock = vi.fn<(ms: number) => Promise<void>>();

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof timersPromisesModule>();
  return {
    ...actual,
    setTimeout: timerPromisesSleepMock,
  };
});

function mockTimerPromisesSleepWithFakeTimers() {
  timerPromisesSleepMock.mockReset().mockImplementation(async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

vi.mock("../../src/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof registryModule>();
  return {
    ...actual,
    ConfigRegistryScanner: class {
      canonicalizePath(configPath: string): string {
        return resolve(configPath);
      }

      scan(options: { bootstrapConfigPath: string | undefined; configPaths: string[] }) {
        const merged = actual.buildMergedConfig(options.bootstrapConfigPath, options.configPaths, {
          skipInvalid: true,
        });
        return { ...merged, newDiagnostics: [] };
      }

      invalidateRemovedPaths(previousPaths: string[], nextPaths: string[]): void {
        invalidateRemovedRegistryPathsMock(previousPaths, nextPaths);
      }
    },
    upsertConfigRegistryPath: upsertConfigRegistryPathMock,
    addUnconfiguredProject: addUnconfiguredProjectMock,
    removeUnconfiguredProject: removeUnconfiguredProjectMock,
    readConfigRegistryFile: readConfigRegistryFileMock,
    mutateConfigRegistry: mutateConfigRegistryMock,
  };
});

vi.mock("../../src/claude-jsonl-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof claudeJsonlStateModule>()),
  CONVERSATION_PAGE_ENTRIES: 100,
  readClaudeJsonlState: readClaudeJsonlStateMock,
  readClaudeConversationTail: readClaudeConversationTailMock,
}));

vi.mock("../../src/claude-session-status.js", () => ({
  readClaudeSessionStatus: readClaudeSessionStatusMock,
}));

vi.mock("../../src/claude-accounts.js", () => ({
  listAccounts: listAccountsMock,
  findAccount: findAccountMock,
  isAccountAuthenticated: isAccountAuthenticatedMock,
  isAccountReady: isAccountReadyMock,
  addAccount: addAccountMock,
  removeAccount: removeAccountMock,
  touchAccountUsed: touchAccountUsedMock,
  ensureDefaultAccount: ensureDefaultAccountMock,
  seedSessionHome: seedSessionHomeMock,
  swapSessionCredentials: swapSessionCredentialsMock,
  sessionClaudeHome: (sessionToolDir: string) => `${sessionToolDir}/claude-home`,
}));

vi.mock("../../src/cursor-jsonl-state.js", () => ({
  captureCursorRestoreBoundary: vi.fn().mockResolvedValue(null),
  readCursorJsonlState: readCursorJsonlStateMock,
  configureCursorTurnEndedStore: configureCursorTurnEndedStoreMock,
  resolveCursorBuild: () => "test-build",
}));
vi.mock("../../src/cursor-token-usage.js", () => ({
  readCursorTokenUsage: readCursorTokenUsageMock,
}));

vi.mock("../../src/agents/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof claudeModule>();
  return {
    ...actual,
    findLatestSessionFile: findLatestClaudeSessionFileMock,
    DEFAULT_CLAUDE_MODEL: "opus",
  };
});

vi.mock("../../src/agents/opencode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof openCodeModule>();
  return {
    ...actual,
    captureOpenCodeSessionBaseline: captureOpenCodeSessionBaselineMock,
    resolveNewOpenCodeSessionId: resolveNewOpenCodeSessionIdMock,
    waitForOpenCodeLaunchMessage: waitForOpenCodeLaunchMessageMock,
    withOpenCodeLaunchIdentityLock: withOpenCodeLaunchIdentityLockMock,
    readOpenCodeState: readOpenCodeStateMock,
    readOpenCodeStructuredState: readOpenCodeStructuredStateMock,
  };
});

const PINNED_CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000000";
let nextUuid = 1;
function fixtureUuid(): ReturnType<typeof randomUUID> {
  return `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, "0")}`;
}
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof cryptoModule>();
  return {
    ...actual,
    randomUUID: vi.fn(fixtureUuid),
  };
});

// Partial mock: unlisted exports (DEFERRED_CONTROLS_ACK_WINDOW_MS and every
// other constant) stay the real values from agents/index.ts, so a test
// asserting one checks the source constant, not a test literal.
vi.mock("../../src/agents/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof agentsIndexModule>()),
  buildAgentLaunchPlan: buildAgentLaunchPlanMock,
  buildAgentRestorePlan: buildAgentRestorePlanMock,
  buildAgentResumePlan: buildAgentResumePlanMock,
  findAgentSessionId: findAgentSessionIdMock,
  readAgentConversation: readAgentConversationMock,
  agentProcessMatchers: agentProcessMatchersMock,
  agentLaunchUsesForeignBinary: agentLaunchUsesForeignBinaryMock,
  agentBusyQueuedSendAwaitsPrompt: agentBusyQueuedSendAwaitsPromptMock,
  agentInterruptKeys: agentInterruptKeysMock,
  agentQueuedSendPromptGraceMs: agentQueuedSendPromptGraceMsMock,
  agentSessionConfig: agentSessionConfigMock,
  agentStateStrategy: agentStateStrategyMock,
  agentWaitsForSubmitAck: agentWaitsForSubmitAckMock,
  agentSubmitAckPacing: agentSubmitAckPacingMock,
  agentEarlySubmitResendAllowed: agentEarlySubmitResendAllowedMock,
  agentHasLaunchSubmitAck: agentHasLaunchSubmitAckMock,
  createAgentSubmitAckBinding: createAgentSubmitAckBindingMock,
  resumeAgentSubmitAckBinding: resumeAgentSubmitAckBindingMock,
  invalidateAgentState: invalidateAgentStateMock,
  parseAgentName: parseAgentNameMock,
  setupAgentHooks: setupAgentHooksMock,
}));

vi.mock("../../src/config.js", () => ({
  buildSidecarLinkUrl: (template: string, reservedPort: number) =>
    template.includes("{port}")
      ? template.replaceAll("{port}", String(reservedPort))
      : `${template}:${reservedPort}`,
  loadConfig: loadConfigMock,
  loadProjectConfig: loadProjectConfigMock,
  validateWebhookSourceBindings: () => undefined,
  findProjectConfigPathInDirectory: findProjectConfigPathInDirectoryMock,
  loadInstanceConfigReadOnly: loadInstanceConfigReadOnlyMock,
  expandHome: (value: string) => (value.startsWith("~/") ? join(homedir(), value.slice(2)) : value),
  PROJECT_ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  DEFAULT_PROJECT_CONFIG_FILES: ["spur.yaml", "spur.yml"] as const,
  deriveProjectIdFromDisplayName: (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "") || "project",
}));

vi.mock("../../src/preflight.js", () => ({
  PreflightBranchValidationError: MockPreflightBranchValidationError,
  runSpawnPreflight: runSpawnPreflightMock,
}));

// Only exercised by the auto-update wiring tests (issue #754): keeps the
// real `startDeploySwitch` (which would spawn a real bash helper) and the
// real `getReleases` (which would hit the npm registry) out of every other
// test.
vi.mock("../../src/deploy-switch.js", () => ({
  startDeploySwitch: startDeploySwitchMock,
}));

vi.mock("../../src/releases-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof releasesCacheModule>();
  return { ...actual, getReleases: getReleasesMock };
});

// Only exercised by the auto-update wiring tests (issue #754): the real
// getVersion() resolves through git-describe / package.json state that
// differs between a local worktree and a CI checkout (shallow clone with no
// tags, the managed-placeholder package.json version, etc.) — an ambient,
// non-deterministic input the "strictly newer" comparison must not depend
// on for a test that has to prove one specific outcome.
vi.mock("../../src/version.js", () => ({
  getVersion: getVersionMock,
}));

vi.mock("../../src/event-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof eventLogModule>();
  return {
    ...actual,
    logSpurEvent: logSpurEventMock,
    logUserInputEvent: (dataDir: string, input: Parameters<typeof actual.logUserInputEvent>[1]) => {
      const entry = actual.buildUserInputLogEntry(input);
      if (entry) logSpurEventMock(dataDir, entry);
    },
    flushEventLogCollapse: flushEventLogCollapseMock,
  };
});

vi.mock("../../src/jsonl-log-io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof jsonlLogIoModule>();
  return {
    ...actual,
    tryRotate: tryRotateMock,
  };
});

vi.mock("../../src/desktop-notify.js", () => ({
  sendDesktopNotification: sendDesktopNotificationMock,
}));

vi.mock("../../src/telegram-source-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof telegramSourceStateModule>()),
  sendTelegramReply: sendTelegramReplyMock,
  sendTelegramChatAction: sendTelegramChatActionMock,
  editTelegramTopic: editTelegramTopicMock,
  closeTelegramTopic: closeTelegramTopicMock,
}));

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));

vi.mock("../../src/ids.js", () => ({
  reserveNextSessionId: reserveNextSessionIdMock,
}));

vi.mock("../../src/metadata.js", () => ({
  readInterfaceConsent: readInterfaceConsentMock,
  writeInterfaceConsent: writeInterfaceConsentMock,
  writeTelegramOffer: writeTelegramOfferMock,
  telegramBindingKey: (chatId: number, messageThreadId?: number) =>
    `${chatId}:${messageThreadId ?? "main"}`,
  archiveSessions: archiveSessionsMock,
  clearGitHubPollDisabledSession: clearGitHubPollDisabledSessionMock,
  listGitHubPollDisabledSourceIds: (...args: unknown[]): string[] =>
    (listGitHubPollDisabledSourceIdsMock(...args) as string[] | undefined) ?? [],
  deleteRuntimeLogCursorsForSession: deleteRuntimeLogCursorsForSessionMock,
  deleteServiceInstance: deleteServiceInstanceMock,
  deleteServiceInstancesForSession: deleteServiceInstancesForSessionMock,
  deleteServiceSourceStatesForService: deleteServiceSourceStatesForServiceMock,
  deleteServiceSourceStatesForSession: deleteServiceSourceStatesForSessionMock,
  deleteTelegramSourceStateForSession: deleteTelegramSourceStateForSessionMock,
  deleteTelegramReplyTarget: deleteTelegramReplyTargetMock,
  hasPendingTelegramSend: hasPendingTelegramSendMock,
  listActiveServiceProblems: listActiveServiceProblemsMock,
  listServiceInstances: listServiceInstancesMock,
  listServiceInstancesForSession: listServiceInstancesForSessionMock,
  listSessions: listSessionsMock,
  readAvailableBacklogItems: readAvailableBacklogItemsMock,
  readServiceInstance: readServiceInstanceMock,
  readSession: readSessionMock,
  readTelegramBindings: readTelegramBindingsMock,
  readTelegramReplyTarget: readTelegramReplyTargetMock,
  recordTelegramMessages: recordTelegramMessagesMock,
  requestGitHubMergeConflictRestoreReplay: requestGitHubMergeConflictRestoreReplayMock,
  writeTelegramBindings: writeTelegramBindingsMock,
  writeTelegramReplyTarget: writeTelegramReplyTargetMock,
  writeServiceInstance: writeServiceInstanceMock,
  writeSession: writeSessionMock,
}));

vi.mock("../../src/review-interface-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof interfaceConsentModule>()),
  consentPolicy: consentPolicyMock,
  repositoryOf: consentRepositoryMock,
}));

vi.mock("../../src/todo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof todoModule>();
  return {
    ...actual,
    ensureTodoLedger: vi.fn(() => ({
      revision: "fixture-resolved",
      status: "resolved",
      counts: { total: 1, open: 0, held: 0, completed: 1, cancelled: 0 },
      items: [],
      finishOverrides: [],
    })),
  };
});

vi.mock("../../src/agent-hook-state.js", () => ({
  deleteAgentHookState: deleteAgentHookStateMock,
  readAgentHookState: readAgentHookStateMock,
}));

// Partial mock: the real agents/index.ts (loaded via importOriginal above)
// reads codexCommand, buildCodexPlan, etc. from this module eagerly at load
// time, so a literal mock missing them throws "No export is defined".
vi.mock("../../src/agents/codex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof codexModule>()),
  codexHookHomePath: codexHookHomePathMock,
  captureCodexRolloutBaseline: captureCodexRolloutBaselineMock,
  findLatestCodexSessionFile: findLatestCodexSessionFileMock,
  readCodexRolloutState: readCodexRolloutStateMock,
  scanCodexRolloutForMessage: scanCodexRolloutForMessageMock,
}));

vi.mock("../../src/agents/models.js", () => ({
  resolveAgentReasoningEffort: resolveAgentReasoningEffortMock,
  resolveCursorLaunchModel: resolveCursorLaunchModelMock,
  validateOpenCodeModel: validateOpenCodeModelMock,
}));

vi.mock("../../src/sidecars/builtins.js", () => ({
  BUILTIN_SIDECARS: {
    playwright: {
      config: {
        command:
          "node /abs/cli.js --headless --isolated --host 127.0.0.1 --port $SPUR_RESERVED_PORT_PLAYWRIGHT",
        autoStart: false,
        agents: ["claude", "codex"],
        ports: {
          http: { env: "SPUR_RESERVED_PORT_PLAYWRIGHT", start: 8730, end: 8799 },
        },
        mcp: { server: "playwright", portId: "http", path: "/mcp", clientHost: "localhost" },
      },
      resolveCommand: resolvePlaywrightSidecarCommandMock,
      sweepLeaked: sweepLeakedPlaywrightMock,
      readiness: waitForPlaywrightReadyMock,
    },
  },
}));

vi.mock("../../src/port-probe.js", () => ({
  clearPortListener: clearPortListenerMock,
  isHostPortFree: isHostPortFreeMock,
  hasEstablishedConnections: hasEstablishedConnectionsMock,
  findListenerPids: findListenerPidsMock,
  snapshotListeners: snapshotListenersMock,
}));

vi.mock("../../src/disk-space.js", () => ({
  readFreeKb: readFreeKbMock,
  DISK_PROBE_TIMEOUT_MS: 2_000,
}));

// The daemon never runs `du` (see cache-retention.ts's call-site comment) —
// runDiskBudgetSweep only reads the CLI-written disk-budget.json, so only
// that read is mocked here.
vi.mock("../../src/disk-budget.js", () => ({
  readDiskBudgetReport: readDiskBudgetReportMock,
  // Stubbed (never real) so a call to either is provably visible in a test
  // (S10): the sweep's own contract is "read the file, never measure
  // anything", and a mock the test never sees called pins nothing.
  measureDiskBudget: measureDiskBudgetMock,
  realDu: realDuMock,
}));

// Only snapshotProcesses is mocked (a real `ps` fork, the thing the fast
// tier must never do) — every other export (confirmReaps, reapSidecarPane,
// signalSidecarPane, reapRecordedIdentity, sweepSidecars, ...) stays the
// real implementation so reap-confirmation/survivor logic is still
// exercised for real, just against a controlled snapshot.
vi.mock("../../src/sidecars/reap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof reapModule>();
  return { ...actual, snapshotProcesses: snapshotProcessesMock };
});

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof runtimeTmuxModule>();
  return {
    PromptReadyTimeoutError: actual.PromptReadyTimeoutError,
    TmuxProbeUnknownError: actual.TmuxProbeUnknownError,
    captureTmuxPane: captureTmuxPaneMock,
    captureTmuxPaneOrEmpty: captureTmuxPaneOrEmptyMock,
    createTmuxSession: createTmuxSessionMock,
    createTmuxCommandSession: createTmuxCommandSessionMock,
    createTmuxSidecarSession: createTmuxSidecarSessionMock,
    sidecarTmuxAlive: sidecarTmuxAliveMock,
    getSidecarTmuxPresence: getSidecarTmuxPresenceMock,
    refreshTmuxFleetSnapshot: refreshTmuxFleetSnapshotMock,
    sidecarTmuxSession: sidecarTmuxSessionMock,
    listTmuxSessionNames: listTmuxSessionNamesMock,
    getTmuxSessionActivity: getTmuxSessionActivityMock,
    getTmuxPanePid: getTmuxPanePidMock,
    getTmuxSessionPresence: getTmuxSessionPresenceMock,
    getTmuxPanePresence: getTmuxPanePresenceMock,
    lookupTmuxPanePid: lookupTmuxPanePidMock,
    getFleetSessionRssBytes: getFleetSessionRssBytesMock,
    isProcessRunningInTmux: isProcessRunningInTmuxMock,
    probeTmuxProcessMatch: probeTmuxProcessMatchMock,
    killTmuxSession: killTmuxSessionMock,
    killTmuxSessionTree: killTmuxSessionTreeMock,
    setTmuxSocketName: setTmuxSocketNameMock,
    sendMessageToTmux: sendMessageToTmuxMock,
    sendInterruptKeysToTmux: sendInterruptKeysToTmuxMock,
    sendSensitiveMessageToTmux: sendSensitiveMessageToTmuxMock,
    sendSubmitKeyToTmux: sendSubmitKeyToTmuxMock,
    sendMenuSelectionKeys: sendMenuSelectionKeysMock,
    tmuxPaneDead: tmuxPaneDeadMock,
    tmuxSessionExists: tmuxSessionExistsMock,
    waitForTmuxReady: waitForTmuxReadyMock,
  };
});

vi.mock("../../src/agent-processes.js", () => ({
  captureAgentProcessesForLaunch: captureAgentProcessesForLaunchMock,
  capturePaneAgentProcesses: capturePaneAgentProcessesMock,
  terminateAgentProcesses: terminateAgentProcessesMock,
  findForeignAgentProcessesForSession: findForeignAgentProcessesForSessionMock,
}));

vi.mock("../../src/host-memory.js", () => ({
  isSystemdOomdPresent: isSystemdOomdPresentMock,
  readCgroupMemorySnapshot: readCgroupMemorySnapshotMock,
  readCgroupPressure: readCgroupPressureMock,
  readHostMemory: readHostMemoryMock,
}));

vi.mock("../../src/session-slots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof sessionSlotsModule>()),
  AGENT_STATE_TOOL_NAME: "spur-agent-state",
  SELF_DESTRUCT_TOOL_NAME: "spur-self-destruct",
  SLOT_TOOL_NAME: "spur-slots",
  TODO_TOOL_NAME: "spur-todo",
  applySlotsUpdate: applySlotsUpdateMock,
  applySlotsUpdateWithResult: applySlotsUpdateWithResultMock,
  applyNormalizedSlotsUpdate: applyNormalizedSlotsUpdateMock,
  ensureSessionSlotTool: ensureSessionSlotToolMock,
  normalizeSlotsUpdate: vi.fn(
    (request: {
      title?: string;
      clearTitle?: boolean;
      setTitleIfAbsent?: boolean;
      source?: "manual" | "agent";
      links?: Array<{ label: string; url: string }>;
      unlinkLabels?: string[];
      tags?: string[];
      untags?: string[];
    }) => ({
      ...(request.title !== undefined ? { title: request.title } : {}),
      clearTitle: request.clearTitle === true,
      ...(request.setTitleIfAbsent === true ? { setTitleIfAbsent: true } : {}),
      source: request.source ?? "agent",
      links: request.links ?? [],
      unlinkLabels: request.unlinkLabels ?? [],
      tags: request.tags ?? [],
      untags: request.untags ?? [],
    }),
  ),
  removeSessionSlotTool: removeSessionSlotToolMock,
  withSessionSlotInstructions: withSessionSlotInstructionsMock,
  normalizeSlotLinks: normalizeSlotLinksMock,
}));

vi.mock("../../src/session-artifacts.js", () => ({
  ensureSessionArtifactsDir: vi.fn((_dataDir: string, sessionId: string) => {
    const dir = artifactDirForSession(sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  deleteSessionArtifactById: deleteSessionArtifactByIdMock,
  deleteSessionArtifactsExcept: deleteSessionArtifactsExceptMock,
  deleteSessionArtifactsDir: vi.fn((_dataDir: string, sessionId: string) => {
    rmSync(artifactDirForSession(sessionId), { recursive: true, force: true });
  }),
  listSessionArtifacts: listSessionArtifactsMock,
  readSessionArtifact: readSessionArtifactMock,
  setSessionArtifactOrigin: setSessionArtifactOriginMock,
  setSessionArtifactUserAdded: setSessionArtifactUserAddedMock,
  isImageArtifactPath: vi.fn((path: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path)),
  withSessionArtifactInstructions: vi.fn((prompt: string) => prompt),
}));

vi.mock("../../src/session-memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof sessionMemoryModule>();
  return {
    ...actual,
    listSessionMemoryRecords: listSessionMemoryRecordsMock,
    getSessionMemoryRecord: getSessionMemoryRecordMock,
    setSessionMemoryRecord: setSessionMemoryRecordMock,
    resolveSessionMemoryRecord: resolveSessionMemoryRecordMock,
  };
});

vi.mock("../../src/shared-memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedMemoryModule>();
  return {
    ...actual,
    listSharedMemoryKeys: listSharedMemoryKeysMock,
    getSharedMemory: getSharedMemoryMock,
    setSharedMemory: setSharedMemoryMock,
    removeSharedMemory: removeSharedMemoryMock,
    withSharedMemoryInstructions: withSharedMemoryInstructionsMock,
  };
});

vi.mock("../../src/workspace.js", () => ({
  branchRefsExist: branchRefsExistMock,
  createWorktree: createWorktreeMock,
  findWorktreePathForBranch: findWorktreePathForBranchMock,
  hasUncommittedChanges: hasUncommittedChangesMock,
  hasUnpushedCommits: hasUnpushedCommitsMock,
  isGitWorktree: isGitWorktreeMock,
  pruneRepoWorktrees: pruneRepoWorktreesMock,
  readCurrentBranch: readCurrentBranchMock,
  readRemoteUrls: readRemoteUrlsMock,
  removeWorktree: removeWorktreeMock,
  resolveRepoPathFromWorktree: resolveRepoPathFromWorktreeMock,
  workspaceExists: workspaceExistsMock,
  probeWorkspace: probeWorkspaceMock,
  worktreePathFor: (worktreeBaseDir: string, projectId: string, sessionId: string) =>
    `${worktreeBaseDir}/${projectId}/${sessionId}`,
}));

/** Batched PR-discovery response with every asked-for branch resolving to no PR. */
function emptyPrLookupEnvelope(): string {
  return JSON.stringify({
    data: {
      rateLimit: { cost: 3, remaining: 4_800, resetAt: "2026-03-18T11:00:00.000Z" },
      r: { isFork: false, parent: null, a0: { nodes: [] } },
    },
  });
}

function baseConfig() {
  return {
    configPath: "/tmp/spur.yaml",
    server: { host: "127.0.0.1", port: 4310 },
    dataDir: TEST_DATA_DIR,
    worktreeDir: "/tmp/spur-worktrees",
    defaultAgent: "claude",
    tmux: { socketName: "spur-4310" },
    ui: { port: 5555 },
    models: { codexHome: "/tmp/codex" },
    rateLimitReactivation: { afterHours: 0 },
    authRotation: {
      autoRotateOnRateLimit: false,
      cooldownMinutes: 60,
      maxRotationsPerEpisode: 2,
    },
    diskRetention: { warnFreeGb: 10 },
    sessionGc: {
      enabled: false,
      olderThanDays: 30,
      intervalMinutes: 360,
      maxGroupsPerSweep: 20,
      statuses: ["completed", "killed", "stopped"],
    },
    artifactRetention: {
      enabled: false,
      olderThanDays: 30,
      intervalMinutes: 360,
      maxAnchorsPerSweep: 20,
      maxBytesPerSession: 2 * 1024 * 1024 * 1024,
      maxFilesPerSession: 500,
    },
    sidecarGc: {
      enabled: true,
      idleTtlMinutes: 120,
      maxAgeWarnMinutes: 360,
    },
    diskBudget: {
      enabled: false,
      intervalMinutes: 360,
      warnAttributableGb: 60,
      npmCacheMaxGb: 20,
      buildCacheOlderThanDays: 14,
      maxWorktreesPerSweep: 20,
    },
    admission: {
      enabled: true,
      maxLiveSessions: 1000,
      maxLiveSessionsSource: "derived",
      perSessionBytes: 1_610_612_736,
      reserveFraction: 0.7,
      memoryGuard: {
        enforce: false,
        enforceFloors: true,
        shedEnabled: true,
        minAvailableBytes: 1_073_741_824,
        minFreeSwapBytes: 0,
        admissionFloorBytes: 8_000_000_000,
        shedCriticalFloorBytes: 4_000_000_000,
        restoreFloorBytes: 9_610_612_736,
        pressureSomeAvg10Refuse: 20,
        shedSwapUsedFraction: 0.9,
      },
    },
    projects: {
      api: {
        path: "/repo/api",
        defaultBranch: "main",
        sessionPrefix: "api",
        worktree: true,
        symlinks: [".env"],
        sidecars: {},
        sources: {},
        backlog: {},
        triggers: {},
      },
    },
    tags: [],
  };
}

async function loadSessionServiceModule(options?: {
  realPaneGeneration?: boolean;
}): Promise<typeof sessionServiceModule> {
  vi.resetModules();
  const module = await import("../../src/session-service.js");
  const BaseSessionService = module.SessionService;
  class TrackedSessionService extends BaseSessionService {
    constructor(...args: ConstructorParameters<typeof BaseSessionService>) {
      super(...args);
      const internals = this as unknown as {
        capturePaneGeneration?: (session: SessionRecord) => Promise<{
          tmuxSession: string;
          panePid: number;
          processStarttime: number;
        }>;
        paneGenerationMatches?: () => Promise<boolean>;
      };
      if (
        !options?.realPaneGeneration &&
        internals.capturePaneGeneration &&
        internals.paneGenerationMatches
      ) {
        vi.spyOn(internals, "capturePaneGeneration").mockImplementation(async (session) => ({
          tmuxSession: session.tmuxSession,
          panePid: 4242,
          processStarttime: 1,
        }));
        vi.spyOn(internals, "paneGenerationMatches").mockResolvedValue(true);
      }
      activeSessionServices.push(this);
    }
  }
  return { ...module, SessionService: TrackedSessionService };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

let normalizeSessionPrBinding: typeof sessionPrModule.normalizeSessionPrBinding;

function createSessionStore(...initial: SessionRecord[]) {
  const sessions = new Map<string, SessionRecord>();
  for (const record of initial) sessions.set(record.id, normalizeSessionPrBinding(clone(record)));
  // listSessionsMock mirrors metadata.ts' real stat-gated parse cache: an
  // unchanged record returns the SAME object on every call, a changed one
  // gets a fresh clone. Without this, every session would look changed on
  // every call (clone() always allocates a new object), which contradicts
  // the real listSessions() and would make the tick's record-change
  // detection untestable. readSessionMock/writeSessionMock stay a raw clone
  // per call, mirroring production where only listSessions is stat-gated.
  const published = new Map<string, { json: string; record: SessionRecord }>();
  readSessionMock.mockImplementation((_dataDir: string, sessionId: string) => {
    const session = sessions.get(sessionId);
    // null, not undefined — matches metadata.ts's real readSession contract
    // (SessionRecord | null). A mock returning undefined here would make
    // ownerExists: owner !== null in collectSidecarReapCandidates
    // untestable: undefined !== null is true, so a missing owner would
    // always read as "exists".
    return session ? normalizeSessionPrBinding(clone(session)) : null;
  });
  writeSessionMock.mockImplementation((_dataDir: string, session: SessionRecord) => {
    sessions.set(session.id, normalizeSessionPrBinding(clone(session)));
  });
  listSessionsMock.mockImplementation(() =>
    [...sessions.values()].map((session) => {
      const record = normalizeSessionPrBinding(clone(session));
      const json = JSON.stringify(record);
      const existing = published.get(session.id);
      if (existing && existing.json === json) {
        return existing.record;
      }
      published.set(session.id, { json, record });
      return record;
    }),
  );
  return sessions;
}

function serviceKey(sessionId: string, serviceId: string): string {
  return `${sessionId}:${serviceId}`;
}

function resetServiceStore() {
  serviceRecords.clear();
  listServiceInstancesMock.mockImplementation(() =>
    [...serviceRecords.values()].map((service) => clone(service)),
  );
  listServiceInstancesForSessionMock.mockImplementation((_dataDir: string, sessionId: string) =>
    [...serviceRecords.values()]
      .filter((service) => service.sessionId === sessionId)
      .map((service) => clone(service)),
  );
  readServiceInstanceMock.mockImplementation(
    (_dataDir: string, sessionId: string, serviceId: string) => {
      const service = serviceRecords.get(serviceKey(sessionId, serviceId));
      return service ? clone(service) : undefined;
    },
  );
  writeServiceInstanceMock.mockImplementation(
    (_dataDir: string, service: ServiceInstanceRecord) => {
      serviceRecords.set(serviceKey(service.sessionId, service.serviceId), clone(service));
    },
  );
  deleteServiceInstanceMock.mockImplementation(
    (_dataDir: string, sessionId: string, serviceId: string) => {
      serviceRecords.delete(serviceKey(sessionId, serviceId));
    },
  );
  deleteServiceInstancesForSessionMock.mockImplementation((_dataDir: string, sessionId: string) => {
    for (const key of serviceRecords.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        serviceRecords.delete(key);
      }
    }
  });
}

function mockClaudeJsonlState(
  state: string,
  options?: {
    lastMtimeMs?: number;
    tokenUsage?: {
      provider: "claude";
      generationId: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
      reasoningOutputTokens?: number;
    };
  },
) {
  readClaudeJsonlStateMock.mockResolvedValue({
    state,
    reader: {
      filePath: "test.jsonl",
      lastOffset: 0,
      lastMtimeMs: options?.lastMtimeMs ?? 0,
      tailRecords: [],
    },
    ...(options?.tokenUsage ? { tokenUsage: options.tokenUsage } : {}),
  });
}

function mockClaudeSessionStatus(state: string, status: string) {
  readClaudeSessionStatusMock.mockResolvedValue({
    state,
    status,
    filePath: "status.json",
    updatedMs: Date.parse("2026-03-18T10:04:59.000Z"),
  });
}

function runningSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = overrides.id ?? "api-1";
  return {
    id,
    project: "api",
    agent: "claude",
    prompt: "hello",
    branch: id,
    worktree: true,
    worktreePath: `/tmp/spur-worktrees/api/${id}`,
    tmuxSession: id,
    launchCommand: "claude --dangerously-skip-permissions",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
    ...overrides,
  };
}

type SessionServiceInternals = {
  captureAgentSessionId(session: SessionRecord, timeoutMs: number): Promise<SessionRecord>;
  agentSessionIdPersistBackoffUntil: Map<string, number>;
  lastSuccessfulTodoNudgeAt: Map<string, number>;
  lastHumanHeldNudgeRevisions: Map<string, string>;
  pruneSessionScopedState(liveIds: ReadonlySet<string>): void;
  waitForSubmitAck(
    binding: { scan(text: string): Promise<{ found: boolean; lastScannedFile: string | null }> },
    messageText: string,
    windowMs: number,
  ): Promise<{ found: boolean; lastScannedFile: string | null }>;
  paneGenerationMatches(session: SessionRecord, expected: unknown): Promise<boolean>;
  sendAgentMessage(
    session: {
      id: string;
      tmuxSession: string;
      agent: "claude" | "codex" | "cursor";
      launchCommand: string;
      worktreePath: string;
      agentSessionId?: string;
    },
    message: string,
    options?: { interrupt?: boolean; freshLaunch?: boolean; interactive?: boolean },
  ): Promise<AgentSendOutcome>;
  writeAgentMessage: SessionServiceInternals["sendAgentMessage"];
  scheduleTodoNudge(session: SessionRecord): void;
  waitForQueuedMessage(sessionId: string): Promise<string>;
  queuedDeliveryAckedAt: Map<string, number>;
  withWorkspaceLifecycleLocks<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  enrichDashboard(session: SessionRecord): Promise<{ id: string; model?: string }>;
  classifySessionRecord(
    session: SessionRecord,
    options?: { scanPane?: boolean },
  ): Promise<{ state: SessionState; session: SessionRecord }>;
  classifySessionState(session: SessionRecord): Promise<SessionState>;
  codexMcpDialogOverrides: Map<string, number>;
  claudeCompactingOverrides: Map<string, number>;
  cursorPaneReadyOverrides: Map<string, number>;
  lastClassifiedLogStates: Map<string, SessionState>;
  paneWriteLocks: Map<string, Promise<void>>;
  sessionLifecycleLocks: Map<string, Promise<void>>;
  handoffsInFlight: Map<string, unknown>;
  admissionReservations: Map<symbol, string>;
  foregroundSpawnReceipts: Map<symbol, unknown>;
  reopensInFlight: Map<string, unknown>;
  deliveryRuns: Map<string, Promise<void>>;
  runDeliveryLoop(sessionId: string): Promise<void>;
  tokenBudgetActivationError(session: SessionRecord): string | undefined;
  stopForTokenBudget(view: Pick<SessionRecord, "id">): Promise<boolean>;
  queueDeliveryInFlight: Set<string>;
  tryDeliverQueuedMessage(sessionId: string): Promise<boolean>;
  deliverPrepared(
    sessionId: string,
    message: string,
    options: { entryPoint: "send" | "deliver" | "flush" },
  ): Promise<unknown>;
  maybeNudgeTodo(session: SessionRecord): Promise<void>;
  enrichWithClassified(
    session: SessionRecord,
    claudeAccounts?: { id: string; label?: string; authenticated: boolean }[],
    sessionBatch?: SessionRecord[],
  ): Promise<{ view: SessionView; classified: unknown }>;
  restoreWarmupUntil: Map<string, number>;
  withWorkspaceLifecycleLocks<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  confirmAgentExited(
    session: Pick<SessionRecord, "id" | "tmuxSession" | "agent" | "launchCommand">,
  ): Promise<boolean>;
  readRuntimeSnapshot(
    session: Pick<SessionRecord, "id" | "tmuxSession" | "agent" | "launchCommand">,
    options?: { fresh?: boolean },
  ): Promise<{
    runtimeAlive: boolean;
    paneUsable: boolean;
    processAlive: boolean;
    probeUnresponsive: boolean;
  }>;
  runAttentionMonitor(baseline: boolean): Promise<void>;
  pollAttentionStates(baseline: boolean): Promise<void>;
  attentionMonitorRunning: boolean;
  attentionMonitorSuppressedTicks: number;
  attentionStates: Map<string, "needs_input" | "error" | "rate_limited">;
  lastObservedRunStates: Map<string, SessionState>;
  todoNudgeDisabled: Map<string, { kind: "ledger_corrupt" | "target_gone"; reason: string }>;
  todoNudgeBackoff: Map<string, { failures: number; nextRetryAtMs: number }>;
  scheduleHealedSidecarRestart(session: SessionRecord): void;
  sidecarHealTasks: Map<string, Promise<void>>;
};

function sessionServiceInternals(service: unknown): SessionServiceInternals {
  return service as SessionServiceInternals;
}

// Typed, because vitest's `toBe` accepts any expected value: renaming an outcome
// in the source has to fail the typecheck, not only the next test run.
const SUBMITTED: AgentSendOutcome = "submitted";
const SUBMIT_UNCONFIRMED: AgentSendOutcome = "submit_unconfirmed";

// beforeEach body: fake clock, fresh data dir, and every mock back to its default.
export async function resetSessionServiceHarness(accounts: () => TestAccount[]): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));
  // `claudeCommand()` is unmocked here, so an ambient override would leak into
  // launch-command assertions. Same reason agents-claude.test.ts clears it.
  delete process.env["SPUR_CLAUDE_BIN"];
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "spur-session-service-"));
  nextUuid = 1;
  vi.mocked(randomUUID).mockReset().mockImplementation(fixtureUuid);
  ({ normalizeSessionPrBinding } = await import("../../src/session-pr.js"));
  const todo = await import("../../src/todo.js");
  vi.mocked(todo.ensureTodoLedger)
    .mockReset()
    .mockReturnValue({
      revision: "fixture-resolved",
      status: "resolved",
      counts: { total: 1, open: 0, held: 0, completed: 1, cancelled: 0 },
      items: [],
      finishOverrides: [],
    });
  const timersPromises = await vi.importActual<typeof timersPromisesModule>("node:timers/promises");
  timerPromisesSleepMock.mockReset().mockImplementation((ms) => timersPromises.setTimeout(ms));
  rmSync(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
  resetAccountStoreMocks(accounts);

  upsertConfigRegistryPathMock.mockReset().mockReturnValue(["/tmp/spur.yaml"]);
  addUnconfiguredProjectMock.mockReset().mockReturnValue([]);
  removeUnconfiguredProjectMock.mockReset().mockReturnValue([]);
  readConfigRegistryFileMock
    .mockReset()
    .mockReturnValue({ configPaths: ["/tmp/spur.yaml"], unconfiguredProjects: [] });
  mutateConfigRegistryMock.mockReset().mockImplementation(
    (
      _dataDir: string,
      mutate: (current: {
        configPaths: string[];
        unconfiguredProjects: registryModule.UnconfiguredProjectEntry[];
      }) => {
        configPaths: string[];
        unconfiguredProjects: registryModule.UnconfiguredProjectEntry[];
      },
    ) => mutate({ configPaths: ["/tmp/spur.yaml"], unconfiguredProjects: [] }),
  );
  invalidateRemovedRegistryPathsMock.mockReset();

  buildAgentLaunchPlanMock
    .mockReset()
    .mockImplementation(
      (agent: string, initialMessage: string, options?: { planMode?: boolean }) => ({
        agent,
        launchCommand:
          agent === "codex"
            ? "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust"
            : options?.planMode
              ? "claude --dangerously-skip-permissions --permission-mode plan"
              : "claude --dangerously-skip-permissions",
        initialMessage,
        readyMarkers: agent === "codex" ? ["OpenAI Codex", "›"] : ["Claude Code", "❯"],
      }),
    );
  buildAgentRestorePlanMock.mockReset().mockResolvedValue({
    agent: "claude",
    launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
    initialMessage:
      'This session was restored after the agent exited. You are back in the same worktree and branch. Pull the latest main first, then check whether the original task is still needed — another agent may have already done it. If it is already done, run `"$SPUR_SESSION_TOOL_DIR/spur-self-destruct"` and close this session\'s pull request if it duplicates that work; if it is not a duplicate but only extends or overlaps work already merged, trim this PR down to the remaining necessary changes. Otherwise continue the original task. Original task:\n\nhello',
    readyMarkers: ["❯"],
  });
  buildAgentResumePlanMock
    .mockReset()
    .mockImplementation(
      (
        _agent: string,
        _agentSessionId: string,
        _launchCommand: string,
        options?: { planMode?: boolean },
      ) => ({
        launchCommand: options?.planMode
          ? "claude --resume session-uuid --dangerously-skip-permissions --permission-mode plan"
          : "claude --resume session-uuid --dangerously-skip-permissions",
        readyMarkers: ["❯"],
      }),
    );
  findAgentSessionIdMock.mockReset().mockResolvedValue("session-uuid");
  readAgentConversationMock.mockReset().mockResolvedValue(null);
  captureOpenCodeSessionBaselineMock.mockReset().mockImplementation(async (worktreePath) => ({
    worktreePath,
    sessionIds: new Set<string>(),
  }));
  resolveNewOpenCodeSessionIdMock.mockReset().mockResolvedValue("ses_owned");
  waitForOpenCodeLaunchMessageMock.mockReset().mockResolvedValue(true);
  withOpenCodeLaunchIdentityLockMock
    .mockReset()
    .mockImplementation(async (_worktreePath: string, action: () => Promise<unknown>) => action());
  readOpenCodeStateMock.mockReset().mockResolvedValue(null);
  readOpenCodeStructuredStateMock.mockReset().mockImplementation(async (...args: unknown[]) => ({
    state: await readOpenCodeStateMock(...args),
  }));
  agentProcessMatchersMock
    .mockReset()
    .mockImplementation((agent: string, launchCommand: string) => {
      const binary = launchCommand.trim().split(/\s+/).find(Boolean);
      if (binary) {
        return [binary];
      }
      return agent === "cursor" ? ["agent", "cursor-agent"] : [agent];
    });
  agentLaunchUsesForeignBinaryMock.mockReset().mockReturnValue(false);
  agentBusyQueuedSendAwaitsPromptMock
    .mockReset()
    .mockImplementation((agent: string) => agent === "cursor");
  agentInterruptKeysMock
    .mockReset()
    .mockImplementation((agent: string) => (agent === "cursor" ? [] : ["C-c"]));
  agentQueuedSendPromptGraceMsMock
    .mockReset()
    .mockImplementation((agent: string) => (agent === "cursor" ? 5_000 : 15_000));
  agentSessionConfigMock
    .mockReset()
    .mockImplementation(
      (agent: string, args?: { dataDir: string; sessionId: string; restrictWrites?: boolean }) =>
        agent === "cursor"
          ? {
              env: {
                CURSOR_CONFIG_DIR: `${args?.dataDir ?? TEST_DATA_DIR}/cursor/${args?.sessionId ?? "api-1"}`,
                ...(args?.restrictWrites ? { SPUR_CURSOR_RESTRICT_WRITES: "1" } : {}),
              },
              planOptions: {
                cursorConfigDir: `${args?.dataDir ?? TEST_DATA_DIR}/cursor/${args?.sessionId ?? "api-1"}`,
              },
            }
          : {},
    );
  agentStateStrategyMock
    .mockReset()
    .mockImplementation((agent: string) =>
      agent === "codex" ? "hook" : agent === "cursor" ? "cursor_jsonl" : "claude_jsonl",
    );
  agentWaitsForSubmitAckMock
    .mockReset()
    .mockImplementation(
      (agent: string) => agent === "codex" || agent === "claude" || agent === "cursor",
    );
  agentHasLaunchSubmitAckMock.mockReset().mockImplementation((agent: string) => agent === "claude");
  agentSubmitAckPacingMock
    .mockReset()
    .mockImplementation(
      (
        agent: string,
        options?: { freshLaunch?: boolean; interactive?: boolean; slashCommand?: boolean },
      ) => {
        if (agent === "claude" && options?.freshLaunch === true) {
          return { windowMs: 5_000, maxResends: 2 };
        }
        if (options?.interactive === true) {
          return { windowMs: 5_000, maxResends: 3 };
        }
        if (agent === "claude" && options?.slashCommand !== true) {
          return { windowMs: 300_000, maxResends: 2, firstWindowMs: 5_000 };
        }
        return agent === "cursor"
          ? { windowMs: 5_000, maxResends: 12 }
          : { windowMs: 300_000, maxResends: 2 };
      },
    );
  agentEarlySubmitResendAllowedMock.mockReset().mockResolvedValue(true);
  captureCodexRolloutBaselineMock.mockReset().mockResolvedValue(new Map());
  scanCodexRolloutForMessageMock
    .mockReset()
    .mockResolvedValue({ found: true, lastScannedFile: null });
  resumeAgentSubmitAckBindingMock.mockReset().mockResolvedValue(null);
  createAgentSubmitAckBindingMock
    .mockReset()
    .mockImplementation(async (agent: string, ctx: { codexSessionsDir: string }) => {
      if (agent !== "codex") {
        return null;
      }
      const baseline: Map<string, number> = await captureCodexRolloutBaselineMock(
        ctx.codexSessionsDir,
      );
      return {
        async scan(text: string) {
          return scanCodexRolloutForMessageMock(ctx.codexSessionsDir, text, baseline);
        },
      };
    });
  parseAgentNameMock.mockReset().mockImplementation((agent: string) => agent);
  setupAgentHooksMock.mockReset().mockResolvedValue({});
  deleteAgentHookStateMock.mockReset();
  readAgentHookStateMock.mockReset().mockReturnValue(null);
  findLatestClaudeSessionFileMock.mockReset().mockResolvedValue(null);
  readClaudeSessionStatusMock.mockReset().mockResolvedValue(null);
  readClaudeJsonlStateMock.mockReset().mockResolvedValue(null);
  readClaudeConversationTailMock.mockReset().mockResolvedValue(null);
  readCursorJsonlStateMock.mockReset().mockResolvedValue(null);
  readCursorTokenUsageMock.mockReset().mockResolvedValue(undefined);
  loadConfigMock.mockReset().mockReturnValue(baseConfig());
  writeTelegramOfferMock.mockReset();
  readInterfaceConsentMock.mockReset().mockReturnValue(null);
  writeInterfaceConsentMock.mockReset();
  consentPolicyMock.mockReset();
  consentRepositoryMock.mockReset();
  readTelegramBindingsMock.mockReset().mockReturnValue(new Map());
  readTelegramReplyTargetMock.mockReset().mockReturnValue(null);
  sendTelegramReplyMock.mockReset().mockResolvedValue({ messageIds: [] });
  recordTelegramMessagesMock.mockReset();
  sendTelegramChatActionMock.mockReset().mockResolvedValue({});
  deleteTelegramReplyTargetMock.mockReset();
  hasPendingTelegramSendMock.mockReset().mockReturnValue(false);
  editTelegramTopicMock.mockReset().mockResolvedValue(true);
  closeTelegramTopicMock.mockReset().mockResolvedValue(undefined);
  writeTelegramBindingsMock.mockReset();
  writeTelegramReplyTargetMock.mockReset();
  loadProjectConfigMock.mockReset();
  findProjectConfigPathInDirectoryMock.mockReset().mockReturnValue(undefined);
  runSpawnPreflightMock.mockReset().mockResolvedValue({});
  listSessionMemoryRecordsMock.mockReset().mockReturnValue([]);
  getSessionMemoryRecordMock.mockReset().mockReturnValue(null);
  listSharedMemoryKeysMock.mockReset().mockReturnValue([]);
  getSharedMemoryMock.mockReset().mockReturnValue(null);
  setSharedMemoryMock.mockReset();
  removeSharedMemoryMock.mockReset().mockReturnValue(false);
  withSharedMemoryInstructionsMock.mockReset().mockImplementation((prompt: string) => prompt);
  setSessionMemoryRecordMock.mockReset();
  resolveSessionMemoryRecordMock.mockReset().mockReturnValue(null);
  reserveNextSessionIdMock.mockReset().mockResolvedValue("api-1");
  listSessionsMock.mockReset().mockReturnValue([]);
  readAvailableBacklogItemsMock.mockReset().mockReturnValue([]);
  readSessionMock.mockReset();
  writeSessionMock.mockReset();
  createSessionStore();
  listSessionsMock.mockReturnValue([]);
  requestGitHubMergeConflictRestoreReplayMock.mockReset();
  deleteServiceInstanceMock.mockReset();
  deleteServiceInstancesForSessionMock.mockReset();
  deleteRuntimeLogCursorsForSessionMock.mockReset();
  deleteServiceSourceStatesForServiceMock.mockReset();
  deleteServiceSourceStatesForSessionMock.mockReset();
  deleteTelegramSourceStateForSessionMock.mockReset().mockReturnValue({ heldBinding: true });
  listActiveServiceProblemsMock.mockReset().mockReturnValue([]);
  listServiceInstancesMock.mockReset().mockReturnValue([]);
  listServiceInstancesForSessionMock.mockReset().mockReturnValue([]);
  readServiceInstanceMock.mockReset().mockReturnValue(undefined);
  writeServiceInstanceMock.mockReset();
  resetServiceStore();
  createTmuxSessionMock.mockReset().mockResolvedValue(undefined);
  resolveCursorLaunchModelMock
    .mockReset()
    .mockImplementation(async (model: string | undefined) => model);
  validateOpenCodeModelMock.mockReset().mockImplementation(async (model: string) => model);
  resolveAgentReasoningEffortMock
    .mockReset()
    .mockImplementation(
      async (_agent: string, model: string | undefined, reasoningEffort: string) => ({
        ...(model !== undefined ? { model } : {}),
        reasoningEffort,
      }),
    );
  createTmuxCommandSessionMock.mockReset().mockResolvedValue(undefined);
  // A resolved create means `new-session` landed, which is exactly when the
  // real createTmuxSidecarSession fires onCreated. Cases where nothing was
  // created reject instead.
  createTmuxSidecarSessionMock
    .mockReset()
    .mockImplementation(async (input: { onCreated?: () => void }) => {
      input.onCreated?.();
    });
  sweepLeakedPlaywrightMock.mockReset().mockResolvedValue(0);
  waitForPlaywrightReadyMock.mockReset().mockResolvedValue(true);
  resolvePlaywrightSidecarCommandMock.mockReset().mockReturnValue(undefined);
  clearPortListenerMock.mockReset().mockResolvedValue(undefined);
  isHostPortFreeMock.mockReset().mockResolvedValue(true);
  hasEstablishedConnectionsMock.mockReset().mockResolvedValue("none");
  findListenerPidsMock.mockReset().mockResolvedValue([]);
  snapshotListenersMock.mockReset().mockResolvedValue({ ok: false });
  snapshotProcessesMock
    .mockReset()
    .mockResolvedValue({ ok: true, byPid: new Map(), byPgid: new Map() });
  sidecarTmuxAliveMock.mockReset().mockResolvedValue(false);
  refreshTmuxFleetSnapshotMock.mockReset().mockResolvedValue(undefined);
  sidecarTmuxSessionMock
    .mockReset()
    .mockImplementation((id: string, name: string) => `${id}--${name}`);
  listTmuxSessionNamesMock.mockReset().mockResolvedValue(new Set());
  captureTmuxPaneMock.mockReset().mockResolvedValue("");
  captureTmuxPaneOrEmptyMock.mockReset().mockResolvedValue("");
  getTmuxSessionActivityMock.mockReset().mockResolvedValue(new Date("2026-03-18T10:04:30.000Z"));
  getTmuxPanePidMock.mockReset().mockResolvedValue(null);
  lookupTmuxPanePidMock
    .mockReset()
    .mockImplementation(async (_name, options) =>
      options?.fresh ? { status: "unavailable" } : { status: "ok", panePid: null },
    );
  getFleetSessionRssBytesMock.mockReset().mockResolvedValue(new Map());
  readHostMemoryMock.mockReset().mockReturnValue(null);
  readCgroupPressureMock.mockReset().mockReturnValue(null);
  readCgroupMemorySnapshotMock.mockReset().mockReturnValue(null);
  isSystemdOomdPresentMock.mockReset().mockReturnValue(false);
  isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
  probeTmuxProcessMatchMock
    .mockReset()
    .mockImplementation(async (sessionName, matchers, options) => {
      const alive = await isProcessRunningInTmuxMock(sessionName, matchers, options);
      return { alive, matchedByName: alive, unresponsive: false };
    });
  killTmuxSessionMock.mockReset().mockResolvedValue(undefined);
  captureAgentProcessesForLaunchMock.mockReset().mockResolvedValue({ status: "ok", processes: [] });
  capturePaneAgentProcessesMock.mockReset().mockResolvedValue({ status: "ok", processes: [] });
  terminateAgentProcessesMock.mockReset().mockResolvedValue({ status: "clear" });
  findForeignAgentProcessesForSessionMock.mockReset().mockResolvedValue({ status: "unavailable" });
  killTmuxSessionTreeMock.mockReset().mockResolvedValue(true);
  sendMessageToTmuxMock.mockReset().mockResolvedValue(undefined);
  sendInterruptKeysToTmuxMock.mockReset().mockResolvedValue(true);
  sendSensitiveMessageToTmuxMock.mockReset().mockResolvedValue(undefined);
  sendSubmitKeyToTmuxMock.mockReset().mockResolvedValue(undefined);
  sendMenuSelectionKeysMock.mockReset().mockResolvedValue(undefined);
  tmuxPaneDeadMock.mockReset().mockResolvedValue(false);
  tmuxSessionExistsMock.mockReset().mockResolvedValue(true);
  getTmuxSessionPresenceMock.mockReset().mockImplementation(async (name, options) => ({
    present: await (options ? tmuxSessionExistsMock(name, options) : tmuxSessionExistsMock(name)),
    unresponsive: false,
  }));
  getTmuxPanePresenceMock.mockReset().mockImplementation(async (name, options) => ({
    dead: await (options ? tmuxPaneDeadMock(name, options) : tmuxPaneDeadMock(name)),
    unresponsive: false,
  }));
  getSidecarTmuxPresenceMock.mockReset().mockImplementation(async (sessionId, sidecarName) => ({
    present: await sidecarTmuxAliveMock(sessionId, sidecarName),
    unresponsive: false,
  }));
  waitForTmuxReadyMock.mockReset().mockResolvedValue(undefined);
  createWorktreeMock.mockReset().mockResolvedValue("/tmp/spur-worktrees/api/api-1");
  branchRefsExistMock.mockReset().mockResolvedValue({ exists: true, remote: true });
  findWorktreePathForBranchMock.mockReset().mockResolvedValue(null);
  hasUncommittedChangesMock.mockReset().mockResolvedValue(false);
  hasUnpushedCommitsMock.mockReset().mockResolvedValue(false);
  isGitWorktreeMock.mockReset().mockResolvedValue(true);
  readCurrentBranchMock.mockReset().mockResolvedValue("main");
  readRemoteUrlsMock
    .mockReset()
    .mockResolvedValue(new Map([["origin", "git@github.com:acme/api.git"]]));
  removeWorktreeMock.mockReset().mockResolvedValue(undefined);
  resolveRepoPathFromWorktreeMock.mockReset().mockResolvedValue(undefined);
  workspaceExistsMock.mockReset().mockReturnValue(true);
  probeWorkspaceMock
    .mockReset()
    .mockImplementation(() => ({ exists: workspaceExistsMock(), missing: false }));
  logSpurEventMock.mockReset();
  // Default: probe unavailable, matching `readFreeKb`'s own real "swallow
  // and return undefined" contract — no `host.disk.low` event unless a
  // test explicitly opts in, so the huge pre-existing spawn-event-sequence
  // fixture stays unaffected.
  readFreeKbMock.mockReset().mockResolvedValue(undefined);
  // Same "no test-visible signal unless a test opts in" default as
  // readFreeKb above — absent measurement emits nothing.
  readDiskBudgetReportMock.mockReset().mockResolvedValue(undefined);
  measureDiskBudgetMock.mockReset();
  realDuMock.mockReset();
  flushEventLogCollapseMock.mockReset();
  tryRotateMock.mockReset();
  sendDesktopNotificationMock.mockReset().mockResolvedValue(undefined);
  findLatestCodexSessionFileMock.mockReset().mockResolvedValue(null);
  readCodexRolloutStateMock.mockReset().mockResolvedValue({ rollout: null, rateLimit: null });
  // Default: a well-formed batched-lookup response that says "no PR for this
  // branch". An unparseable answer is no longer read as "no PR" — it is a
  // failed lookup, which blocks teardown on purpose.
  ghMock.mockReset().mockResolvedValue(emptyPrLookupEnvelope());
  ensureSessionSlotToolMock.mockReset().mockReturnValue("/tmp/spur-tools/api-1");
  removeSessionSlotToolMock.mockReset();
  deleteSessionArtifactsExceptMock.mockReset();
  deleteSessionArtifactByIdMock.mockReset().mockReturnValue(true);
  listSessionArtifactsMock.mockReset().mockReturnValue({ artifacts: [], truncated: false });
  readSessionArtifactMock.mockReset().mockReturnValue(null);
  setSessionArtifactOriginMock.mockReset();
  setSessionArtifactUserAddedMock.mockReset();
  withSessionSlotInstructionsMock.mockReset().mockImplementation((prompt: string) => {
    return `slot-instructions\n${prompt}`;
  });
  normalizeSlotLinksMock.mockReset().mockImplementation((links: unknown) => {
    const linksRaw = links ?? [];
    if (!Array.isArray(linksRaw)) {
      throw new Error("links must be an array");
    }
    return linksRaw.map((link: unknown, index: number) => {
      if (!link || typeof link !== "object") {
        throw new Error(`links[${index}] must be an object`);
      }
      const linkRecord = link as { label?: unknown; url?: unknown };
      if (typeof linkRecord.label !== "string") {
        throw new Error(`links[${index}].label must be a string`);
      }
      if (typeof linkRecord.url !== "string") {
        throw new Error(`links[${index}].url must be a string`);
      }
      const normalizedLabel = linkRecord.label.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(normalizedLabel)) {
        throw new Error("slot link labels must match ^[a-z0-9][a-z0-9_-]{0,15}$");
      }
      const label =
        normalizedLabel === "github-pr" || normalizedLabel === "github_pr" ? "pr" : normalizedLabel;
      const trimmedUrl = linkRecord.url.trim();
      if (!trimmedUrl) {
        throw new Error("slot link URLs must be non-empty strings");
      }
      let url: string;
      try {
        url = new URL(trimmedUrl).toString();
      } catch {
        throw new Error(`Invalid slot link URL: ${trimmedUrl}`);
      }
      return { label, url };
    });
  });
  applySlotsUpdateMock.mockReset().mockImplementation((current, request) => {
    const links = [...(current?.links ?? [])];
    if (request.unlinkLabels) {
      for (const label of request.unlinkLabels) {
        const index = links.findIndex((link) => link.label === label);
        if (index !== -1) {
          links.splice(index, 1);
        }
      }
    }
    if (request.links) {
      for (const link of request.links) {
        const normalizedLabel =
          link.label === "github-pr" || link.label === "github_pr" ? "pr" : link.label;
        const normalizedLink = { ...link, label: normalizedLabel };
        const index = links.findIndex((entry) => entry.label === normalizedLabel);
        if (index === -1) {
          links.push(normalizedLink);
        } else {
          links[index] = normalizedLink;
        }
      }
    }
    const title = request.clearTitle
      ? undefined
      : request.setTitleIfAbsent && current?.title?.trim()
        ? current.title
        : (request.title ?? current?.title);
    const titleSource = request.clearTitle
      ? (request.source ?? "agent")
      : request.title !== undefined && title === request.title
        ? (request.source ?? "agent")
        : current?.titleSource;
    return title || links.length > 0 || titleSource !== undefined
      ? { ...(title ? { title } : {}), ...(titleSource ? { titleSource } : {}), links }
      : undefined;
  });
  applySlotsUpdateWithResultMock.mockReset().mockImplementation((current, request) => ({
    slots: applySlotsUpdateMock(current, request),
    result: {
      titleResult: request.clearTitle ? "cleared" : request.title ? "updated" : "unchanged",
    },
  }));
  applyNormalizedSlotsUpdateMock.mockReset().mockImplementation((current, update) => {
    const links = [...(current?.links ?? [])];
    for (const label of update.unlinkLabels ?? []) {
      const index = links.findIndex((link) => link.label === label);
      if (index !== -1) {
        links.splice(index, 1);
      }
    }
    for (const link of update.links ?? []) {
      const index = links.findIndex((entry) => entry.label === link.label);
      if (index === -1) {
        links.push(link);
      } else {
        links[index] = link;
      }
    }
    // Mirrors the real applyNormalizedSlotsUpdate (session-slots.ts):
    // a manual lock (titleSource === "manual") blocks any non-manual title
    // edit, and the once-only initializer check treats a title as already
    // present once titleSource is set at all, not only when literal title
    // text is non-empty.
    let title = current?.title;
    let titleSource = current?.titleSource;
    let titleResult: "unchanged" | "updated" | "cleared" | "blocked" = "unchanged";
    let message: string | undefined;
    const titleEditRequested = update.clearTitle || update.title !== undefined;
    const blockedTitleEdit = current?.titleSource === "manual" && update.source !== "manual";
    if (blockedTitleEdit && titleEditRequested) {
      titleResult = "blocked";
      message =
        "title editing unavailable because title was set manually; do not attempt title edits again.";
    } else if (update.clearTitle) {
      title = undefined;
      titleSource = update.source;
      titleResult = "cleared";
    } else if (update.title !== undefined) {
      const hasExistingTitle =
        Boolean(current?.title?.trim()) || current?.titleSource !== undefined;
      if (!update.setTitleIfAbsent || !hasExistingTitle) {
        title = update.title;
        titleSource = update.source;
        titleResult = "updated";
      }
    }
    const tagSet = new Set<string>(current?.tags ?? []);
    for (const tag of update.untags ?? []) {
      tagSet.delete(tag);
    }
    for (const tag of update.tags ?? []) {
      tagSet.add(tag);
    }
    const nextTags = [...tagSet];
    const slots =
      title || links.length > 0 || titleSource !== undefined || nextTags.length > 0
        ? {
            ...(title ? { title } : {}),
            ...(titleSource ? { titleSource } : {}),
            links,
            ...(nextTags.length > 0 ? { tags: nextTags } : {}),
          }
        : undefined;
    return {
      ...(slots ? { slots } : {}),
      result: {
        titleResult,
        ...(message ? { message } : {}),
      },
    };
  });
}

// afterEach body: drain and dispose every SessionService the test built.
export async function disposeSessionServiceHarness(): Promise<void> {
  for (const service of activeSessionServices.splice(0)) {
    // Drain fire-and-forget background spawns so their trailing writeSession calls
    // cannot bleed into the next test's re-pointed session store (shared "api-1" id).
    service.dispose();
    await service.settleBackgroundSpawns();
  }
  vi.clearAllTimers();
  rmSync(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
}

export type { SessionServiceInternals, TestAccount };
export {
  upsertConfigRegistryPathMock,
  addUnconfiguredProjectMock,
  removeUnconfiguredProjectMock,
  readConfigRegistryFileMock,
  mutateConfigRegistryMock,
  invalidateRemovedRegistryPathsMock,
  buildAgentLaunchPlanMock,
  buildAgentRestorePlanMock,
  buildAgentResumePlanMock,
  findAgentSessionIdMock,
  readAgentConversationMock,
  agentLaunchUsesForeignBinaryMock,
  agentSessionConfigMock,
  agentStateStrategyMock,
  agentWaitsForSubmitAckMock,
  agentSubmitAckPacingMock,
  agentEarlySubmitResendAllowedMock,
  agentHasLaunchSubmitAckMock,
  createAgentSubmitAckBindingMock,
  resumeAgentSubmitAckBindingMock,
  invalidateAgentStateMock,
  parseAgentNameMock,
  setupAgentHooksMock,
  captureOpenCodeSessionBaselineMock,
  resolveNewOpenCodeSessionIdMock,
  waitForOpenCodeLaunchMessageMock,
  withOpenCodeLaunchIdentityLockMock,
  readOpenCodeStateMock,
  readOpenCodeStructuredStateMock,
  resolveCursorLaunchModelMock,
  validateOpenCodeModelMock,
  resolveAgentReasoningEffortMock,
  deleteAgentHookStateMock,
  readAgentHookStateMock,
  loadConfigMock,
  loadProjectConfigMock,
  findProjectConfigPathInDirectoryMock,
  loadInstanceConfigReadOnlyMock,
  startDeploySwitchMock,
  getReleasesMock,
  getVersionMock,
  reserveNextSessionIdMock,
  listSessionsMock,
  archiveSessionsMock,
  readAvailableBacklogItemsMock,
  readSessionMock,
  writeSessionMock,
  requestGitHubMergeConflictRestoreReplayMock,
  clearGitHubPollDisabledSessionMock,
  listGitHubPollDisabledSourceIdsMock,
  deleteServiceInstancesForSessionMock,
  deleteTelegramSourceStateForSessionMock,
  deleteTelegramReplyTargetMock,
  hasPendingTelegramSendMock,
  listServiceInstancesForSessionMock,
  readServiceInstanceMock,
  writeServiceInstanceMock,
  serviceRecords,
  captureTmuxPaneMock,
  captureTmuxPaneOrEmptyMock,
  createTmuxSessionMock,
  createTmuxCommandSessionMock,
  createTmuxSidecarSessionMock,
  sweepLeakedPlaywrightMock,
  waitForPlaywrightReadyMock,
  resolvePlaywrightSidecarCommandMock,
  isHostPortFreeMock,
  clearPortListenerMock,
  readFreeKbMock,
  readDiskBudgetReportMock,
  measureDiskBudgetMock,
  realDuMock,
  hasEstablishedConnectionsMock,
  findListenerPidsMock,
  snapshotListenersMock,
  snapshotProcessesMock,
  sidecarTmuxAliveMock,
  listTmuxSessionNamesMock,
  getTmuxSessionActivityMock,
  getTmuxPanePidMock,
  lookupTmuxPanePidMock,
  getFleetSessionRssBytesMock,
  readHostMemoryMock,
  readCgroupPressureMock,
  readCgroupMemorySnapshotMock,
  isSystemdOomdPresentMock,
  isProcessRunningInTmuxMock,
  probeTmuxProcessMatchMock,
  killTmuxSessionMock,
  captureAgentProcessesForLaunchMock,
  capturePaneAgentProcessesMock,
  terminateAgentProcessesMock,
  findForeignAgentProcessesForSessionMock,
  killTmuxSessionTreeMock,
  sendMessageToTmuxMock,
  sendInterruptKeysToTmuxMock,
  sendSubmitKeyToTmuxMock,
  sendMenuSelectionKeysMock,
  tmuxPaneDeadMock,
  tmuxSessionExistsMock,
  getTmuxSessionPresenceMock,
  getTmuxPanePresenceMock,
  getSidecarTmuxPresenceMock,
  waitForTmuxReadyMock,
  createWorktreeMock,
  findWorktreePathForBranchMock,
  hasUncommittedChangesMock,
  isGitWorktreeMock,
  hasUnpushedCommitsMock,
  readCurrentBranchMock,
  removeWorktreeMock,
  pruneRepoWorktreesMock,
  resolveRepoPathFromWorktreeMock,
  branchRefsExistMock,
  workspaceExistsMock,
  probeWorkspaceMock,
  applySlotsUpdateMock,
  applyNormalizedSlotsUpdateMock,
  ensureSessionSlotToolMock,
  removeSessionSlotToolMock,
  withSessionSlotInstructionsMock,
  deleteSessionArtifactsExceptMock,
  deleteSessionArtifactByIdMock,
  listSessionArtifactsMock,
  readSessionArtifactMock,
  setSessionArtifactOriginMock,
  setSessionArtifactUserAddedMock,
  listSessionMemoryRecordsMock,
  getSessionMemoryRecordMock,
  setSessionMemoryRecordMock,
  resolveSessionMemoryRecordMock,
  listSharedMemoryKeysMock,
  getSharedMemoryMock,
  setSharedMemoryMock,
  removeSharedMemoryMock,
  withSharedMemoryInstructionsMock,
  runSpawnPreflightMock,
  MockPreflightBranchValidationError,
  logSpurEventMock,
  flushEventLogCollapseMock,
  tryRotateMock,
  readClaudeJsonlStateMock,
  readClaudeConversationTailMock,
  readClaudeSessionStatusMock,
  listAccountsMock,
  isAccountReadyMock,
  removeAccountMock,
  touchAccountUsedMock,
  ensureDefaultAccountMock,
  seedSessionHomeMock,
  swapSessionCredentialsMock,
  readCursorJsonlStateMock,
  readCursorTokenUsageMock,
  sendDesktopNotificationMock,
  captureCodexRolloutBaselineMock,
  readCodexRolloutStateMock,
  scanCodexRolloutForMessageMock,
  ghMock,
  TEST_ARTIFACTS_ROOT,
  artifactDirForSession,
  TEST_DATA_DIR,
  writeTelegramOfferMock,
  readInterfaceConsentMock,
  writeInterfaceConsentMock,
  consentPolicyMock,
  consentRepositoryMock,
  readTelegramBindingsMock,
  readTelegramReplyTargetMock,
  sendTelegramReplyMock,
  sendTelegramChatActionMock,
  editTelegramTopicMock,
  closeTelegramTopicMock,
  writeTelegramBindingsMock,
  writeTelegramReplyTargetMock,
  recordTelegramMessagesMock,
  timerPromisesSleepMock,
  mockTimerPromisesSleepWithFakeTimers,
  PINNED_CLAUDE_SESSION_ID,
  baseConfig,
  loadSessionServiceModule,
  clone,
  createSessionStore,
  serviceKey,
  mockClaudeJsonlState,
  mockClaudeSessionStatus,
  runningSession,
  sessionServiceInternals,
  SUBMITTED,
  SUBMIT_UNCONFIRMED,
};
