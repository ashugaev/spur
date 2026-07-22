import { spinner } from "@clack/prompts";
import { formatSessionLinkDisplay } from "./session-link-display.js";
import type {
  RuntimeInfo,
  ServiceInstanceState,
  ServiceInstanceView,
  SessionState,
  SpawnResult,
  SessionView,
} from "./types.js";

const THEME = {
  accent: "#f04c4c",
  success: "#5fbf6a",
  warning: "#d7b34c",
  muted: "#8a8f98",
} as const;
export const BRAND_MARK = "𖤓";

function hexToAnsi(hex: string): string {
  const v = hex.replace("#", "");
  return `\u001b[38;2;${parseInt(v.slice(0, 2), 16)};${parseInt(v.slice(2, 4), 16)};${parseInt(v.slice(4, 6), 16)}m`;
}

const ACCENT = hexToAnsi(THEME.accent);
const SUCCESS = hexToAnsi(THEME.success);
const WARNING = hexToAnsi(THEME.warning);
const MUTED = hexToAnsi(THEME.muted);
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const SPINNER_FRAMES = [`${BRAND_MARK}  `, ` ${BRAND_MARK} `, `  ${BRAND_MARK}`, ` ${BRAND_MARK} `];
const MAX_BRANCH_WIDTH = 28;
const MAX_PROJECT_WIDTH = 20;
const MIN_ID_WIDTH = 8;
const MIN_STATE_WIDTH = 13;
const MIN_PROJECT_WIDTH = 12;
const MIN_AGENT_WIDTH = 6;
const DEFAULT_RENDER_WIDTH = 100;
const MAX_DETAIL_FIELDS = 8;

interface SessionRow {
  id: string;
  state: string;
  project: string;
  agent: string;
  branch: string;
}

interface SessionColumnWidths {
  id: number;
  state: number;
  project: number;
  agent: number;
}

function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined;
}

function colorize(text: string, code: string): string {
  if (!useColor()) return text;
  return `${code}${text}${RESET}`;
}

export function accent(text: string): string {
  return colorize(text, ACCENT);
}

export function brandMark(): string {
  return accent(BRAND_MARK);
}

export function brandLine(text: string): string {
  return accent(`${BRAND_MARK} ${text}`);
}

export function boldText(text: string): string {
  return colorize(text, BOLD);
}

export function dimText(text: string): string {
  return colorize(text, DIM);
}

function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

function supportsHyperlinks(): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }
  const term = process.env["TERM"] ?? "";
  return term !== "dumb";
}

