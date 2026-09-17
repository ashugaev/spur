// Fork of session-service.test.ts's mock/harness header, not a shared import.
// Deliberate: P2 needs agents/index.js partial-mocked via importOriginal, and
// session-service.test.ts mocks it with a literal factory instead; AC6
// forbids editing that file (its 1232 tests must stay green, untouched).
// Extracting a shared harness module would require editing it anyway. Keep
// this file's header in lockstep with session-service.test.ts by hand.
import type * as cryptoModule from "node:crypto";
import { randomUUID } from "node:crypto";
import type * as timersPromisesModule from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentProcessRef,
  AgentTerminationOutcome,
  SessionAgentScan,
} from "../../src/agent-processes.js";
import type * as eventLogModule from "../../src/event-log.js";
import type * as claudeJsonlStateModule from "../../src/claude-jsonl-state.js";
import type * as jsonlLogIoModule from "../../src/jsonl-log-io.js";
import type * as claudeModule from "../../src/agents/claude.js";
import type * as openCodeModule from "../../src/agents/opencode.js";
import type * as ghModule from "../../src/gh.js";
import type * as registryModule from "../../src/registry.js";
import type * as releasesCacheModule from "../../src/releases-cache.js";
import type * as sessionMemoryModule from "../../src/session-memory.js";
import type * as sharedMemoryModule from "../../src/shared-memory.js";
import type * as todoModule from "../../src/todo.js";
import type * as reapModule from "../../src/sidecars/reap.js";
import type * as runtimeTmuxModule from "../../src/runtime-tmux.js";
import type { ProcSnapshot } from "../../src/sidecars/reap.js";
import {
  type ServiceInstanceRecord,
  type SessionRecord,
  type SessionState,
} from "../../src/types.js";
// Type-only, so it never bypasses the mocked module registry below.
import type { AgentSendOutcome } from "../../src/session-service.js";
import type * as agentsIndexModule from "../../src/agents/index.js";
import type * as codexModule from "../../src/agents/codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type IsHostPortFree = (port: number) => Promise<boolean>;
type ClearPortListener = (port: number) => Promise<void>;
type HasEstablishedConnections = (port: number) => Promise<"established" | "none" | "unknown">;
type SnapshotProcesses = () => Promise<ProcSnapshot>;

