#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancel, isCancel, log, text } from "@clack/prompts";
import { Command, type Help } from "commander";
import { buildAgentRestorePlan } from "./agents/index.js";
import {
  connectProjectConfig,
  disconnectProjectConfig,
  getJson,
  listProjects,
  postJson,
  postPreflight,
  restartDaemonIfRunning,
  stopDaemonIfRunning,
  type RestartDaemonResult,
  type StopDaemonResult,
} from "./client.js";
import {
  defaultVoiceModelPath,
  ensureInstanceConfig,
  findProjectConfigPath,
  loadConfig,
  loadProjectConfig,
} from "./config.js";
import { readSessionEventLog, type SpurLogEntry } from "./event-log.js";
import {
  accent,
  brandMark,
  brandLine,
  boldText,
  dimText,
  renderSessionDashboard,
  renderServiceCard,
  renderServiceList,
  renderRuntimeInfo,
  renderSessionCard,
  renderInteractiveSessionList,
  renderWaitingInputAlert,
  withSpinner,
} from "./cli-view.js";
import { writeStderr, writeStdout } from "./io.js";
import { sortSessionsForList } from "./session-display.js";
import {
  buildRestorePrompt,
  isKillConfirmationRequiredMessage,
  isRestorableSession,
} from "./session-service.js";
import { sidecarTmuxSession, setTmuxSocketName, withTmuxSocketArgs } from "./runtime-tmux.js";
import { startServer } from "./server.js";
import type {
  ProjectConfigMutationResponse,
  RespawnSessionRequest,
  RuntimeInfo,
  RunServiceRequest,
  SendMessageRequest,
  SessionLink,
  ServiceInstanceView,
  SessionView,
  SpawnSessionRequest,
  UpdateSessionSlotsRequest,
} from "./types.js";

