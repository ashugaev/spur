import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelegramWorkbench,
  renderDetail,
  renderInbox,
  renderLauncher,
  safeWorkbenchUrl,
  workbenchSessions,
  type InboxCard,
  type LaunchCard,
} from "../../src/event-sources/telegram-workbench.js";
import type { SourceWorkSessionItem } from "../../src/event-sources/types.js";

const owner = { userId: 1, chatId: -2, threadId: 3 };
const session: SourceWorkSessionItem = {
  id: "task-1",
  project: "app",
  agent: "codex",
  state: "needs_input",
  status: "running",
  model: null,
  lastActivityAt: "2026-10-04T12:00:00Z",
  runtimeAlive: true,
  canContinue: true,
  restorable: false,
};

afterEach(() => vi.useRealTimers());

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture");
  return value;
}

describe("Telegram workbench cards", () => {
  it("claims one opaque revision atomically; foreign owners and messages cannot consume it", () => {
    const store = new TelegramWorkbench();
    const card = required(store.create(owner, "task"));
    card.messageId = 7;
    const keyboard = store.keyboard(card, {
      text: "task",
      rows: [[{ text: "Close", action: { kind: "close" } }]],
    });
    const data = required(keyboard.inline_keyboard[0]?.[0]);
    if (!("callback_data" in data)) throw new Error("expected callback");
    expect(Buffer.byteLength(data.callback_data)).toBeLessThanOrEqual(64);
    for (const foreign of [
      { ...owner, userId: 8 },
      { ...owner, chatId: 8 },
      { ...owner, threadId: 8 },
    ]) {
      expect(store.claim(foreign, 7, data.callback_data)).toBeNull();
    }
    expect(store.claim(owner, 8, data.callback_data)).toBeNull();
    expect(store.claim(owner, 7, data.callback_data.replace(/:0$/, ":9"))).toBeNull();
    expect(store.claim(owner, 7, data.callback_data)).toEqual({ card, action: { kind: "close" } });
    expect(store.claim(owner, 7, data.callback_data)).toBeNull();
  });

  it("rotates tokens and expires from creation, not last render", () => {
    vi.useFakeTimers();
    const store = new TelegramWorkbench();
    const card = required(store.create(owner));
    card.messageId = 7;
    const view = { text: "card", rows: [[{ text: "Close", action: { kind: "close" as const } }]] };
    const first = required(store.keyboard(card, view).inline_keyboard[0]?.[0]);
    vi.advanceTimersByTime(9 * 60_000);
    const second = required(store.keyboard(card, view).inline_keyboard[0]?.[0]);
    if (!("callback_data" in first) || !("callback_data" in second)) throw new Error("callback");
    expect(store.claim(owner, 7, first.callback_data)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(store.claim(owner, 7, second.callback_data)).toBeNull();
    expect(store.current(card)).toBe(false);
  });

  it("requires a confirmed message id, replaces only same-kind same-scope cards and clears on stop", () => {
    const store = new TelegramWorkbench();
    const first = required(store.create(owner, "first"));
    store.keyboard(first, { text: "card", rows: [] });
    expect(store.claim(owner, undefined, "spur_wb:fake:0")).toBeNull();
    const inbox = required(store.create(owner));
    const next = required(store.create(owner, "next"));
    expect(store.current(first)).toBe(false);
    expect(store.current(inbox)).toBe(true);
    expect(store.current(next)).toBe(true);
    store.clear();
    expect(store.current(inbox)).toBe(false);
  });

  it("rejects capacity without evicting an in-flight card", () => {
    const store = new TelegramWorkbench();
    const first = required(store.create(owner));
    for (let userId = 2; userId <= 100; userId++)
      expect(store.create({ ...owner, userId })).not.toBeNull();
    expect(store.create({ ...owner, userId: 101 })).toBeNull();
    expect(store.current(first)).toBe(true);
  });

  it("remembers project only in exact owner scope and discards removed preference", () => {
    const store = new TelegramWorkbench();
    const projects = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ];
    store.remember(owner, "b");
    expect(store.projects(owner, projects).map((project) => project.id)).toEqual(["b", "a"]);
    expect(
      store.projects({ ...owner, threadId: 9 }, projects).map((project) => project.id),
    ).toEqual(["a", "b"]);
    store.projects(owner, [required(projects[0])]);
    expect(store.projects(owner, projects).map((project) => project.id)).toEqual(["a", "b"]);
  });
});

describe("Telegram workbench views", () => {
  it("launches displayed options without task text in callbacks and caps page at six", () => {
    const card = new TelegramWorkbench().create(owner, "private task") as LaunchCard;
    const projects = Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
    }));
    const options = projects.map((project) => ({
      project: project.id,
      agent: "codex" as const,
      model: null,
      mode: null,
      modes: [],
    }));
    const view = renderLauncher(card, projects, options);
    expect(
      view.rows.flat().filter((button) => "action" in button && button.action.kind === "launch"),
    ).toHaveLength(6);
    expect(view.text).toContain("provider default");
    card.page = 99;
    renderLauncher(card, projects, options);
    expect(card.page).toBe(1);
  });

  it("orders attention/working/recent by activity, not identifier", () => {
    const rows: SourceWorkSessionItem[] = [
      session,
      { ...session, id: "a", state: "error", lastActivityAt: "2026-10-04T13:00:00Z" },
      { ...session, id: "z", state: "working" },
      { ...session, id: "spawn", state: "waiting", status: "spawning" },
    ];
    expect(workbenchSessions(rows, "attention").map((row) => row.id)).toEqual(["a", "task-1"]);
    expect(workbenchSessions(rows, "working").map((row) => row.id)).toEqual(["spawn", "z"]);
    expect(workbenchSessions(rows, "recent")[0]?.id).toBe("a");
  });

  it("keeps navigation visible for empty attention and renders only eligible explicit mutations", () => {
    const card = new TelegramWorkbench().create(owner) as InboxCard;
    const empty = renderInbox(card, []);
    expect(empty.text).toContain("No tasks need attention");
    expect(empty.rows.flat().some((button) => button.text === "recent")).toBe(true);
    const live = renderDetail(card, session, true);
    expect(live.rows.flat().some((button) => button.text === "Continue here")).toBe(true);
    expect(live.text).toContain("not approval");
    const stopped = { ...session, canContinue: false, restorable: true };
    expect(
      renderDetail(card, stopped, false)
        .rows.flat()
        .some((button) => button.text.startsWith("Restore")),
    ).toBe(false);
    expect(
      renderDetail(card, stopped, true)
        .rows.flat()
        .some((button) => button.text.startsWith("Restore")),
    ).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/x",
    "https://user:secret@example.test/pr",
    "not-url",
  ])("rejects unsafe PR URL %s", (url) => {
    expect(safeWorkbenchUrl(url)).toBeUndefined();
  });
});
