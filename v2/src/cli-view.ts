import { spinner } from "@clack/prompts";
import { formatSessionLinkDisplay } from "./session-link-display.js";
import type {
  RuntimeInfo,
  ServiceInstanceState,
  ServiceInstanceView,
  SessionListItemView,
  SessionSidecarView,
  SessionState,
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

function formatSessionAssociations(session: SessionListItemView): string[] {
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

// Largest unit only, no "ago" suffix — the caller prefixes it with the
// sidecar name, so "sidecar front-local 13h" reads as a duration, not a
// timestamp. Mirrors packages/web's own formatSidecarAge; not shared code
// (CLI and web are separate deployables), same shape by convention only.
function formatSidecarAgeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Compact indicator so a stale sidecar is visible in `spur list` without a
// second command — quiet (no fact added) when no sidecar has a resolvable
// age, so a session with no sidecars, or sidecars whose age cannot be
// resolved, renders unchanged. Names only the single oldest sidecar even
// when several are running, keeping the facts line terse; the count for
// the rest is folded into "+N more".
function describeSidecarAge(session: SessionListItemView): string | null {
  const aged = session.sidecars.filter(
    (sidecar): sidecar is SessionSidecarView & { ageSeconds: number } =>
      sidecar.ageSeconds !== undefined,
  );
  if (aged.length === 0) return null;
  const oldest = aged.reduce((a, b) => (b.ageSeconds > a.ageSeconds ? b : a));
  const rest = aged.length - 1;
  const warnMark = oldest.ageWarn ? "!" : "";
  const suffix = rest > 0 ? ` +${rest} more` : "";
  return `sidecar ${oldest.name} ${formatSidecarAgeSeconds(oldest.ageSeconds)}${warnMark}${suffix}`;
}

// Counts only `messages` (real queued sends), never `pipelineMessages` (a
// pipeline's own future auto-steps).
export function queuedMessageCount(session: SessionListItemView): number {
  return session.queuedMessages?.messages.length ?? 0;
}

// Compact indicator so a session holding real queued messages is visible in
// `spur list` without a second command — quiet (no fact added) when the queue
// is empty or absent.
function describeQueueDepth(session: SessionListItemView): string | null {
  const count = queuedMessageCount(session);
  return count > 0 ? `queued ${count}` : null;
}

function describeRow(session: SessionListItemView): SessionRow {
  return {
    id: session.id,
    state: rowLabel(session),
    project: truncate(session.project, MAX_PROJECT_WIDTH),
    agent: session.agent,
    branch: truncate(session.branch, MAX_BRANCH_WIDTH),
  };
}

function rowLabel(session: SessionListItemView): string {
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
    case "stale":
      return "Stale";
    case "stopped":
      return "Stopped";
    case "error":
      return "Error";
    case "killed":
      return "Killed";
  }
}

function statusColor(session: SessionListItemView): string {
  const state = session.state;
  if (state === "working") return SUCCESS;
  if (state === "waiting" || state === "needs_input" || state === "rate_limited") return WARNING;
  if (state === "error") return ACCENT;
  return MUTED;
}

export function describeSession(session: SessionListItemView): string {
  const facts = [`updated ${formatRelativeTime(session.lastActivityAt)}`];
  const services = session.services;

  if (session.stopReason === "manual_pause") {
    facts.push("stopped by user");
  } else if (session.stopReason === "stale_timeout") {
    facts.push("parked by idle timeout");
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
  const queueDepth = describeQueueDepth(session);
  if (queueDepth) {
    facts.push(queueDepth);
  }
  const sidecarAge = describeSidecarAge(session);
  if (sidecarAge) {
    facts.push(sidecarAge);
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

function measureSessionColumns(sessions: SessionListItemView[]): SessionColumnWidths {
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

function renderSessionRow(session: SessionListItemView, widths: SessionColumnWidths): string {
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

function renderStatusIndicator(session: SessionListItemView): string {
  if (session.state === "needs_input") {
    return colorize("! ", `${BOLD}${WARNING}`);
  }
  return `${colorize("●", statusColor(session))} `;
}

export function renderEmptyState(message: string, hint?: string): string {
  return hint ? `${message}\n${dimText(hint)}` : message;
}

export function renderSessionCard(
  session: SessionListItemView,
  widths = measureSessionColumns([session]),
): string {
  const lines = [`${renderSessionRow(session, widths)}`, `  ${dimText(describeSession(session))}`];
  return lines.join("\n");
}

export function renderSessionList(sessions: SessionListItemView[]): string {
  if (sessions.length === 0) {
    return renderEmptyState("No sessions.", "Run `spur spawn <project>` to start one.");
  }

  const widths = measureSessionColumns(sessions);
  return sessions.map((session) => renderSessionCard(session, widths)).join("\n");
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
  detailLoading: boolean;
  maxDetailLines: number;
}): string[] {
  if (!args.selected) {
    return args.detailLoading
      ? [brandLine("Selected"), dimText("Loading …")]
      : [brandLine("Selected"), dimText("Use ↑↓ to reselect before acting.")];
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

  const queueDepth = queuedMessageCount(selected);
  const fields = [
    renderField(
      "branch",
      selected.branchSource ? `${selected.branch} (${selected.branchSource})` : selected.branch,
    ),
    ...(queueDepth > 0 ? [renderField("queued", String(queueDepth))] : []),
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
  sessions: SessionListItemView[];
}): string {
  const lines = [renderRuntimeSummary(args.info), "", brandLine("Sessions"), ""];
  lines.push(renderSessionList(args.sessions));
  return lines.join("\n");
}

export function renderWaitingInputAlert(args: {
  sessions: SessionListItemView[];
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
  sessions: SessionListItemView[];
  selectedSessionId: string | null;
  selectedDetail: SessionView | null;
  detailLoading: boolean;
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

  const windowEnd = args.windowStart + args.sessions.length;
  const widths = measureSessionColumns(args.sessions);
  const title =
    args.totalSessions > args.sessions.length
      ? `Sessions ${args.windowStart + 1}-${windowEnd} / ${args.totalSessions}`
      : "Sessions";
  lines.push(brandLine(title), `  ${renderSessionHeader(widths)}`);
  for (const session of args.sessions) {
    const selectedMark = session.id === args.selectedSessionId ? accent("›") : " ";
    lines.push(`${selectedMark} ${renderSessionRow(session, widths)}`);
  }

  const detailLines = renderSessionDetailsPane({
    selected: args.selectedDetail,
    detailLoading: args.detailLoading,
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