function hyperlink(text: string, url: string): string {
  if (!supportsHyperlinks()) {
    return text;
  }
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

function formatSessionAssociations(session: SessionView): string[] {
  return (session.slots?.links ?? []).map((link) => {
    const display = formatSessionLinkDisplay(link);
    return hyperlink(display.text, display.url);
  });
}

function renderWidth(): number {
  const width = process.stdout.columns;
  return width > 0 ? width : DEFAULT_RENDER_WIDTH;
}

function formatRelativeTime(input: string): string {
  const timestamp = new Date(input).getTime();
  if (Number.isNaN(timestamp)) return "just now";
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function describeRow(session: SessionView): SessionRow {
  return {
    id: session.id,
    state: rowLabel(session),
    project: truncate(session.project, MAX_PROJECT_WIDTH),
    agent: session.agent,
    branch: truncate(session.branch, MAX_BRANCH_WIDTH),
  };
}

function rowLabel(session: SessionView): string {
  if (session.status === "paused") {
    return "Paused";
  }
  if (session.status === "completed") {
    return "Completed";
  }
  return stateLabel(session.state);
}

function stateLabel(state: SessionState): string {
  switch (state) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "needs_input":
      return "Needs Input";
    case "rate_limited":
      return "Rate Limited";
    case "stopped":
      return "Stopped";
    case "error":
      return "Error";
    case "killed":
      return "Killed";
  }
}

function statusColor(session: SessionView): string {
  const state = session.state;
  if (state === "working") return SUCCESS;
  if (state === "waiting" || state === "needs_input" || state === "rate_limited") return WARNING;
  if (state === "error") return ACCENT;
  return MUTED;
}

export function describeSession(session: SessionView): string {
  const facts = [`updated ${formatRelativeTime(session.lastActivityAt)}`];
  const services = session.services;

  if (session.stopReason === "manual_pause") {
    facts.push("stopped by user");
  } else if (session.status === "paused") {
    facts.push("paused by user");
  } else if (session.status === "completed") {
    facts.push("marked complete");
    facts.push("hidden from list");
  } else if (session.state === "working") {
    facts.push("processing");
  } else if (session.state === "waiting") {
    facts.push("waiting for next message");
  } else if (session.state === "needs_input") {
    facts.push("waiting for reply or approval");
  } else if (session.state === "rate_limited") {
    facts.push("hit rate or usage limit");
  } else if (session.state === "stopped") {
    facts.push("agent exited");
  } else if (session.state === "killed") {
    facts.push("killed by user");
    facts.push("not restorable");
  }

  facts.push(session.runtimeAlive ? "tmux live" : "tmux dead");
  if (session.worktree) {
    facts.push(session.workspaceExists ? "worktree live" : "worktree missing");
  } else {
    facts.push(session.workspaceExists ? "shared workspace live" : "shared workspace missing");
  }
  if (session.intervalWake) {
    facts.push("interval wake");
  } else if (session.dailyWake) {
    facts.push("daily wake");
  } else if (session.scheduledWake) {
    facts.push("wake scheduled");
  }

  if (session.state === "error" && session.error) {
    facts.push(`error ${truncate(session.error, 48)}`);
  }
  const liveServices = services.filter((service) => service.runtimeAlive);
  if (liveServices.length === 1) {
    const service = liveServices[0];
    if (service) {
      facts.push(
        service.port !== undefined
          ? `service ${service.serviceId}:${service.port}`
          : `service ${service.serviceId}`,
      );
    }
  } else if (liveServices.length > 1) {
    facts.push(`${liveServices.length} services live`);
  }
  facts.push(...formatSessionAssociations(session));

  return facts.join(" • ");
}

function formatInlineService(service: ServiceInstanceView): string {
  const base =
    service.port !== undefined ? `${service.serviceId}:${service.port}` : service.serviceId;
  return service.problemRuleIds.length > 0
    ? `${base}:${serviceStateLabel(service.state)}(${service.problemRuleIds.join(",")})`
    : `${base}:${serviceStateLabel(service.state)}`;
}

function measureSessionColumns(sessions: SessionView[]): SessionColumnWidths {
  const rows = sessions.map(describeRow);
  return {
    id: Math.max(MIN_ID_WIDTH, "id".length, ...rows.map((row) => row.id.length)),
    state: Math.max(MIN_STATE_WIDTH, "state".length, ...rows.map((row) => row.state.length)),
    project: Math.max(
      MIN_PROJECT_WIDTH,
      "project".length,
      ...rows.map((row) => row.project.length),
    ),
    agent: Math.max(MIN_AGENT_WIDTH, "agent".length, ...rows.map((row) => row.agent.length)),
  };
}

function renderSessionRow(session: SessionView, widths: SessionColumnWidths): string {
  const row = describeRow(session);
  return [
    accent(row.id.padEnd(widths.id)),
    `${renderStatusIndicator(session)}${boldText(row.state.padEnd(widths.state))}`,
    row.project.padEnd(widths.project),
    row.agent.padEnd(widths.agent),
    row.branch,
  ].join("  ");
}

function renderSessionHeader(widths: SessionColumnWidths): string {
  return dimText(
    [
      "id".padEnd(widths.id),
      "state".padEnd(widths.state + 2),
      "project".padEnd(widths.project),
      "agent".padEnd(widths.agent),
      "branch",
    ].join("  "),
  );
}

function renderStatusIndicator(session: SessionView): string {
  if (session.state === "needs_input") {
    return colorize("! ", `${BOLD}${WARNING}`);
  }
  return `${colorize("●", statusColor(session))} `;
}

export function renderEmptyState(message: string, hint?: string): string {
  return hint ? `${message}\n${dimText(hint)}` : message;
}

export function renderSessionCard(
  session: SessionView,
  widths = measureSessionColumns([session]),
): string {
  const lines = [`${renderSessionRow(session, widths)}`, `  ${dimText(describeSession(session))}`];
  return lines.join("\n");
}

export function renderSessionList(sessions: SessionView[]): string {
  if (sessions.length === 0) {
    return renderEmptyState("No sessions.", "Run `spur spawn <project>` to start one.");
  }

  const widths = measureSessionColumns(sessions);
  return sessions.map((session) => renderSessionCard(session, widths)).join("\n");
}

export function renderSpawnResult(result: SpawnResult): string {
  if (result.sessions.length <= 1) {
    return renderSessionCard(result.sessions[0] ?? result);
  }
  const heading = result.groupId
    ? brandLine(`Spawned group ${result.groupId} (${result.sessions.length} sessions)`)
    : brandLine(`Spawned ${result.sessions.length} sessions`);
  return `${heading}\n${renderSessionList(result.sessions)}`;
}

export function renderRuntimeInfo(info: RuntimeInfo): string {
  const lines = [
    `${brandMark()} ${boldText("daemon")} ${boldText(`${info.host}:${info.port}`)}`,
    `${dimText(`pid ${info.pid} • started ${formatRelativeTime(info.startedAt)}`)}`,
    `${dimText(`config ${info.configPath}`)}`,
    `${dimText(`data ${info.dataDir}`)}`,
    `${dimText(`worktrees ${info.worktreeDir}`)}`,
  ];
  return lines.join("\n");
}

export function renderRuntimeSummary(info: RuntimeInfo): string {
  const width = renderWidth();
  const line1 = truncate(
    `daemon ${info.host}:${info.port}  pid ${info.pid}  started ${formatRelativeTime(info.startedAt)}`,
    width,
  );
  const line2 = truncate(
    `config ${info.configPath}  data ${info.dataDir}  worktrees ${info.worktreeDir}`,
    width,
  );
  return `${line1}\n${dimText(line2)}`;
}

function renderSessionDetailsPane(args: {
  selected: SessionView | null;
  maxDetailLines: number;
}): string[] {
  if (!args.selected) {
    return [brandLine("Selected"), dimText("Use ↑↓ to reselect before acting.")];
  }

  const selected = args.selected;
  const services = selected.services;
  const title = brandLine(`Selected ${selected.id}`);
  if (args.maxDetailLines <= 0) {
    return [title];
  }

  const width = renderWidth();
  const renderField = (label: string, value: string): string => {
    const prefix = `${label} `;
    return `${boldText(label)} ${truncate(value, Math.max(1, width - prefix.length))}`;
  };

  const fields = [
    renderField(
      "branch",
      selected.branchSource ? `${selected.branch} (${selected.branchSource})` : selected.branch,
    ),
    ...formatSessionAssociations(selected).map((value) => renderField("link", value)),
    renderField("prompt", selected.prompt),
    renderField("tmux", selected.tmuxSession),
    renderField("workspace", selected.worktreePath),
    renderField("launch", selected.launchCommand),
    ...services.map((service) => renderField("service", formatInlineService(service))),
    renderField("created", selected.createdAt),
    renderField("updated", selected.updatedAt),
  ];

  return [title, ...fields.slice(0, Math.min(args.maxDetailLines, MAX_DETAIL_FIELDS))];
}

export function renderSessionDashboard(args: {
  info: RuntimeInfo;
  sessions: SessionView[];
}): string {
  const lines = [renderRuntimeSummary(args.info), "", brandLine("Sessions"), ""];
  lines.push(renderSessionList(args.sessions));
  return lines.join("\n");
}

export function renderWaitingInputAlert(args: {
  sessions: SessionView[];
  selectedSessionId: string | null;
}): string | undefined {
  const waiting = args.sessions.filter((session) => session.state === "needs_input");
  if (waiting.length === 0) {
    return undefined;
  }
  const lead = waiting.find((session) => session.id === args.selectedSessionId) ?? waiting[0];
  if (!lead) {
    return undefined;
  }
  const message =
    waiting.length === 1
      ? `NEEDS INPUT ${lead.id} needs a reply`
      : `NEEDS INPUT ${waiting.length} sessions need a reply (${lead.id})`;
  return colorize(`! ${message}`, `${BOLD}${ACCENT}`);
}

export function renderInteractiveSessionList(args: {
  info: RuntimeInfo;
  sessions: SessionView[];
  selectedSessionId: string | null;
  totalSessions: number;
  windowStart: number;
  maxDetailLines: number;
  waitingInputAlert?: string;
  statusMessage?: string;
}): string {
  const lines: string[] = [];
  if (args.waitingInputAlert) {
    lines.push(args.waitingInputAlert, "");
  }
  lines.push(renderRuntimeSummary(args.info), "");
  if (args.sessions.length === 0) {
    lines.push(
      brandLine("Sessions"),
      "",
      renderEmptyState("No sessions.", "Run `spur spawn <project>` to start one."),
      "",
      brandLine("Selected"),
      dimText("No session selected."),
      "",
      dimText("Esc quit"),
    );
    if (args.statusMessage) {
      lines.push("", args.statusMessage);
    }
    return lines.join("\n");
  }

  const selected = args.sessions.find((session) => session.id === args.selectedSessionId) ?? null;
  const windowEnd = args.windowStart + args.sessions.length;
  const widths = measureSessionColumns(args.sessions);
  const title =
    args.totalSessions > args.sessions.length
      ? `Sessions ${args.windowStart + 1}-${windowEnd} / ${args.totalSessions}`
      : "Sessions";
  lines.push(brandLine(title), `  ${renderSessionHeader(widths)}`);
  for (const session of args.sessions) {
    const selectedMark = session.id === selected?.id ? accent("›") : " ";
    lines.push(`${selectedMark} ${renderSessionRow(session, widths)}`);
  }

  const detailLines = renderSessionDetailsPane({
    selected,
    maxDetailLines: args.maxDetailLines,
  });
  lines.push(
    "",
    ...detailLines,
    "",
    dimText(
      "↑↓ move  Enter attach  l logs  p pause  c complete  r restore  k kill  Ctrl+G detach  Esc quit",
    ),
  );
  if (args.statusMessage) {
    lines.push("", args.statusMessage);
  }
  return lines.join("\n");
}

export async function withSpinner<T>(label: string, action: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) {
    return action();
  }
  const loading = spinner({
    output: process.stderr,
    frames: SPINNER_FRAMES,
    styleFrame: accent,
  });
  loading.start(label);

  try {
    return await action();
  } finally {
    loading.clear();
  }
}

