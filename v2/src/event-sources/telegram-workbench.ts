import { randomBytes } from "node:crypto";
import type { AgentName } from "../types.js";
import type { SourceLaunchOptions, SourceProjectListItem, SourceWorkSessionItem } from "./types.js";

export const WORKBENCH_CALLBACK_PREFIX = "spur_wb:";
const CARD_TTL_MS = 10 * 60_000;
const CARD_LIMIT = 100;
const PAGE_SIZE = 6;

export interface WorkbenchOwner {
  userId: number;
  chatId: number;
  threadId?: number;
}

export type WorkbenchTab = "attention" | "working" | "recent";
export type WorkbenchAction =
  | { kind: "close" }
  | { kind: "launch"; options: SourceLaunchOptions }
  | { kind: "projects"; page: number }
  | { kind: "settings"; project?: string }
  | { kind: "agent"; agent?: AgentName }
  | { kind: "mode"; mode?: string }
  | { kind: "list"; tab: WorkbenchTab; page: number }
  | { kind: "detail"; sessionId: string }
  | { kind: "continue"; sessionId: string; project: string }
  | { kind: "restore"; sessionId: string; project: string };

interface CardBase {
  owner: WorkbenchOwner;
  createdAt: number;
  messageId?: number | undefined;
  token?: string | undefined;
  actions: WorkbenchAction[];
}

export interface LaunchCard extends CardBase {
  kind: "launch";
  task: string;
  page: number;
  project?: string | undefined;
  agent?: AgentName | undefined;
  mode?: string | undefined;
  createdSessionId?: string;
}

export interface InboxCard extends CardBase {
  kind: "inbox";
  tab: WorkbenchTab;
  page: number;
  sessionId?: string | undefined;
}

export type WorkbenchCard = LaunchCard | InboxCard;
export interface WorkbenchView {
  text: string;
  rows: ({ text: string; action: WorkbenchAction } | { text: string; url: string })[][];
}

function scope(owner: WorkbenchOwner): string {
  return `${owner.chatId}:${owner.threadId ?? "main"}:${owner.userId}`;
}

/** Runtime-local UI records. Claimed revisions have no token until rendered again. */
export class TelegramWorkbench {
  private readonly cards = new Map<string, WorkbenchCard>();
  private readonly recent = new Map<string, string>();

  private key(owner: WorkbenchOwner, kind: WorkbenchCard["kind"]): string {
    return `${scope(owner)}:${kind}`;
  }

  prune(now = Date.now()): void {
    for (const [key, card] of this.cards) {
      if (now - card.createdAt >= CARD_TTL_MS) this.cards.delete(key);
    }
  }

  invalidate(owner: WorkbenchOwner, kind: WorkbenchCard["kind"]): void {
    this.cards.delete(this.key(owner, kind));
  }

  create(owner: WorkbenchOwner, task?: string): WorkbenchCard | null {
    this.prune();
    const kind = task === undefined ? "inbox" : "launch";
    this.invalidate(owner, kind);
    if (this.cards.size >= CARD_LIMIT) return null;
    const base = { owner, createdAt: Date.now(), actions: [] };
    const card: WorkbenchCard =
      task === undefined
        ? { ...base, kind: "inbox", tab: "attention", page: 0 }
        : { ...base, kind: "launch", task, page: 0 };
    this.cards.set(this.key(owner, kind), card);
    return card;
  }

  current(card: WorkbenchCard): boolean {
    this.prune();
    return this.cards.get(this.key(card.owner, card.kind)) === card;
  }

  keyboard(
    card: WorkbenchCard,
    view: WorkbenchView,
  ): {
    inline_keyboard: ({ text: string; callback_data: string } | { text: string; url: string })[][];
  } {
    card.token = randomBytes(16).toString("hex");
    card.actions = [];
    return {
      inline_keyboard: view.rows.map((row) =>
        row.map((button) => {
          if ("url" in button) return button;
          const index = card.actions.push(button.action) - 1;
          return {
            text: button.text,
            callback_data: `${WORKBENCH_CALLBACK_PREFIX}${card.token}:${index}`,
          };
        }),
      ),
    };
  }

  claim(
    owner: WorkbenchOwner,
    messageId: number | undefined,
    data: string,
  ): { card: WorkbenchCard; action: WorkbenchAction } | null {
    this.prune();
    const match = data.match(/^spur_wb:([a-f0-9]{32}):(\d+)$/);
    if (!match || messageId === undefined) return null;
    for (const kind of ["launch", "inbox"] as const) {
      const card = this.cards.get(this.key(owner, kind));
      if (!card || card.messageId !== messageId || card.token !== match[1]) continue;
      const action = card.actions[Number(match[2])];
      if (!action) return null;
      card.token = undefined;
      card.actions = [];
      return { card, action };
    }
    return null;
  }

  remember(owner: WorkbenchOwner, project: string): void {
    const key = scope(owner);
    this.recent.delete(key);
    const oldest = this.recent.keys().next().value;
    if (this.recent.size >= CARD_LIMIT && oldest !== undefined) this.recent.delete(oldest);
    this.recent.set(key, project);
  }

  projects(owner: WorkbenchOwner, projects: SourceProjectListItem[]): SourceProjectListItem[] {
    const key = scope(owner);
    const recent = this.recent.get(key);
    if (recent && !projects.some((project) => project.id === recent)) this.recent.delete(key);
    return [...projects].sort(
      (left, right) =>
        Number(right.id === recent) - Number(left.id === recent) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  }

  clear(): void {
    this.cards.clear();
    this.recent.clear();
  }
}

function page<T>(items: T[], requested: number): { items: T[]; index: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const index = Math.max(0, Math.min(requested, pages - 1));
  return { items: items.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), index, pages };
}