const upsertConfigRegistryPathMock = vi.fn();
const addUnconfiguredProjectMock = vi.fn();
const removeUnconfiguredProjectMock = vi.fn();
const readConfigRegistryFileMock = vi.fn();
const mutateConfigRegistryMock = vi.fn();
const invalidateRemovedRegistryPathsMock = vi.fn();
const buildAgentLaunchPlanMock = vi.fn();
const buildAgentRestorePlanMock = vi.fn();
const buildAgentResumePlanMock = vi.fn();
const findAgentSessionIdMock = vi.fn();
const readAgentConversationMock = vi.fn();
const agentProcessMatchersMock = vi.fn();
const agentLaunchUsesForeignBinaryMock = vi.fn();
const agentBusyQueuedSendAwaitsPromptMock = vi.fn();
const agentQueuedSendPromptGraceMsMock = vi.fn();
const agentSessionConfigMock = vi.fn();
const agentStateStrategyMock = vi.fn();
const agentWaitsForSubmitAckMock = vi.fn();
const agentSubmitAckPacingMock = vi.fn();
const agentHasLaunchSubmitAckMock = vi.fn();
const createAgentSubmitAckBindingMock = vi.fn();
const parseAgentNameMock = vi.fn((agent: string) => agent);
const setupAgentHooksMock = vi.fn();
const captureOpenCodeSessionBaselineMock = vi.fn();
const resolveNewOpenCodeSessionIdMock = vi.fn();
const readOpenCodeStateMock = vi.fn();
const resolveCursorLaunchModelMock = vi.fn(
  async (model: string | undefined): Promise<string | undefined> => model,
);
const validateOpenCodeModelMock = vi.fn(async (model: string): Promise<string> => model);
const deleteAgentHookStateMock = vi.fn();
const readAgentHookStateMock = vi.fn();
const loadConfigMock = vi.fn();
const loadProjectConfigMock = vi.fn();
const findProjectConfigPathInDirectoryMock = vi.fn();
// Only reached by the auto-update wiring tests (issue #754): every other
// test's fake-timer advances never reach REAP_INTERVAL_MS, so these mocks
// are never invoked by them (see session-service.test.ts's own timer-advance
// ceiling of 1_000ms elsewhere in this file).
const loadInstanceConfigReadOnlyMock = vi.fn();
const startDeploySwitchMock = vi.fn();
const getReleasesMock = vi.fn();
const getVersionMock = vi.fn();
const reserveNextSessionIdMock = vi.fn();
const listSessionsMock = vi.fn();
const archiveSessionsMock = vi.fn(() => ({ archivedIds: [], archiveDir: "/tmp/sessions-archive" }));
const readAvailableBacklogItemsMock = vi.fn();
const readSessionMock = vi.fn();
const writeSessionMock = vi.fn();
const requestGitHubMergeConflictRestoreReplayMock = vi.fn();
const deleteServiceInstanceMock = vi.fn();
const deleteServiceInstancesForSessionMock = vi.fn();
const deleteRuntimeLogCursorsForSessionMock = vi.fn();
const deleteServiceSourceStatesForServiceMock = vi.fn();
const deleteServiceSourceStatesForSessionMock = vi.fn();
const deleteTelegramSourceStateForSessionMock = vi.fn();
const listActiveServiceProblemsMock = vi.fn();
const listServiceInstancesMock = vi.fn();
const listServiceInstancesForSessionMock = vi.fn();
const readServiceInstanceMock = vi.fn();
const writeServiceInstanceMock = vi.fn();
const serviceRecords = new Map<string, ServiceInstanceRecord>();
const captureTmuxPaneMock = vi.fn(() => Promise.resolve(""));
const createTmuxSessionMock = vi.fn();
const createTmuxCommandSessionMock = vi.fn();
const createTmuxSidecarSessionMock = vi.fn();
const sweepLeakedPlaywrightMock = vi.fn();
const waitForPlaywrightReadyMock = vi.fn();
const resolvePlaywrightSidecarCommandMock = vi.fn<() => string | undefined>();
const isHostPortFreeMock = vi.fn<IsHostPortFree>().mockResolvedValue(true);
const clearPortListenerMock = vi.fn<ClearPortListener>().mockResolvedValue(undefined);
const readFreeKbMock = vi.fn<(path: string, timeoutMs?: number) => Promise<number | undefined>>();
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
const sidecarTmuxAliveMock = vi.fn();
const refreshTmuxFleetSnapshotMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const sidecarTmuxSessionMock = vi.fn((id: string, name: string) => `${id}--${name}`);
const listTmuxSessionNamesMock = vi.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set());
const getTmuxSessionActivityMock = vi.fn();
const getTmuxPanePidMock = vi.fn(() => Promise.resolve<number | null>(null));
const lookupTmuxPanePidMock = vi.fn(() =>
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
const readCgroupPressureMock = vi.fn();
const readCgroupMemorySnapshotMock = vi.fn();
const isSystemdOomdPresentMock = vi.fn();
const isProcessRunningInTmuxMock = vi.fn();
// Defaults to delegating to isProcessRunningInTmuxMock (see beforeEach) so
// every existing isProcessRunningInTmuxMock-driven test keeps controlling
// probeAgentProcess's single probeTmuxProcessMatch call unchanged. A test
// that needs to express a genuine matcher/pane_child disagreement (alive
// true, matchedByName false) overrides this mock directly instead — a plain
// boolean delegate cannot produce that shape.
const probeTmuxProcessMatchMock =
  vi.fn<
    (
      sessionName: string,
      matchers: string[],
      options?: { fresh?: boolean; paneChildFallback?: boolean },
    ) => Promise<{ alive: boolean; matchedByName: boolean }>
  >();
const killTmuxSessionMock = vi.fn();
const capturePaneAgentProcessesMock = vi.fn(() =>
  Promise.resolve<{ status: "ok"; processes: AgentProcessRef[] } | { status: "unavailable" }>({
    status: "ok",
    processes: [],
  }),
);
const terminateAgentProcessesMock = vi.fn(() =>
  Promise.resolve<AgentTerminationOutcome>({ status: "clear" }),
);
// "unavailable" is the safe default: it is what a real host without a
// readable process environment (e.g. macOS, or a CI sandbox without procfs)
// returns, and matches the P2 guard's own never-blocks-on-what-it-cannot-see
// contract, so no unrelated restore/relaunch/switchAuth test below has to
// know this guard exists.
const findForeignAgentProcessesForSessionMock = vi.fn(() =>
  Promise.resolve<SessionAgentScan>({ status: "unavailable" }),
);
const killTmuxSessionTreeMock = vi.fn();
const sendMessageToTmuxMock = vi.fn();
const sendSensitiveMessageToTmuxMock = vi.fn();
const sendSubmitKeyToTmuxMock = vi.fn();
const sendMenuSelectionKeysMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();
const tmuxPaneDeadMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
// Default implementations delegate to tmuxSessionExistsMock/tmuxPaneDeadMock
// so every existing call site that drives readRuntimeSnapshot's behavior
// through those two mocks keeps working unchanged; `unresponsive` defaults to
// false and is overridden per-test only where a timeout-kill scenario is
// exercised (see the probe_unresponsive/AC9/AC10 tests).
// Forwards `options` only when the caller actually passed it, matching the
// arity of every existing direct tmuxSessionExists/tmuxPaneDead call site so
// mock.calls assertions written against those two mocks don't have to change.
const getTmuxSessionPresenceMock = vi.fn(async (name: string, options?: { fresh?: boolean }) => ({
  present: await (options ? tmuxSessionExistsMock(name, options) : tmuxSessionExistsMock(name)),
  unresponsive: false,
}));
const getTmuxPanePresenceMock = vi.fn(async (name: string, options?: { fresh?: boolean }) => ({
  dead: await (options ? tmuxPaneDeadMock(name, options) : tmuxPaneDeadMock(name)),
  unresponsive: false,
}));
const waitForTmuxReadyMock = vi.fn();
const createWorktreeMock = vi.fn();
const findWorktreePathForBranchMock = vi.fn();
const hasUncommittedChangesMock = vi.fn();
const isGitWorktreeMock = vi.fn();
const hasUnpushedCommitsMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const readRemoteUrlsMock = vi.fn();
const removeWorktreeMock = vi.fn();
const pruneRepoWorktreesMock = vi.fn();
const resolveRepoPathFromWorktreeMock = vi.fn();
const branchRefsExistMock = vi.fn();
const workspaceExistsMock = vi.fn();
const probeWorkspaceMock = vi.fn();
const applySlotsUpdateMock = vi.fn();
const normalizeSlotLinksMock = vi.fn();
const ensureSessionSlotToolMock = vi.fn();
const removeSessionSlotToolMock = vi.fn();
const withSessionSlotInstructionsMock = vi.fn();
const deleteSessionArtifactsExceptMock = vi.fn();
const deleteSessionArtifactByIdMock = vi.fn();
const listSessionArtifactsMock = vi.fn();
const readSessionArtifactMock = vi.fn();
const setSessionArtifactOriginMock = vi.fn();
const setSessionArtifactUserAddedMock = vi.fn();
const listSessionMemoryRecordsMock = vi.fn();
const getSessionMemoryRecordMock = vi.fn();
const setSessionMemoryRecordMock = vi.fn();
const resolveSessionMemoryRecordMock = vi.fn();
const listSharedMemoryKeysMock = vi.fn();
const getSharedMemoryMock = vi.fn();
const setSharedMemoryMock = vi.fn();
const removeSharedMemoryMock = vi.fn();
const withSharedMemoryInstructionsMock = vi.fn();
const runSpawnPreflightMock = vi.fn();
class MockPreflightBranchValidationError extends Error {
  constructor(
    readonly branch: string,
    regex: string,
  ) {
    super(`preflight branch "${branch}" must match ${regex}`);
    this.name = "PreflightBranchValidationError";
  }
}
const logSpurEventMock = vi.fn();
const flushEventLogCollapseMock = vi.fn();
const tryRotateMock = vi.fn();
const readClaudeJsonlStateMock = vi.fn();
const readClaudeConversationTailMock = vi.fn();
const readClaudeSessionStatusMock = vi.fn();
const listAccountsMock = vi.fn();
const findAccountMock = vi.fn();
const isAccountAuthenticatedMock = vi.fn();
const isAccountReadyMock = vi.fn();
const addAccountMock = vi.fn();
const removeAccountMock = vi.fn();
const touchAccountUsedMock = vi.fn();
const ensureDefaultAccountMock = vi.fn();
const seedSessionHomeMock = vi.fn();
const swapSessionCredentialsMock = vi.fn();

interface TestAccount {
  id: string;
  label?: string;
  configDir: string;
  createdAt: string;
  lastUsedAt?: string;
  authenticated: boolean;
}
let testAccounts: TestAccount[] = [];
function resetAccountStoreMocks(): void {
  testAccounts = [];
  listAccountsMock.mockReset().mockImplementation(() => testAccounts);
  findAccountMock
    .mockReset()
    .mockImplementation((_dataDir: string, id: string) => testAccounts.find((a) => a.id === id));
  isAccountAuthenticatedMock
    .mockReset()
    .mockImplementation((account: TestAccount) => account.authenticated);
  isAccountReadyMock
    .mockReset()
    .mockImplementation((account: TestAccount) => account.authenticated);
  touchAccountUsedMock.mockReset().mockImplementation((_dataDir: string, id: string) => {
    const account = testAccounts.find((a) => a.id === id);
    if (account) account.lastUsedAt = "2026-03-18T10:05:00.000Z";
  });
  addAccountMock.mockReset();
  removeAccountMock.mockReset();
  ensureDefaultAccountMock.mockReset();
  seedSessionHomeMock.mockReset();
  swapSessionCredentialsMock.mockReset();
}
const readCursorJsonlStateMock = vi.fn();
const sendDesktopNotificationMock = vi.fn();
const findLatestClaudeSessionFileMock = vi.fn();
const codexHookHomePathMock = vi.fn((sessionToolDir: string) => `${sessionToolDir}/codex-home`);
const captureCodexRolloutBaselineMock = vi.fn();
const findLatestCodexSessionFileMock = vi.fn();
const readCodexRolloutStateMock = vi.fn();
const scanCodexRolloutForMessageMock = vi.fn();
const ghMock = vi.fn();
const TEST_ARTIFACTS_ROOT = resolve(`/tmp/spur-session-artifacts-test-${process.pid}`);
const artifactDirForSession = (sessionId: string) => resolve(TEST_ARTIFACTS_ROOT, sessionId);
let TEST_DATA_DIR = resolve(`/tmp/spur-session-service-test-${process.pid}`);

const readTelegramBindingsMock = vi.fn();
const readTelegramReplyTargetMock = vi.fn();
const sendTelegramReplyMock = vi.fn();
const editTelegramTopicMock = vi.fn();
const closeTelegramTopicMock = vi.fn();
const writeTelegramBindingsMock = vi.fn();
const writeTelegramReplyTargetMock = vi.fn();
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
  readCursorJsonlState: readCursorJsonlStateMock,
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
    readOpenCodeState: readOpenCodeStateMock,
  };
});