function serviceStateLabel(state: ServiceInstanceState): string {
  switch (state) {
    case "running":
      return "running";
    case "problem":
      return "problem";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function serviceStateColor(state: ServiceInstanceState): string {
  if (state === "running") return SUCCESS;
  if (state === "problem") return WARNING;
  if (state === "error") return ACCENT;
  return MUTED;
}

export function renderServiceCard(service: ServiceInstanceView): string {
  const lines = [
    `${accent(service.port !== undefined ? `${service.serviceId}:${service.port}` : service.serviceId)}  ${colorize(serviceStateLabel(service.state), `${BOLD}${serviceStateColor(service.state)}`)}  ${dimText(`updated ${formatRelativeTime(service.lastActivityAt)}`)}`,
    `  ${dimText(`tmux ${service.tmuxSession}${service.port !== undefined ? ` • port ${service.port}` : ""} • cwd ${service.cwd}`)}`,
    `  ${dimText(`command ${truncate(service.command, Math.max(20, renderWidth() - 12))}`)}`,
  ];
  if (service.problemRuleIds.length > 0) {
    lines.push(`  ${dimText(`rules ${service.problemRuleIds.join(", ")}`)}`);
  }
  if (service.state === "error" && service.error) {
    lines.push(`  ${dimText(`error ${truncate(service.error, 80)}`)}`);
  }
  return lines.join("\n");
}

export function renderServiceList(services: ServiceInstanceView[]): string {
  if (services.length === 0) {
    return renderEmptyState(
      "No services.",
      "Run `spur service run <serviceId> -- <command...>` inside the session.",
    );
  }
  return services.map((service) => renderServiceCard(service)).join("\n");
}