function short(text: string, limit = 64): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function renderLauncher(
  card: LaunchCard,
  projects: SourceProjectListItem[],
  options: SourceLaunchOptions[],
): WorkbenchView {
  const current = page(projects, card.page);
  card.page = current.index;
  const rows: WorkbenchView["rows"] = [];
  const lines = [`New task: ${short(card.task, 800)}`];
  for (const project of current.items) {
    const defaults = options.find((entry) => entry.project === project.id);
    if (!defaults) {
      lines.push(`${project.name}: unavailable`);
      continue;
    }
    lines.push(
      `${project.name}: ${defaults.agent} · ${defaults.model ?? "provider default"} · ${defaults.mode ?? "no mode"}`,
    );
    rows.push([
      { text: short(`Launch ${project.name}`), action: { kind: "launch", options: defaults } },
    ]);
  }
  if (!projects.length) lines.push("No configured spawnable projects.");
  if (current.pages > 1) {
    rows.push([
      { text: "‹", action: { kind: "projects", page: current.index - 1 } },
      {
        text: `${current.index + 1}/${current.pages} ›`,
        action: { kind: "projects", page: current.index + 1 },
      },
    ]);
  }
  rows.push([
    { text: "Settings", action: { kind: "settings" } },
    { text: "Cancel", action: { kind: "close" } },
  ]);
  return { text: lines.join("\n"), rows };
}

export function renderSettings(card: LaunchCard, options: SourceLaunchOptions): WorkbenchView {
  return {
    text: `Task: ${short(card.task, 800)}\n${options.project}: ${options.agent} · ${options.model ?? "provider default"} · ${options.mode ?? "no mode"}`,
    rows: [
      ["claude", "codex", "cursor", "opencode"].map((agent) => ({
        text: agent,
        action: { kind: "agent", agent: agent as AgentName },
      })),
      [{ text: "Default engine", action: { kind: "agent" } }],
      ...options.modes.map((mode) => [
        { text: short(mode), action: { kind: "mode" as const, mode } },
      ]),
      [{ text: "Default mode", action: { kind: "mode" } }],
      [{ text: "Launch", action: { kind: "launch", options } }],
      [
        { text: "Projects", action: { kind: "projects", page: 0 } },
        { text: "Cancel", action: { kind: "close" } },
      ],
    ],
  };
}

export function workbenchSessions(
  sessions: SourceWorkSessionItem[],
  tab: WorkbenchTab,
): SourceWorkSessionItem[] {
  return sessions
    .filter((session) =>
      tab === "attention"
        ? ["needs_input", "error", "rate_limited"].includes(session.state)
        : tab === "working"
          ? session.state === "working" || session.status === "spawning"
          : true,
    )
    .sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) || left.id.localeCompare(right.id),
    );
}

export function renderInbox(card: InboxCard, sessions: SourceWorkSessionItem[]): WorkbenchView {
  const current = page(workbenchSessions(sessions, card.tab), card.page);
  card.page = current.index;
  return {
    text: `${card.tab === "attention" ? "Attention" : card.tab === "working" ? "Working" : "Recent"}\n${current.items.length ? "Select a task to inspect." : card.tab === "attention" ? "No tasks need attention." : "No tasks."}`,
    rows: [
      ...current.items.map((session) => [
        {
          text: short(`${session.project} · ${session.title || session.id} · ${session.state}`),
          action: { kind: "detail" as const, sessionId: session.id },
        },
      ]),
      ["attention", "working", "recent"].map((tab) => ({
        text: tab,
        action: { kind: "list", tab: tab as WorkbenchTab, page: 0 },
      })),
      ...(current.pages > 1
        ? [
            [
              {
                text: "‹",
                action: { kind: "list" as const, tab: card.tab, page: current.index - 1 },
              },
              {
                text: `${current.index + 1}/${current.pages} ›`,
                action: { kind: "list" as const, tab: card.tab, page: current.index + 1 },
              },
            ],
          ]
        : []),
      [
        { text: "Refresh", action: { kind: "list", tab: card.tab, page: card.page } },
        { text: "Close", action: { kind: "close" } },
      ],
    ],
  };
}

export function safeWorkbenchUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function renderDetail(
  card: InboxCard,
  session: SourceWorkSessionItem,
  spawnable: boolean,
): WorkbenchView {
  const rows: WorkbenchView["rows"] = [];
  if (session.canContinue)
    rows.push([
      {
        text: "Continue here",
        action: { kind: "continue", sessionId: session.id, project: session.project },
      },
    ]);
  if (session.restorable && spawnable)
    rows.push([
      {
        text: "Restore and continue here",
        action: { kind: "restore", sessionId: session.id, project: session.project },
      },
    ]);
  const url = safeWorkbenchUrl(session.prUrl);
  if (url) rows.push([{ text: "PR", url }]);
  rows.push([
    { text: "Back", action: { kind: "list", tab: card.tab, page: card.page } },
    { text: "Refresh", action: { kind: "detail", sessionId: session.id } },
    { text: "Close", action: { kind: "close" } },
  ]);
  return {
    text: `${short(session.title || session.id, 800)}\n${session.id} · ${session.project}\n${session.agent} · ${session.model ?? "provider default"} · ${session.mode ?? "no mode"}\n${session.state} (${session.status})\nLast activity: ${session.lastActivityAt}\nContinue routes plain messages in this chat/topic to this task.${session.state === "needs_input" ? "\nTerminal questions still require the agent's terminal; Continue is not approval." : ""}`,
    rows,
  };
}