const LIVE_LIST_REFRESH_MS = 2_000;
const LIST_FIXED_ROWS = 9;
const LIST_MIN_SESSION_ROWS = 4;
const LIST_MAX_DETAIL_ROWS = 6;
const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[H\u001b[?25l";
const EXIT_ALT_SCREEN = "\u001b[?25h\u001b[?1049l";
const RESELECT_MESSAGE = "No session selected. Use ↑↓ to reselect first.";
const SESSION_LOG_EVENT_LIMIT = 16;
const SESSION_LOG_OUTPUT_LINES = 16;
const SESSION_LOG_LOCAL_LIMIT = 8;

function enableTmuxMouse(sessionName: string): void {
  try {
    execFileSync("tmux", withTmuxSocketArgs(["set-option", "-t", sessionName, "mouse", "on"]), {
      stdio: "ignore",
    });
  } catch {
    // Best effort only.
  }
}

function isInsideTmuxSession(): boolean {
  return Boolean(process.env["TMUX"]);
}

function tmuxOutput(args: string[]): string {
  return execFileSync("tmux", withTmuxSocketArgs(args), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function captureTmuxTarget(sessionName: string, lines = 200): string {
  return execFileSync(
    "tmux",
    withTmuxSocketArgs(["capture-pane", "-t", `=${sessionName}:`, "-p", "-S", `-${lines}`]),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trimEnd();
}

function tryCaptureTmuxTarget(sessionName: string, lines = 200): string | null {
  try {
    return captureTmuxTarget(sessionName, lines);
  } catch {
    return null;
  }
}

function currentTmuxSessionHasAttachedClient(): boolean {
  return tmuxOutput(["display-message", "-p", "#{session_attached}"]) !== "0";
}

function attachTmuxTargetFromList(targetSession: string): void {
  const target = `=${targetSession}`;
  if (!isInsideTmuxSession()) {
    execFileSync("tmux", withTmuxSocketArgs(["attach-session", "-t", target]), {
      stdio: "inherit",
    });
    return;
  }

  const controllerSession = tmuxOutput(["display-message", "-p", "#{session_name}"]);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const returnTable = `spur-return-${suffix}`;
  const returnSignal = `spur-return-${suffix}`;
  try {
    execFileSync(
      "tmux",
      withTmuxSocketArgs([
        "bind-key",
        "-T",
        returnTable,
        "C-g",
        "set-option",
        "key-table",
        "root",
        "\\;",
        "switch-client",
        "-t",
        `=${controllerSession}`,
        "\\;",
        "wait-for",
        "-S",
        returnSignal,
      ]),
      {
        stdio: "ignore",
      },
    );
    execFileSync("tmux", withTmuxSocketArgs(["set-option", "key-table", returnTable]), {
      stdio: "ignore",
    });
    execFileSync("tmux", withTmuxSocketArgs(["switch-client", "-t", target]), {
      stdio: "inherit",
    });
    execFileSync("tmux", withTmuxSocketArgs(["wait-for", returnSignal]), {
      stdio: "ignore",
    });
  } finally {
    try {
      execFileSync("tmux", withTmuxSocketArgs(["set-option", "key-table", "root"]), {
        stdio: "ignore",
      });
    } catch {
      // Best effort only.
    }
    try {
      execFileSync("tmux", withTmuxSocketArgs(["unbind-key", "-T", returnTable, "C-g"]), {
        stdio: "ignore",
      });
    } catch {
      // Best effort only.
    }
  }
}

function printJson(value: unknown): void {
  writeStdout(JSON.stringify(value, null, 2));
}

export function matchesCliEntrypoint(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }
  const normalizePath = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const resolvedArgvPath = normalizePath(argvPath);
  const resolvedImportPath = normalizePath(fileURLToPath(importMetaUrl));
  return pathToFileURL(resolvedImportPath).href === pathToFileURL(resolvedArgvPath).href;
}

function renderStoppedDaemon(baseUrl: string): string {
  return dimText(`daemon ${baseUrl} is stopped`);
}

function renderDaemonStopResult(result: StopDaemonResult): string {
  return renderStoppedDaemon(result.baseUrl);
}

function renderDaemonRestartResult(result: RestartDaemonResult): string {
  return result.runtime ? renderRuntimeInfo(result.runtime) : renderStoppedDaemon(result.baseUrl);
}

function getConfigPath(program: Command): string | undefined {
  const options = program.opts<{ config?: string }>();
  return options.config;
}

function prepareInstanceConfig(program: Command): { configPath: string; initialized: boolean } {
  const ensured = ensureInstanceConfig(getConfigPath(program));
  setTmuxSocketName(loadConfig(ensured.configPath).tmux.socketName);
  return ensured;
}

async function maybeAutoConnectProject(
  cliEntrypoint: string,
  configPath: string,
  explicitProjectConfigPath?: string,
): Promise<{ notice?: string; warning?: string }> {
  const candidates = new Set<string>();
  if (explicitProjectConfigPath) {
    try {
      const parsed = loadProjectConfig(explicitProjectConfigPath, loadConfig(configPath));
      if (Object.keys(parsed.projects).length > 0) {
        candidates.add(parsed.configPath);
      }
    } catch {
      // Explicit config may be instance-only; ignore for auto-connect.
    }
  }
  const discoveredProjectConfigPath = findProjectConfigPath();
  if (discoveredProjectConfigPath) {
    candidates.add(discoveredProjectConfigPath);
  }
  const projectConfigPath = [...candidates][0];
  if (!projectConfigPath) {
    return {};
  }

  try {
    const result = await connectProjectConfig(cliEntrypoint, projectConfigPath, configPath);
    return result.changed ? { notice: `Connected project config from ${projectConfigPath}.` } : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Auto-connect skipped for ${projectConfigPath}: ${message}` };
  }
}

function printBootstrapNotice(initialized: boolean, json: boolean, configPath: string): void {
  if (initialized && !json) {
    writeStdout(brandLine(`Initialized Spur instance config at ${configPath}.`));
    writeStdout(brandLine(`Voice input is off until local dependencies are installed.`));
    writeStdout(
      brandLine(
        `Default voice uses \`whisper_cpp\`: install \`whisper-cli\`, \`ffmpeg\`, and a model at ${defaultVoiceModelPath()}.`,
      ),
    );
    writeStdout(
      brandLine(
        `Switch providers with \`voice.provider\`, or set \`voice.modelPath\` to override the model source.`,
      ),
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findSelectedIndex(
  sessions: SessionView[],
  selectedSessionId: string | null,
): number | null {
  if (!selectedSessionId) return null;
  const index = sessions.findIndex((session) => session.id === selectedSessionId);
  return index === -1 ? null : index;
}

function moveSelection(
  sessions: SessionView[],
  selectedSessionId: string | null,
  delta: number,
): string | null {
  if (sessions.length === 0) return null;
  const currentIndex = findSelectedIndex(sessions, selectedSessionId);
  if (currentIndex === null) {
    const fallback = delta < 0 ? sessions.at(-1) : sessions[0];
    return fallback ? fallback.id : null;
  }
  const next = sessions[clamp(currentIndex + delta, 0, sessions.length - 1)];
  return next ? next.id : null;
}

async function loadRawSessions(cliEntrypoint: string, configPath?: string): Promise<SessionView[]> {
  return getJson<SessionView[]>(cliEntrypoint, "/sessions", configPath);
}

function visibleSessionsForHumanList(sessions: SessionView[]): SessionView[] {
  return sessions.filter(
    (session) => session.status !== "completed" && session.status !== "killed",
  );
}

async function loadServices(
  cliEntrypoint: string,
  sessionId: string,
  configPath?: string,
): Promise<ServiceInstanceView[]> {
  return getJson<ServiceInstanceView[]>(
    cliEntrypoint,
    `/sessions/${sessionId}/services`,
    configPath,
  );
}

async function loadHumanListData(
  cliEntrypoint: string,
  configPath?: string,
): Promise<{ info: RuntimeInfo; sessions: SessionView[] }> {
  const [info, sessions] = await Promise.all([
    getJson<RuntimeInfo>(cliEntrypoint, "/info", configPath),
    loadRawSessions(cliEntrypoint, configPath),
  ]);
  return { info, sessions: sortSessionsForList(visibleSessionsForHumanList(sessions)) };
}

function replaceListedSession(sessions: SessionView[], updated: SessionView): SessionView[] {
  return sortSessionsForList(sessions.map((entry) => (entry.id === updated.id ? updated : entry)));
}

function postSessionAction(
  cliEntrypoint: string,
  sessionId: string,
  action: "pause" | "complete" | "kill",
  configPath?: string,
  body: object = {},
): Promise<SessionView> {
  return postJson<SessionView>(cliEntrypoint, `/sessions/${sessionId}/${action}`, body, configPath);
}

function appendOptionValue(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

function renderLiveSessionList(args: {
  info: RuntimeInfo;
  sessions: SessionView[];
  selectedSessionId: string | null;
  statusMessage?: string;
}): string {
  const rows = process.stdout.rows > 0 ? process.stdout.rows : 24;
  const waitingInputAlert = renderWaitingInputAlert({
    sessions: args.sessions,
    selectedSessionId: args.selectedSessionId,
  });
  const available = Math.max(
    1,
    rows - LIST_FIXED_ROWS - (waitingInputAlert ? 2 : 0) - (args.statusMessage ? 2 : 0),
  );
  const maxDetailLines = Math.max(
    0,
    Math.min(LIST_MAX_DETAIL_ROWS, available - LIST_MIN_SESSION_ROWS),
  );
  const maxVisible = Math.max(1, available - maxDetailLines);
  const selectedIndex = findSelectedIndex(args.sessions, args.selectedSessionId) ?? 0;
  const maxStart = Math.max(0, args.sessions.length - maxVisible);
  const windowStart = clamp(selectedIndex - Math.floor(maxVisible / 2), 0, maxStart);
  const visibleSessions = args.sessions.slice(windowStart, windowStart + maxVisible);
  const renderArgs = {
    info: args.info,
    sessions: visibleSessions,
    selectedSessionId: args.selectedSessionId,
    totalSessions: args.sessions.length,
    windowStart,
    maxDetailLines,
    ...(waitingInputAlert ? { waitingInputAlert } : {}),
    ...(args.statusMessage ? { statusMessage: args.statusMessage } : {}),
  };
  return renderInteractiveSessionList(renderArgs);
}

function renderAttachedPaneView(args: { title: string; content: string }): string {
  return [
    brandLine(args.title),
    "",
    args.content || dimText("(no output)"),
    "",
    dimText("Ctrl+G back"),
  ].join("\n");
}

interface SessionLogViewState {
  session: SessionView;
  agentPane: string;
  eventLines: string[];
  localLines: string[];
}

function formatLogTime(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toISOString().slice(11, 19);
}

function eventSummary(entry: SpurLogEntry): string {
  const message = entry.message?.trim();
  if (message) {
    return message;
  }
  return entry.event;
}

function formatEventLine(entry: SpurLogEntry): string {
  const time = dimText(formatLogTime(entry.timestamp));
  const level =
    entry.level === "error"
      ? accent("error")
      : entry.level === "warn"
        ? accent("warn")
        : dimText("info");
  const summary = eventSummary(entry);
  return summary === entry.event
    ? `${time} ${level} ${entry.event}`
    : `${time} ${level} ${entry.event} ${summary}`;
}

function readDisplaySessionEventLines(dataDir: string, sessionId: string): string[] {
  return readSessionEventLog(dataDir, sessionId)
    .filter((entry) => entry.event !== "session.state.classified")
    .slice(-SESSION_LOG_EVENT_LIMIT)
    .map(formatEventLine);
}

function buildStateChangeLine(previous: SessionView, next: SessionView): string | null {
  const changes: string[] = [];
  if (previous.status !== next.status) {
    changes.push(`status ${previous.status} -> ${next.status}`);
  }
  if (previous.state !== next.state) {
    changes.push(`state ${previous.state} -> ${next.state}`);
  }
  if (previous.runtimeAlive !== next.runtimeAlive) {
    changes.push(
      `tmux ${previous.runtimeAlive ? "live" : "dead"} -> ${next.runtimeAlive ? "live" : "dead"}`,
    );
  }
  if (previous.workspaceExists !== next.workspaceExists) {
    changes.push(
      `workspace ${previous.workspaceExists ? "live" : "missing"} -> ${next.workspaceExists ? "live" : "missing"}`,
    );
  }
  if ((previous.error ?? "") !== (next.error ?? "") && next.error) {
    changes.push(`error ${next.error}`);
  }
  if (changes.length === 0) {
    return null;
  }
  return `${dimText(formatLogTime(new Date().toISOString()))} ${accent("local")} ${changes.join(" • ")}`;
}

function renderSessionLogView(args: SessionLogViewState): string {
  const session = args.session;
  const summary = [
    `status ${session.status}`,
    `state ${session.state}`,
    session.runtimeAlive ? "tmux live" : "tmux dead",
    session.worktree
      ? session.workspaceExists
        ? "worktree live"
        : "worktree missing"
      : session.workspaceExists
        ? "shared workspace live"
        : "shared workspace missing",
    `updated ${session.lastActivityAt}`,
  ].join("  ");
  const sections = [
    brandLine(`Logs ${session.id}`),
    "",
    dimText("Ctrl+G back"),
    "",
    dimText(summary),
    dimText(`project ${session.project}  agent ${session.agent}  branch ${session.branch}`),
    "",
    boldText("Events"),
    ...(args.eventLines.length > 0 ? args.eventLines : [dimText("(no events yet)")]),
  ];
  if (args.localLines.length > 0) {
    sections.push("", boldText("Live Transitions"), ...args.localLines);
  }
  sections.push("", boldText("Agent Output"), args.agentPane || dimText("(agent is not live)"));
  return sections.join("\n");
}

interface HelpRow {
  term: string;
  description: string;
}

function renderHelpLines(
  lines: string[],
  format: (line: string) => string = (line) => line,
): string {
  return lines.map((line) => `  ${format(line)}`).join("\n");
}

function renderHelpRows(rows: HelpRow[]): string {
  const width = Math.max(...rows.map((row) => row.term.length));
  return rows.map((row) => `  ${accent(row.term.padEnd(width))}  ${row.description}`).join("\n");
}

function collectOptionValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseSlotLink(value: string): SessionLink {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) {
    throw new Error("--link must use label=url");
  }
  return {
    label: value.slice(0, index),
    url: value.slice(index + 1),
  };
}

function currentSessionId(): string {
  const sessionId = runningSessionId();
  if (!sessionId) {
    throw new Error("service run requires a live Spur session");
  }
  return sessionId;
}

function runningSessionId(): string | undefined {
  const sessionId = process.env["SPUR_SESSION"]?.trim();
  return sessionId ? sessionId : undefined;
}

function respawnParentSessionId(): string | undefined {
  const sessionId = runningSessionId();
  if (!sessionId) {
    return undefined;
  }
  if (process.env["SPUR_SIDECAR_NAME"]?.trim()) {
    return undefined;
  }
  const sessionToolDir = process.env["SPUR_SESSION_TOOL_DIR"]?.trim();
  return sessionToolDir ? sessionId : undefined;
}

function respawnRequestBody(): RespawnSessionRequest {
  const sessionId = respawnParentSessionId();
  return sessionId ? { terminateSessionId: sessionId } : {};
}

export function terminateRespawnParentProcess(): boolean {
  if (process.env["TEST"] || process.env["VITEST"]) {
    return false;
  }
  if (!process.env["TMUX"]) {
    return false;
  }
  if (!respawnParentSessionId()) {
    return false;
  }
  try {
    process.kill(process.ppid, "SIGTERM");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function parsePortOption(value: string, label: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return port;
}

function helpTitle(command: Command): string {
  return command.parent ? command.name() : "Spur";
}

function commandDisplayName(command: Command): string {
  const aliases = command.aliases();
  return aliases.length > 0 ? [command.name(), ...aliases].join("|") : command.name();
}

function helpNotes(command: Command): string[] {
  if (!command.parent) {
    return [
      "Use `spur <command> --help` for per-command details.",
      "Use `--json` on `spawn`, `list`, `send`, `pause`, `complete`, `kill`, `service run`, and `service status` for scripts.",
    ];
  }
  if (command.name() === "spawn") {
    return [
      "If the project enables spawn preflight, worktree spawns can derive a branch before worktree creation.",
      "`--branch` bypasses any configured preflight branch suggestion.",
      "`--shared` cannot be combined with `--worktree` or `--branch`.",
    ];
  }
  if (command.name() === "list") {
    return [
      "On a TTY, this opens the live selector instead of printing a one-shot list.",
      "TTY keys: ↑↓ move, Enter attach, l logs, d sidecar, p pause, c complete, r restore, s respawn, k kill, Ctrl+G detach, Esc quit.",
      "Risky kill requires a second `k` when the worktree is dirty or has unpushed commits.",
    ];
  }
  if (command.name() === "kill") {
    return ["Use `--force` to kill a dirty worktree or unpushed commits."];
  }
  if (command.name() === "service") {
    return [
      "`service run` is intended to be called from inside a live Spur session workspace.",
      "Service sidecars stay session-bound; inspect session activity from `spur list` with `l`.",
    ];
  }
  return [];
}

function formatHelp(command: Command, helper: Help): string {
  const sections: string[] = [brandLine(helpTitle(command))];
  const commandUsage = (target: Command): string =>
    target.parent
      ? [commandDisplayName(target), target.usage()].filter(Boolean).join(" ")
      : helper.commandUsage(target);
  const description = helper.commandDescription(command);
  if (description) {
    sections.push(dimText(description));
  }

  sections.push(`${boldText("Usage")}\n${renderHelpLines([commandUsage(command)])}`);

  const argumentsRows = helper.visibleArguments(command).map((argument) => ({
    term: helper.argumentTerm(argument),
    description: helper.argumentDescription(argument),
  }));
  if (argumentsRows.length > 0) {
    sections.push(`${boldText("Arguments")}\n${renderHelpRows(argumentsRows)}`);
  }

  const commandRows = helper.visibleCommands(command).map((entry) => ({
    term: commandUsage(entry),
    description: helper.subcommandDescription(entry),
  }));
  if (commandRows.length > 0) {
    sections.push(`${boldText("Commands")}\n${renderHelpRows(commandRows)}`);
  }

  const optionRows = helper.visibleOptions(command).map((option) => ({
    term: helper.optionTerm(option),
    description: helper.optionDescription(option),
  }));
  if (optionRows.length > 0) {
    sections.push(`${boldText("Options")}\n${renderHelpRows(optionRows)}`);
  }

  const globalOptionRows = helper.visibleGlobalOptions(command).map((option) => ({
    term: helper.optionTerm(option),
    description: helper.optionDescription(option),
  }));
  if (globalOptionRows.length > 0) {
    sections.push(`${boldText("Global Options")}\n${renderHelpRows(globalOptionRows)}`);
  }

  const notes = helpNotes(command);
  if (notes.length > 0) {
    sections.push(`${boldText("Notes")}\n${renderHelpLines(notes, dimText)}`);
  }

  return sections.join("\n\n");
}

async function runInteractiveSessionList(
  cliEntrypoint: string,
  configPath?: string,
): Promise<void> {
  const { info, sessions: initialSessions } = await withSpinner("loading sessions", () =>
    loadHumanListData(cliEntrypoint, configPath),
  );
  let sessions = initialSessions;
  let selectedSessionId: string | null = sessions[0]?.id ?? null;
  let statusMessage: string | undefined;
  let closed = false;
  let busy = false;
  let refreshing = false;
  let pendingKillConfirmationSessionId: string | null = null;
  let attachedPane: {
    tmuxSession: string;
    title: string;
  } | null = null;
  let logView: SessionLogViewState | null = null;
  let attachedPaneContent = "";
  let terminalActive = false;
  let refreshTimer: NodeJS.Timeout | undefined;

  const render = (): void => {
    if (closed) return;
    if (logView) {
      process.stdout.write(`\u001b[2J\u001b[H${renderSessionLogView(logView)}\n`);
      return;
    }
    if (attachedPane) {
      process.stdout.write(
        `\u001b[2J\u001b[H${renderAttachedPaneView({
          title: attachedPane.title,
          content: attachedPaneContent,
        })}\n`,
      );
      return;
    }
    const listArgs = {
      info,
      sessions,
      selectedSessionId,
      ...(statusMessage ? { statusMessage } : {}),
    };
    process.stdout.write(`\u001b[2J\u001b[H${renderLiveSessionList(listArgs)}\n`);
  };

  const enableTerminal = (): void => {
    if (terminalActive) return;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(ENTER_ALT_SCREEN);
    terminalActive = true;
  };

  const disableTerminal = (): void => {
    if (!terminalActive) return;
    process.stdout.write(EXIT_ALT_SCREEN);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    terminalActive = false;
  };

  const refresh = async (): Promise<void> => {
    if (closed || busy || refreshing) return;
    refreshing = true;
    try {
      if (logView) {
        const nextSession = await getJson<SessionView>(
          cliEntrypoint,
          `/sessions/${logView.session.id}`,
          configPath,
        );
        const line = buildStateChangeLine(logView.session, nextSession);
        if (line) {
          logView.localLines = [...logView.localLines, line].slice(-SESSION_LOG_LOCAL_LIMIT);
        }
        logView = {
          ...logView,
          session: nextSession,
          eventLines: readDisplaySessionEventLines(info.dataDir, logView.session.id),
          agentPane: nextSession.runtimeAlive
            ? (tryCaptureTmuxTarget(nextSession.tmuxSession, SESSION_LOG_OUTPUT_LINES) ??
              dimText("(agent output unavailable)"))
            : "",
        };
        return;
      }
      if (attachedPane) {
        attachedPaneContent = captureTmuxTarget(attachedPane.tmuxSession);
        return;
      }
      const nextSessions = sortSessionsForList(
        visibleSessionsForHumanList(await loadRawSessions(cliEntrypoint, configPath)),
      );
      sessions = nextSessions;
      if (selectedSessionId && !nextSessions.some((session) => session.id === selectedSessionId)) {
        const vanishedId = selectedSessionId;
        selectedSessionId = null;
        pendingKillConfirmationSessionId = null;
        statusMessage = brandLine(`${vanishedId} disappeared. Use ↑↓ to reselect before acting.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      refreshing = false;
      render();
    }
  };

  const getSelectedSession = (): SessionView | null =>
    sessions.find((session) => session.id === selectedSessionId) ?? null;

  const getSelectedSessionOrWarn = (): SessionView | null => {
    const session = getSelectedSession();
    if (session) return session;
    statusMessage = brandLine(RESELECT_MESSAGE);
    render();
    return null;
  };

  const openAttachedPane = (tmuxSession: string, title: string): void => {
    attachedPane = { tmuxSession, title };
    attachedPaneContent = captureTmuxTarget(tmuxSession);
    logView = null;
    pendingKillConfirmationSessionId = null;
    statusMessage = undefined;
    render();
  };

  const openSelectedSessionLogs = (): void => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;
    logView = {
      session,
      eventLines: readDisplaySessionEventLines(info.dataDir, session.id),
      localLines: [],
      agentPane: session.runtimeAlive
        ? (tryCaptureTmuxTarget(session.tmuxSession, SESSION_LOG_OUTPUT_LINES) ??
          dimText("(agent output unavailable)"))
        : "",
    };
    attachedPane = null;
    pendingKillConfirmationSessionId = null;
    statusMessage = undefined;
    render();
  };

  const restoreSelectedSession = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;
    if (!isRestorableSession(session)) {
      statusMessage = brandLine(`Session ${session.id} cannot be restored.`);
      render();
      return;
    }

    busy = true;
    statusMessage = brandLine(`Restoring ${session.id}...`);
    render();

    try {
      const restorePlan = await buildAgentRestorePlan(
        session.agent,
        session.worktreePath,
        buildRestorePrompt(session.prompt),
      );
      if (!restorePlan) {
        statusMessage = brandLine(
          `No native resume state found for ${session.agent} session ${session.id}`,
        );
        return;
      }
      const restored = await postJson<SessionView>(
        cliEntrypoint,
        `/sessions/${session.id}/restore`,
        {},
        configPath,
      );
      sessions = replaceListedSession(sessions, restored);
      selectedSessionId = restored.id;
      pendingKillConfirmationSessionId = null;
      statusMessage = brandLine(`Restored ${restored.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  };

  const attachSelectedSession = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;
    if (!session.runtimeAlive) {
      const message =
        session.state === "killed"
          ? `Session ${session.id} was killed and cannot be restored.`
          : `Session ${session.id} is not live.`;
      statusMessage = brandLine(message);
      render();
      return;
    }

    busy = true;
    statusMessage = brandLine(`Attaching to ${session.id}...`);
    render();

    if (isInsideTmuxSession() && !currentTmuxSessionHasAttachedClient()) {
      busy = false;
      openAttachedPane(session.tmuxSession, `Attached ${session.id}`);
      return;
    }

    disableTerminal();
    try {
      enableTmuxMouse(session.tmuxSession);
      attachTmuxTargetFromList(session.tmuxSession);
      pendingKillConfirmationSessionId = null;
      statusMessage = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      if (!closed) {
        enableTerminal();
      }
      busy = false;
      await refresh();
    }
  };

  const startOrAttachSidecar = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;

    const firstSidecar = session.sidecars[0];
    if (!firstSidecar) {
      statusMessage = brandLine(`No sidecars configured for ${session.id}`);
      render();
      return;
    }
    const scName = firstSidecar.name;

    busy = true;
    statusMessage = brandLine(`Starting sidecar ${scName} for ${session.id}...`);
    render();

    const scTmuxSession = sidecarTmuxSession(session.id, scName);
    try {
      if (!firstSidecar.alive) {
        await postJson<SessionView>(
          cliEntrypoint,
          `/sessions/${session.id}/sidecars/${scName}/start`,
          {},
          configPath,
        );
      }

      pendingKillConfirmationSessionId = null;
      statusMessage = undefined;

      if (isInsideTmuxSession() && !currentTmuxSessionHasAttachedClient()) {
        busy = false;
        openAttachedPane(scTmuxSession, `Sidecar ${scName} ${session.id}`);
        return;
      }

      disableTerminal();
      try {
        attachTmuxTargetFromList(scTmuxSession);
      } finally {
        if (!closed) {
          enableTerminal();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  };

  const pauseSelectedSession = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;

    busy = true;
    statusMessage = brandLine(`Pausing ${session.id}...`);
    render();

    try {
      const paused = await postSessionAction(cliEntrypoint, session.id, "pause", configPath);
      sessions = replaceListedSession(sessions, paused);
      selectedSessionId = paused.id;
      pendingKillConfirmationSessionId = null;
      statusMessage = brandLine(`Paused ${paused.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  };

  const completeSelectedSession = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;

    busy = true;
    statusMessage = brandLine(`Completing ${session.id}...`);
    render();

    try {
      const completed = await postSessionAction(cliEntrypoint, session.id, "complete", configPath);
      sessions = sessions.filter((entry) => entry.id !== completed.id);
      selectedSessionId = null;
      pendingKillConfirmationSessionId = null;
      statusMessage = brandLine(`Completed ${completed.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  };

  const killSelectedSession = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;
    const force = pendingKillConfirmationSessionId === session.id;

    busy = true;
    statusMessage = brandLine(
      force ? `Killing ${session.id} anyway...` : `Killing ${session.id}...`,
    );
    render();

    try {
      const killed = await postSessionAction(
        cliEntrypoint,
        session.id,
        "kill",
        configPath,
        force ? { force: true } : {},
      );
      sessions = sessions.filter((entry) => entry.id !== killed.id);
      selectedSessionId = null;
      pendingKillConfirmationSessionId = null;
      statusMessage = brandLine(`Killed ${killed.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!force && isKillConfirmationRequiredMessage(message)) {
        pendingKillConfirmationSessionId = session.id;
        statusMessage = brandLine(`${message}. Press k again to kill anyway.`);
      } else {
        pendingKillConfirmationSessionId = null;
        statusMessage = brandLine(message);
      }
    } finally {
      busy = false;
      render();
      await refresh();
    }
  };

  const respawnSelectedSession = async (): Promise<void> => {
    const session = getSelectedSessionOrWarn();
    if (!session) return;
    if (
      session.status !== "completed" &&
      session.status !== "killed" &&
      session.status !== "errored"
    ) {
      statusMessage = brandLine(`Session ${session.id} is not in a terminal state.`);
      render();
      return;
    }

    busy = true;
    statusMessage = brandLine(`Respawning ${session.id}...`);
    render();

    try {
      const respawned = await postJson<SessionView>(
        cliEntrypoint,
        `/sessions/${session.id}/respawn`,
        respawnRequestBody(),
        configPath,
      );
      sessions = sortSessionsForList([...sessions, respawned]);
      selectedSessionId = respawned.id;
      pendingKillConfirmationSessionId = null;
      statusMessage = brandLine(`Respawned as ${respawned.id}.`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = brandLine(message);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  };

  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      cleanup();
      reject(error);
    };

    const onResize = (): void => {
      render();
    };

    const onKeypress = (
      _input: string,
      key: { ctrl?: boolean; name?: string; sequence?: string },
    ): void => {
      if (busy) return;
      if (key.ctrl && key.name === "c") {
        process.exitCode = 130;
        finish();
        return;
      }
      if (logView || attachedPane) {
        if (key.ctrl && key.name === "g") {
          logView = null;
          attachedPane = null;
          attachedPaneContent = "";
          render();
        }
        return;
      }
      if (key.name === "escape" || key.name === "q" || key.sequence === "q") {
        finish();
        return;
      }
      if (key.name === "up") {
        pendingKillConfirmationSessionId = null;
        selectedSessionId = moveSelection(sessions, selectedSessionId, -1);
        render();
        return;
      }
      if (key.name === "down") {
        pendingKillConfirmationSessionId = null;
        selectedSessionId = moveSelection(sessions, selectedSessionId, 1);
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        pendingKillConfirmationSessionId = null;
        void attachSelectedSession().catch(fail);
        return;
      }
      if (key.name === "l" || key.sequence === "l") {
        pendingKillConfirmationSessionId = null;
        openSelectedSessionLogs();
        return;
      }
      if (key.name === "d" || key.sequence === "d") {
        pendingKillConfirmationSessionId = null;
        void startOrAttachSidecar().catch(fail);
        return;
      }
      if (key.name === "p" || key.sequence === "p") {
        pendingKillConfirmationSessionId = null;
        void pauseSelectedSession().catch(fail);
        return;
      }
      if (key.name === "c" || key.sequence === "c") {
        pendingKillConfirmationSessionId = null;
        void completeSelectedSession().catch(fail);
        return;
      }
      if (key.name === "r" || key.sequence === "r") {
        pendingKillConfirmationSessionId = null;
        void restoreSelectedSession().catch(fail);
        return;
      }
      if (key.name === "k" || key.sequence === "k") {
        void killSelectedSession().catch(fail);
        return;
      }
      if (key.name === "s" || key.sequence === "s") {
        pendingKillConfirmationSessionId = null;
        void respawnSelectedSession().catch(fail);
      }
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      process.stdin.off("keypress", onKeypress);
      process.stdout.off("resize", onResize);
      disableTerminal();
    };

    enableTerminal();
    render();
    refreshTimer = setInterval(() => {
      void refresh();
    }, LIVE_LIST_REFRESH_MS);
    process.stdin.on("keypress", onKeypress);
    process.stdout.on("resize", onResize);
  });
}

async function outputResult<T>(args: {
  json: boolean;
  label: string;
  action: () => Promise<T>;
  render: (value: T) => string;
  success?: (value: T) => string;
}): Promise<void> {
  const value = args.json ? await args.action() : await withSpinner(args.label, args.action);
  if (args.json) {
    printJson(value);
    return;
  }
  if (args.success) {
    writeStdout(brandLine(args.success(value)));
  }
  writeStdout(args.render(value));
}

function resolveCliSpawnOverrides(options: {
  worktree?: boolean | string;
  shared?: boolean;
}): SpawnSessionRequest["overrides"] {
  if (options.shared && options.worktree !== undefined) {
    throw new Error("--shared cannot be combined with --worktree");
  }
  if (options.shared) {
    return { worktree: false };
  }
  if (options.worktree === undefined || options.worktree === false) {
    return undefined;
  }
  if (options.worktree === true) {
    return { worktree: true };
  }
  const defaultBranch = options.worktree.trim();
  if (!defaultBranch) {
    throw new Error("--worktree base branch must be a non-empty string");
  }
  return { worktree: true, defaultBranch };
}

export function createProgram(cliEntrypoint: string): Command {
  const program = new Command();

  program
    .name("spur")
    .description("Lean v2 orchestrator.")
    .usage("<command> [options]")
    .helpCommand(false)
    .helpOption("-h, --help", "Show help")
    .configureHelp({ formatHelp, showGlobalOptions: true })
    .option("--config <path>", "Path to spur.yaml")
    .version("0.1.0", "-V, --version", "Show version");

  program
    .command("spawn")
    .description("Start a session for a configured project.")
    .argument("<project>", "Configured project id")
    .argument("[prompt...]", "Optional task prompt")
    .option("--agent <name>", "Agent to start: claude or codex")
    .option(
      "--plan",
      "Start in plan mode (Claude startup uses --permission-mode plan; Codex launch is unchanged)",
    )
    .option("--branch <name>", "Branch name to use")
    .option("--step <label>", "Add a pipeline step; repeatable", appendOptionValue)
    .option(
      "--worktree [defaultBranch]",
      "Use an owned worktree; optionally override the base branch",
    )
    .option("--shared", "Use the project path directly for this session (no worktree)")
    .option("--json", "Print raw JSON")
    .action(async (project: string, promptParts: string[] | undefined, options, command) => {
      const parentProgram = command.parent as Command;
      const explicitConfigPath = getConfigPath(parentProgram);
      const instance = prepareInstanceConfig(parentProgram);
      printBootstrapNotice(instance.initialized, Boolean(options.json), instance.configPath);
      const autoConnect = await maybeAutoConnectProject(
        cliEntrypoint,
        instance.configPath,
        explicitConfigPath,
      );
      if (autoConnect.notice && !options.json) {
        writeStdout(brandLine(autoConnect.notice));
      }
      if (autoConnect.warning && !options.json) {
        writeStdout(brandLine(autoConnect.warning));
      }
      const overrides = resolveCliSpawnOverrides(options);
      const prompt = (promptParts ?? []).join(" ").trim();
      const configPath = instance.configPath;
      const availableProjects = await listProjects(cliEntrypoint, configPath);
      if (!availableProjects.some((entry) => entry.id === project)) {
        throw new Error(
          `Unknown project: ${project}. Run \`spur connect\` in the project directory or add it to the global registry first.`,
        );
      }

      let branch: string | undefined = options.branch;

      // Interactive branch confirmation: TTY, no --json, no explicit --branch
      const interactive = !options.json && !branch && process.stdin.isTTY && process.stdout.isTTY;
      if (interactive && prompt) {
        const preflight = await withSpinner("running preflight", () =>
          postPreflight(
            cliEntrypoint,
            project,
            { prompt, agent: options.agent, ...(overrides !== undefined ? { overrides } : {}) },
            configPath,
          ),
        );
        if (preflight.branch) {
          const confirmed = await text({
            message: "Branch name",
            defaultValue: preflight.branch,
            placeholder: preflight.branch,
          });
          if (isCancel(confirmed)) {
            cancel("spawn cancelled");
            process.exit(0);
          }
          branch = confirmed.trim() || preflight.branch;
        }
      }

      const payload: SpawnSessionRequest = {
        project,
        prompt,
        ...(options.step !== undefined ? { steps: options.step as string[] } : {}),
        agent: options.agent,
        ...(options.plan ? { planMode: true } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
      };
      await outputResult({
        json: Boolean(options.json),
        label: "starting session",
        action: () => postJson<SessionView>(cliEntrypoint, "/sessions", payload, configPath),
        render: renderSessionCard,
      });
    });

  program
    .command("list")
    .alias("ls")
    .description("Show sessions; on a TTY, open the live selector.")
    .option("--json", "Print raw JSON")
    .action(async (options, command) => {
      const parentProgram = command.parent as Command;
      const explicitConfigPath = getConfigPath(parentProgram);
      const instance = prepareInstanceConfig(parentProgram);
      printBootstrapNotice(instance.initialized, Boolean(options.json), instance.configPath);
      const autoConnect = await maybeAutoConnectProject(
        cliEntrypoint,
        instance.configPath,
        explicitConfigPath,
      );
      if (autoConnect.notice && !options.json) {
        writeStdout(brandLine(autoConnect.notice));
      }
      if (autoConnect.warning && !options.json) {
        writeStdout(brandLine(autoConnect.warning));
      }
      const configPath = instance.configPath;
      if (options.json) {
        await outputResult({
          json: true,
          label: "loading sessions",
          action: () => loadRawSessions(cliEntrypoint, configPath),
          render: () => "",
        });
        return;
      }
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runInteractiveSessionList(cliEntrypoint, configPath);
        return;
      }
      const data = await withSpinner("loading sessions", () =>
        loadHumanListData(cliEntrypoint, configPath),
      );
      writeStdout(renderSessionDashboard(data));
    });

  program
    .command("connect")
    .description("Connect a local Spur project config to the running instance.")
    .argument("[path]", "Path to a project spur.yaml")
    .option("--json", "Print raw JSON")
    .action(async (path: string | undefined, options, command) => {
      const instance = prepareInstanceConfig(command.parent as Command);
      printBootstrapNotice(instance.initialized, Boolean(options.json), instance.configPath);
      const projectConfigPath = path ?? findProjectConfigPath();
      if (!projectConfigPath) {
        throw new Error("No local spur.yaml or spur.yml found to connect");
      }
      await outputResult({
        json: Boolean(options.json),
        label: "connecting project config",
        action: () => connectProjectConfig(cliEntrypoint, projectConfigPath, instance.configPath),
        success: (result: ProjectConfigMutationResponse) =>
          result.changed
            ? `Connected ${projectConfigPath}.`
            : `${projectConfigPath} already connected.`,
        render: (result: ProjectConfigMutationResponse) =>
          brandLine(`${result.projects.length} projects available.`),
      });
    });

  program
    .command("disconnect")
    .description("Disconnect a local Spur project config from the running instance.")
    .argument("[path]", "Path to a project spur.yaml")
    .option("--json", "Print raw JSON")
    .action(async (path: string | undefined, options, command) => {
      const instance = prepareInstanceConfig(command.parent as Command);
      printBootstrapNotice(instance.initialized, Boolean(options.json), instance.configPath);
      const projectConfigPath = path ?? findProjectConfigPath();
      if (!projectConfigPath) {
        throw new Error("No local spur.yaml or spur.yml found to disconnect");
      }
      await outputResult({
        json: Boolean(options.json),
        label: "disconnecting project config",
        action: () =>
          disconnectProjectConfig(cliEntrypoint, projectConfigPath, instance.configPath),
        success: (result: ProjectConfigMutationResponse) =>
          result.changed
            ? `Disconnected ${projectConfigPath}.`
            : `${projectConfigPath} was not changing the active registry.`,
        render: (result: ProjectConfigMutationResponse) =>
          brandLine(`${result.projects.length} projects available.`),
      });
    });

  program
    .command("send")
    .description("Send a follow-up message to a session.")
    .argument("<sessionId>", "Session id")
    .argument("<message...>", "Message to send")
    .option("--json", "Print raw JSON")
    .action(async (sessionId: string, messageParts: string[], options, command) => {
      const configPath = prepareInstanceConfig(command.parent as Command).configPath;
      const payload: SendMessageRequest = { message: messageParts.join(" ") };
      await outputResult({
        json: Boolean(options.json),
        label: "sending message",
        action: () =>
          postJson<SessionView>(cliEntrypoint, `/sessions/${sessionId}/send`, payload, configPath),
        success: (session) => `Sent message to ${session.id}.`,
        render: renderSessionCard,
      });
    });

  program
    .command("pause")
    .description("Stop a session but keep its worktree.")
    .argument("<sessionId>", "Session id")
    .option("--json", "Print raw JSON")
    .action(async (sessionId: string, options, command) => {
      const configPath = prepareInstanceConfig(command.parent as Command).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "pausing session",
        action: () => postSessionAction(cliEntrypoint, sessionId, "pause", configPath),
        success: (session) => `Paused ${session.id}.`,
        render: renderSessionCard,
      });
    });

  program
    .command("complete")
    .description("Mark a session complete and clean up its runtime artifacts.")
    .argument("<sessionId>", "Session id")
    .option("--json", "Print raw JSON")
    .action(async (sessionId: string, options, command) => {
      const configPath = prepareInstanceConfig(command.parent as Command).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "completing session",
        action: () => postSessionAction(cliEntrypoint, sessionId, "complete", configPath),
        success: (session) => `Completed ${session.id}.`,
        render: renderSessionCard,
      });
    });

  program
    .command("kill")
    .description("Stop a session and discard its artifacts without marking it complete.")
    .argument("<sessionId>", "Session id")
    .option("--force", "Skip dirty-worktree and unpushed-commit confirmation")
    .option("--json", "Print raw JSON")
    .action(async (sessionId: string, options, command) => {
      const configPath = prepareInstanceConfig(command.parent as Command).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "killing session",
        action: () =>
          postSessionAction(
            cliEntrypoint,
            sessionId,
            "kill",
            configPath,
            options.force ? { force: true } : {},
          ),
        success: (session) => `Killed ${session.id}.`,
        render: renderSessionCard,
      });
    });

  program
    .command("respawn")
    .description("Spawn a new session with the same config as a terminal session.")
    .argument("<sessionId>", "Session id")
    .option("--json", "Print raw JSON")
    .action(async (sessionId: string, options, command) => {
      const configPath = prepareInstanceConfig(command.parent as Command).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "respawning session",
        action: () =>
          postJson<SessionView>(
            cliEntrypoint,
            `/sessions/${sessionId}/respawn`,
            respawnRequestBody(),
            configPath,
          ),
        success: (session) => `Respawned as ${session.id}.`,
        render: renderSessionCard,
      });
      terminateRespawnParentProcess();
    });

  const service = program
    .command("service")
    .description("Run and inspect session-bound sidecar services.");

  service
    .command("run")
    .description("Run a service command bound to the current Spur session.")
    .argument("<serviceId>", "Logical service id")
    .argument("<command...>", "Shell command to run")
    .option("--port <number>", "Port held by this service")
    .option("--json", "Print raw JSON")
    .action(async (serviceId: string, commandParts: string[], options, command) => {
      const configPath = prepareInstanceConfig(command.parent?.parent as Command).configPath;
      const sessionId = currentSessionId();
      const shellCommand = commandParts.join(" ").trim();
      if (!shellCommand) {
        throw new Error("service run requires a non-empty command");
      }
      const payload: RunServiceRequest = {
        command: shellCommand,
        cwd: process.cwd(),
        ...(options.port !== undefined ? { port: parsePortOption(options.port, "--port") } : {}),
      };
      await outputResult({
        json: Boolean(options.json),
        label: `starting service ${serviceId}`,
        action: () =>
          postJson<ServiceInstanceView>(
            cliEntrypoint,
            `/sessions/${sessionId}/services/${serviceId}/run`,
            payload,
            configPath,
          ),
        success: (service) => `Started ${service.serviceId} for ${service.sessionId}.`,
        render: renderServiceCard,
      });
    });

  service
    .command("status")
    .description("Show services bound to a session.")
    .argument("<sessionId>", "Session id")
    .argument("[serviceId]", "Optional service id")
    .option("--json", "Print raw JSON")
    .action(async (sessionId: string, serviceId: string | undefined, options, command) => {
      const configPath = prepareInstanceConfig(command.parent?.parent as Command).configPath;
      if (serviceId) {
        await outputResult({
          json: Boolean(options.json),
          label: `loading service ${serviceId}`,
          action: () =>
            getJson<ServiceInstanceView>(
              cliEntrypoint,
              `/sessions/${sessionId}/services/${serviceId}`,
              configPath,
            ),
          render: renderServiceCard,
        });
        return;
      }

      await outputResult({
        json: Boolean(options.json),
        label: `loading services for ${sessionId}`,
        action: () => loadServices(cliEntrypoint, sessionId, configPath),
        render: renderServiceList,
      });
    });

  program
    .command("slots", { hidden: true })
    .description("Internal session slot updates.")
    .requiredOption("--session <id>", "Session id")
    .option("--title <text>", "Set task title")
    .option("--clear-title", "Remove task title")
    .option("--link <label=url>", "Add or replace a named link", collectOptionValue, [])
    .option("--unlink <label>", "Remove a named link", collectOptionValue, [])
    .option("--json", "Print raw JSON")
    .action(async (options, command) => {
      const configPath = prepareInstanceConfig(command.parent as Command).configPath;
      const payload: UpdateSessionSlotsRequest = {
        ...(options.title !== undefined ? { title: options.title as string } : {}),
        ...(options.clearTitle ? { clearTitle: true } : {}),
        ...((options.link as string[]).length > 0
          ? { links: (options.link as string[]).map(parseSlotLink) }
          : {}),
        ...((options.unlink as string[]).length > 0
          ? { unlinkLabels: options.unlink as string[] }
          : {}),
      };
      await outputResult({
        json: Boolean(options.json),
        label: "updating slots",
        action: () =>
          postJson<SessionView>(
            cliEntrypoint,
            `/sessions/${options.session as string}/slots`,
            payload,
            configPath,
          ),
        success: (session) => `Updated slots for ${session.id}.`,
        render: renderSessionCard,
      });
    });

  program
    .command("sidecar", { hidden: true })
    .description("Internal sidecar management.")
    .command("start")
    .requiredOption("--session <id>", "Session id")
    .requiredOption("--name <name>", "Sidecar name")
    .option("--json", "Print raw JSON")
    .action(async (options, command) => {
      if (process.env["SPUR_SIDECAR_NAME"]) {
        throw new Error(
          `Cannot start sidecar "${options.name as string}" from inside sidecar "${process.env["SPUR_SIDECAR_NAME"]}". Start sidecars only from the main session shell.`,
        );
      }
      const configPath = prepareInstanceConfig(
        (command.parent as Command).parent as Command,
      ).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "starting sidecar",
        action: () =>
          postJson<SessionView>(
            cliEntrypoint,
            `/sessions/${options.session as string}/sidecars/${options.name as string}/start`,
            {},
            configPath,
          ),
        success: (session) => `Started sidecar ${options.name as string} for ${session.id}.`,
        render: renderSessionCard,
      });
    });

  const daemon = program
    .command("daemon", { hidden: true })
    .description("Internal daemon commands.");

  daemon
    .command("start")
    .description("Start the local daemon.")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }, command: Command) => {
      const instance = prepareInstanceConfig(command.parent?.parent as Command);
      printBootstrapNotice(instance.initialized, Boolean(options.json), instance.configPath);
      const configPath = instance.configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "starting daemon",
        action: async () => {
          const service = await startServer(
            configPath,
            options.json
              ? {
                  info: writeStderr,
                  warn: writeStderr,
                }
              : undefined,
          );
          return service.info();
        },
        success: () => "Daemon started.",
        render: renderRuntimeInfo,
      });
    });

  daemon
    .command("stop")
    .description("Stop the local daemon if it is running.")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }, command: Command) => {
      const configPath = prepareInstanceConfig(command.parent?.parent as Command).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "stopping daemon",
        action: () => stopDaemonIfRunning(configPath),
        success: (result) => (result.stopped ? "Daemon stopped." : "Daemon already stopped."),
        render: renderDaemonStopResult,
      });
    });

  daemon
    .command("restart")
    .description("Restart the local daemon if it is already running.")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }, command: Command) => {
      const configPath = prepareInstanceConfig(command.parent?.parent as Command).configPath;
      await outputResult({
        json: Boolean(options.json),
        label: "restarting daemon",
        action: () => restartDaemonIfRunning(cliEntrypoint, configPath),
        success: (result) => (result.restarted ? "Daemon restarted." : "Daemon already stopped."),
        render: renderDaemonRestartResult,
      });
    });

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  const cliEntrypoint = argv[1] ?? "";
  const program = createProgram(cliEntrypoint);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message, { output: process.stderr, symbol: brandMark(), withGuide: false });
    process.exitCode = 1;
  }
}

if (matchesCliEntrypoint(import.meta.url, process.argv[1])) {
  void run();
}