const PINNED_CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000000";
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof cryptoModule>();
  return {
    ...actual,
    randomUUID: vi.fn(() => PINNED_CLAUDE_SESSION_ID),
  };
});

// Partial mock, P2: importOriginal so the real DEFERRED_CONTROLS_ACK_WINDOW_MS
// (v2/src/agents/index.ts) flows into session-service.ts unmocked. A literal
// factory here (as session-service.test.ts uses) would make AC7 assert the
// test's own literal instead of the source constant.
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
  agentQueuedSendPromptGraceMs: agentQueuedSendPromptGraceMsMock,
  agentSessionConfig: agentSessionConfigMock,
  agentStateStrategy: agentStateStrategyMock,
  agentWaitsForSubmitAck: agentWaitsForSubmitAckMock,
  agentSubmitAckPacing: agentSubmitAckPacingMock,
  agentHasLaunchSubmitAck: agentHasLaunchSubmitAckMock,
  createAgentSubmitAckBinding: createAgentSubmitAckBindingMock,
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
// test in this file.
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

vi.mock("../../src/telegram-source-state.js", () => ({
  sendTelegramReply: sendTelegramReplyMock,
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
  archiveSessions: archiveSessionsMock,
  deleteRuntimeLogCursorsForSession: deleteRuntimeLogCursorsForSessionMock,
  deleteServiceInstance: deleteServiceInstanceMock,
  deleteServiceInstancesForSession: deleteServiceInstancesForSessionMock,
  deleteServiceSourceStatesForService: deleteServiceSourceStatesForServiceMock,
  deleteServiceSourceStatesForSession: deleteServiceSourceStatesForSessionMock,
  deleteTelegramSourceStateForSession: deleteTelegramSourceStateForSessionMock,
  listActiveServiceProblems: listActiveServiceProblemsMock,
  listServiceInstances: listServiceInstancesMock,
  listServiceInstancesForSession: listServiceInstancesForSessionMock,
  listSessions: listSessionsMock,
  readAvailableBacklogItems: readAvailableBacklogItemsMock,
  readServiceInstance: readServiceInstanceMock,
  readSession: readSessionMock,
  readTelegramBindings: readTelegramBindingsMock,
  readTelegramReplyTarget: readTelegramReplyTargetMock,
  requestGitHubMergeConflictRestoreReplay: requestGitHubMergeConflictRestoreReplayMock,
  writeTelegramBindings: writeTelegramBindingsMock,
  writeTelegramReplyTarget: writeTelegramReplyTargetMock,
  writeServiceInstance: writeServiceInstanceMock,
  writeSession: writeSessionMock,
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

// Partial-mocked (not the literal factory session-service.test.ts uses):
// this file's agents/index.js mock below loads the REAL module via
// importOriginal (P2), whose top-level AGENT_ADAPTERS object literal reads
// codexCommand/buildCodexPlan/etc. from this module eagerly, so a literal
// mock missing those names throws "No export is defined" at import time.
vi.mock("../../src/agents/codex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof codexModule>();
  return {
    ...actual,
    codexHookHomePath: codexHookHomePathMock,
    captureCodexRolloutBaseline: captureCodexRolloutBaselineMock,
    findLatestCodexSessionFile: findLatestCodexSessionFileMock,
    readCodexRolloutState: readCodexRolloutStateMock,
    scanCodexRolloutForMessage: scanCodexRolloutForMessageMock,
  };
});

vi.mock("../../src/agents/models.js", () => ({
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
}));

vi.mock("../../src/disk-space.js", () => ({
  readFreeKb: readFreeKbMock,
  DISK_PROBE_TIMEOUT_MS: 2_000,
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
    captureTmuxPane: captureTmuxPaneMock,
    createTmuxSession: createTmuxSessionMock,
    createTmuxCommandSession: createTmuxCommandSessionMock,
    createTmuxSidecarSession: createTmuxSidecarSessionMock,
    sidecarTmuxAlive: sidecarTmuxAliveMock,
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
    sendSensitiveMessageToTmux: sendSensitiveMessageToTmuxMock,
    sendSubmitKeyToTmux: sendSubmitKeyToTmuxMock,
    sendMenuSelectionKeys: sendMenuSelectionKeysMock,
    tmuxPaneDead: tmuxPaneDeadMock,
    tmuxSessionExists: tmuxSessionExistsMock,
    waitForTmuxReady: waitForTmuxReadyMock,
  };
});

vi.mock("../../src/agent-processes.js", () => ({
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

vi.mock("../../src/session-slots.js", () => ({
  AGENT_STATE_TOOL_NAME: "spur-agent-state",
  SELF_DESTRUCT_TOOL_NAME: "spur-self-destruct",
  SLOT_TOOL_NAME: "spur-slots",
  TODO_TOOL_NAME: "spur-todo",
  applySlotsUpdate: applySlotsUpdateMock,
  ensureSessionSlotTool: ensureSessionSlotToolMock,
  normalizeSlotsUpdate: vi.fn(
    (request: {
      title?: string;
      clearTitle?: boolean;
      setTitleIfAbsent?: boolean;
      links?: Array<{ label: string; url: string }>;
      unlinkLabels?: string[];
      tags?: string[];
      untags?: string[];
    }) => ({
      ...(request.title !== undefined ? { title: request.title } : {}),
      clearTitle: request.clearTitle === true,
      ...(request.setTitleIfAbsent === true ? { setTitleIfAbsent: true } : {}),
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

async function loadSessionServiceModule() {
  vi.resetModules();
  const module = await import("../../src/session-service.js");
  const BaseSessionService = module.SessionService;
  class TrackedSessionService extends BaseSessionService {
    constructor(...args: ConstructorParameters<typeof BaseSessionService>) {
      super(...args);
      activeSessionServices.push(this);
    }
  }
  return { ...module, SessionService: TrackedSessionService };
}

// workspace-store.js transitively imports the mocked metadata.js, so — like
// session-service.js — it must be loaded dynamically, after this file's
// top-level `vi.fn()` mocks have run, never as a static top-level import.
function clone<T>(value: T): T {
  return structuredClone(value);
}

function createSessionStore() {
  const sessions = new Map<string, SessionRecord>();
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
    return session ? clone(session) : null;
  });
  writeSessionMock.mockImplementation((_dataDir: string, session: SessionRecord) => {
    sessions.set(session.id, clone(session));
  });
  listSessionsMock.mockImplementation(() =>
    [...sessions.values()].map((session) => {
      const json = JSON.stringify(session);
      const existing = published.get(session.id);
      if (existing && existing.json === json) {
        return existing.record;
      }
      const record = clone(session);
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

function mockClaudeJsonlState(state: string, options?: { lastMtimeMs?: number }) {
  readClaudeJsonlStateMock.mockResolvedValue({
    state,
    reader: {
      filePath: "test.jsonl",
      lastOffset: 0,
      lastMtimeMs: options?.lastMtimeMs ?? 0,
      tailRecords: [],
    },
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
  lastHumanHeldNudgeRevisions: Map<string, string>;
  pruneSessionScopedState(liveIds: ReadonlySet<string>): void;
  waitForSubmitAck(
    binding: { scan(text: string): Promise<{ found: boolean; lastScannedFile: string | null }> },
    messageText: string,
    windowMs: number,
  ): Promise<{ found: boolean; lastScannedFile: string | null }>;
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
    options?: { interrupt?: boolean; freshLaunch?: boolean },
  ): Promise<AgentSendOutcome>;
  writeAgentMessage: SessionServiceInternals["sendAgentMessage"];
  enrichDashboard(session: SessionRecord): Promise<{ id: string; model?: string }>;
  classifySessionRecord(
    session: SessionRecord,
    options?: { scanPane?: boolean },
  ): Promise<{ state: SessionState; session: SessionRecord }>;
  codexMcpDialogOverrides: Map<string, number>;
  claudeCompactingOverrides: Map<string, number>;
  cursorPaneReadyOverrides: Map<string, number>;
  lastClassifiedLogStates: Map<string, SessionState>;
  paneWriteLocks: Map<string, Promise<void>>;
  deliveryRuns: Map<string, Promise<void>>;
  queueDeliveryInFlight: Set<string>;
  tryDeliverQueuedMessage(sessionId: string): Promise<boolean>;
  maybeNudgeTodo(session: SessionRecord): Promise<void>;
  confirmAgentExited(
    session: Pick<SessionRecord, "id" | "tmuxSession" | "agent" | "launchCommand">,
  ): Promise<boolean>;
  runAttentionMonitor(baseline: boolean): Promise<void>;
  pollAttentionStates(baseline: boolean): Promise<void>;
  attentionMonitorRunning: boolean;
  attentionMonitorSuppressedTicks: number;
  todoNudgeDisabled: Map<string, { kind: "ledger_corrupt" | "target_gone"; reason: string }>;
  todoNudgeBackoff: Map<string, { failures: number; nextRetryAtMs: number }>;
  scheduleHealedSidecarRestart(session: SessionRecord): void;
  sidecarHealTasks: Map<string, Promise<void>>;
};

function sessionServiceInternals(service: unknown): SessionServiceInternals {
  return service as SessionServiceInternals;
}

// Typed, because vitest's `toBe` accepts any expected value: renaming an outcome
// in the source has to fail this file's typecheck, not only its next run.
const SUBMIT_UNCONFIRMED: AgentSendOutcome = "submit_unconfirmed";

describe("SessionService", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));
    // `claudeCommand()` is unmocked here, so an ambient override would leak into
    // launch-command assertions. Same reason agents-claude.test.ts clears it.
    delete process.env["SPUR_CLAUDE_BIN"];
    TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "spur-session-service-"));
    vi.mocked(randomUUID).mockReset().mockReturnValue(PINNED_CLAUDE_SESSION_ID);
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
    const timersPromises =
      await vi.importActual<typeof timersPromisesModule>("node:timers/promises");
    timerPromisesSleepMock.mockReset().mockImplementation((ms) => timersPromises.setTimeout(ms));
    rmSync(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
    resetAccountStoreMocks();

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
        (
          agent: string,
          initialMessage: string,
          options?: { planMode?: boolean },
          deferredSensitiveInitialMessage?: { text: string; sensitive: true },
        ) => ({
          agent,
          launchCommand:
            agent === "codex"
              ? "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust"
              : options?.planMode
                ? "claude --dangerously-skip-permissions --permission-mode plan"
                : "claude --dangerously-skip-permissions",
          initialMessage,
          readyMarkers: agent === "codex" ? ["OpenAI Codex", "›"] : ["Claude Code", "❯"],
          ...(deferredSensitiveInitialMessage ? { deferredSensitiveInitialMessage } : {}),
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
    readOpenCodeStateMock.mockReset().mockResolvedValue(null);
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
    agentHasLaunchSubmitAckMock
      .mockReset()
      .mockImplementation((agent: string) => agent === "claude");
    agentSubmitAckPacingMock
      .mockReset()
      .mockImplementation((agent: string, options?: { freshLaunch?: boolean }) => {
        if (agent === "claude" && options?.freshLaunch === true) {
          return { windowMs: 5_000, maxResends: 2 };
        }
        return agent === "cursor"
          ? { windowMs: 5_000, maxResends: 12 }
          : { windowMs: 300_000, maxResends: 2 };
      });
    captureCodexRolloutBaselineMock.mockReset().mockResolvedValue(new Map());
    scanCodexRolloutForMessageMock
      .mockReset()
      .mockResolvedValue({ found: true, lastScannedFile: null });
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
    loadConfigMock.mockReset().mockReturnValue(baseConfig());
    readTelegramBindingsMock.mockReset().mockReturnValue(new Map());
    readTelegramReplyTargetMock.mockReset().mockReturnValue(null);
    sendTelegramReplyMock.mockReset().mockResolvedValue({});
    editTelegramTopicMock.mockReset().mockResolvedValue(undefined);
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
    requestGitHubMergeConflictRestoreReplayMock.mockReset();
    deleteServiceInstanceMock.mockReset();
    deleteServiceInstancesForSessionMock.mockReset();
    deleteRuntimeLogCursorsForSessionMock.mockReset();
    deleteServiceSourceStatesForServiceMock.mockReset();
    deleteServiceSourceStatesForSessionMock.mockReset();
    deleteTelegramSourceStateForSessionMock.mockReset();
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
    createTmuxCommandSessionMock.mockReset().mockResolvedValue(undefined);
    createTmuxSidecarSessionMock.mockReset().mockResolvedValue(undefined);
    sweepLeakedPlaywrightMock.mockReset().mockResolvedValue(0);
    waitForPlaywrightReadyMock.mockReset().mockResolvedValue(true);
    resolvePlaywrightSidecarCommandMock.mockReset().mockReturnValue(undefined);
    clearPortListenerMock.mockReset().mockResolvedValue(undefined);
    isHostPortFreeMock.mockReset().mockResolvedValue(true);
    hasEstablishedConnectionsMock.mockReset().mockResolvedValue("none");
    findListenerPidsMock.mockReset().mockResolvedValue([]);
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
    getTmuxSessionActivityMock.mockReset().mockResolvedValue(new Date("2026-03-18T10:04:30.000Z"));
    getTmuxPanePidMock.mockReset().mockResolvedValue(null);
    lookupTmuxPanePidMock.mockReset().mockResolvedValue({ status: "ok", panePid: null });
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
        return { alive, matchedByName: alive };
      });
    killTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    capturePaneAgentProcessesMock.mockReset().mockResolvedValue({ status: "ok", processes: [] });
    terminateAgentProcessesMock.mockReset().mockResolvedValue({ status: "clear" });
    findForeignAgentProcessesForSessionMock
      .mockReset()
      .mockResolvedValue({ status: "unavailable" });
    killTmuxSessionTreeMock.mockReset().mockResolvedValue(true);
    sendMessageToTmuxMock.mockReset().mockResolvedValue(undefined);
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
          normalizedLabel === "github-pr" || normalizedLabel === "github_pr"
            ? "pr"
            : normalizedLabel;
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
      return title || links.length > 0 ? { ...(title ? { title } : {}), links } : undefined;
    });
  });

  afterEach(async () => {
    for (const service of activeSessionServices.splice(0)) {
      // Drain fire-and-forget background spawns so their trailing writeSession calls
      // cannot bleed into the next test's re-pointed session store (shared "api-1" id).
      await service.settleBackgroundSpawns();
      service.dispose();
    }
    vi.clearAllTimers();
    rmSync(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // spur-f68f: deferred-controls-ack fix.
  // P1 — createAgentSubmitAckBindingMock defaults to null for every agent but
  // codex (session-service.test.ts:1439-1444), and a null binding returns
  // "submitted" before any scan. Every case below overrides it to a live,
  // non-acking binding. P2 — the module-level vi.mock("../../src/agents/index.js",
  // ...) above this describe partial-mocks via importOriginal, so the real
  // DEFERRED_CONTROLS_ACK_WINDOW_MS (5_000) flows through unmocked while
  // agentSubmitAckPacingMock still returns 300_000 for claude. P3 — liveness is
  // driven through isProcessRunningInTmuxMock, the only lever over the
  // module-private agentProcessAlive. P4 — assertions read logSpurEventMock
  // (pre-redaction), never the on-disk event log.
  describe("deferred controls ack", () => {
    type DeferredInternals = {
      sendDeferredSensitiveInitialMessage(
        session: Pick<
          SessionRecord,
          "id" | "tmuxSession" | "agent" | "launchCommand" | "worktreePath" | "agentSessionId"
        >,
        message: string,
      ): Promise<AgentSendOutcome>;
    };

    function deferredInternals(service: unknown): DeferredInternals {
      return service as unknown as DeferredInternals;
    }

    // The controls text (containing ap1_) never acks, so the deferred scan
    // times out; any other text (an ordinary body send) acks immediately, so
    // AC2's real deliver() call does not also time out on its unrelated body
    // leg, which deliver() never recovers (invariant: deliver()'s body leg
    // keeps its current non-recovering semantics).
    function primeLiveNonAckingBinding(
      lastScannedFile: string | null = "/some/claude.jsonl",
    ): void {
      createAgentSubmitAckBindingMock.mockResolvedValue({
        scan: vi.fn().mockImplementation(async (text: string) => ({
          found: !text.includes("ap1_"),
          lastScannedFile,
        })),
      });
    }

    function controlsMessage(): string {
      return `unsubscribe ${"ap1_" + "a".repeat(43)}`;
    }

    it("AC1: live agent that never acks treats controls as delivered with exactly one warn event", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).resolves.toBe(SUBMIT_UNCONFIRMED);

      const recoveredEvents = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event === "session.controls.delivery_recovered");
      expect(recoveredEvents).toHaveLength(1);
      expect(recoveredEvents[0]?.level).toBe("warn");
      expect(
        logSpurEventMock.mock.calls.filter(([, entry]) => entry.level === "error"),
      ).toHaveLength(0);
      service.dispose();
    });

    it("AC2: a real deliver() whose controls leg times out on a live agent does not fail and does not re-send the body", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      mockClaudeSessionStatus("waiting", "idle");
      mockClaudeJsonlState("waiting");
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      sendMessageToTmuxMock.mockClear();

      await expect(
        service.deliver("api-1", "the task body", { sensitivePromptSuffix: controlsMessage() }),
      ).resolves.toBeDefined();
      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("AC3: a genuinely dead agent rejects with a typed SubmitAckTimeoutError and this method emits no event of its own", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(false);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).rejects.toMatchObject({ name: "SubmitAckTimeoutError", processAlive: false });

      // Filtered, not a raw before/after call-count delta: the SessionService
      // constructor fires unawaited background ticks that can log later and
      // bleed into a plain counter. Scoped to this method's own event surface
      // (session.controls.*) so an unrelated background event never fails
      // this assertion for the wrong reason.
      const ownEvents = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event.startsWith("session.controls."));
      expect(ownEvents).toHaveLength(0);
      service.dispose();
    });

    it("AC3b: spawn survives a live controls ack timeout; a dead agent still fails spawn", async () => {
      mockClaudeJsonlState("waiting");
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const liveService = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const view = await liveService.spawn(
        { project: "api", prompt: "hello" },
        { sensitivePromptSuffix: controlsMessage() },
      );
      expect(view.id).toBe("api-1");
      const sentEvents = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event === "session.spawn.sensitive_controls_sent");
      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0]?.details?.outcome).toBe("submit_unconfirmed");
      expect(killTmuxSessionMock).not.toHaveBeenCalled();
      liveService.dispose();

      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(false);
      const { SessionService: DeadSessionService } = await loadSessionServiceModule();
      const deadService = new DeadSessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      await expect(
        deadService.spawn(
          { project: "api", prompt: "hello" },
          { sensitivePromptSuffix: controlsMessage() },
        ),
      ).rejects.toThrow();
      deadService.dispose();
    });

    // Safety criteria, NOT a proof of the fix (they already hold against
    // unmodified source; the details key-set assertion is the one part that
    // constrains the new code).
    it("AC4: no ap1_ handle reaches an event payload or a persisted session write, and the event details key set is exact", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const handle = "ap1_" + "a".repeat(43);

      await deferredInternals(service).sendDeferredSensitiveInitialMessage(
        runningSession(),
        `unsubscribe ${handle}`,
      );

      expect(JSON.stringify(logSpurEventMock.mock.calls)).not.toContain(handle);
      const recovered = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .find((entry) => entry.event === "session.controls.delivery_recovered");
      expect(recovered).toBeDefined();
      expect(Object.keys(recovered?.details ?? {}).sort()).toEqual([
        "agent",
        "controlCount",
        "elapsedMs",
        "lastScannedFile",
        "processAlive",
      ]);
      expect(JSON.stringify(writeSessionMock.mock.calls)).not.toContain(handle);
      service.dispose();
    });

    it("AC5: no bare-Enter resend on the deferred path, live and dead", async () => {
      primeLiveNonAckingBinding();
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      await deferredInternals(service).sendDeferredSensitiveInitialMessage(
        runningSession(),
        controlsMessage(),
      );
      expect(sendSubmitKeyToTmuxMock).not.toHaveBeenCalled();

      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(false);
      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).rejects.toThrow();
      expect(sendSubmitKeyToTmuxMock).not.toHaveBeenCalled();
      service.dispose();
    });

    it("AC7: the deferred scan window is the short constant, not pacing.windowMs", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      // Claude's non-fresh-launch pacing is 300_000 (session-service.test.ts
      // :1425-1434 default); the deferred path must not use it.
      agentSubmitAckPacingMock.mockReset().mockReturnValue({ windowMs: 300_000, maxResends: 2 });
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck");

      await deferredInternals(service).sendDeferredSensitiveInitialMessage(
        runningSession(),
        controlsMessage(),
      );

      expect(waitSpy).toHaveBeenCalledWith(expect.anything(), expect.any(String), 5_000);
      service.dispose();
    });
  });
});
