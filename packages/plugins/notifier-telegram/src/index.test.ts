import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@composio/ao-core";
import { create, getSessionMarker, manifest, SESSION_MARKER_PREFIX } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.needs_input",
    priority: "urgent",
    sessionId: "app-7",
    projectId: "my-project",
    timestamp: new Date("2026-03-05T11:00:00.000Z"),
    message: "Agent is waiting for your answer",
    data: {},
    ...overrides,
  };
}

describe("notifier-telegram", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    delete process.env["AO_TELEGRAM_BOT_TOKEN"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["TG_BOT_TOKEN"];
    delete process.env["TG_TOKEN"];
    delete process.env["AO_TELEGRAM_CHAT_ID"];
    delete process.env["TELEGRAM_CHAT_ID"];
    delete process.env["TG_CHAT_ID"];
  });

  it("has correct manifest", () => {
    expect(manifest.name).toBe("telegram");
    expect(manifest.slot).toBe("notifier");
  });

  it("builds deterministic session marker", () => {
    expect(SESSION_MARKER_PREFIX).toBe("AO_SESSION:");
    expect(getSessionMarker("app-1")).toBe("AO_SESSION:app-1");
  });

  it("sends event message to Telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: "123:abc", chatId: "-100100200" });
    await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/acme/repo/pull/42" } }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.chat_id).toBe("-100100200");
    expect(payload.text).toContain("AO_SESSION:app-7");
    expect(payload.text).toContain("https://github.com/acme/repo/pull/42");
  });

  it("formats actions as text entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: "123:abc", chatId: "42" });
    const actions: NotifyAction[] = [
      { label: "Open PR", url: "https://github.com/acme/repo/pull/42" },
      { label: "Kill", callbackEndpoint: "/api/sessions/app-7/kill" },
    ];

    await notifier.notifyWithActions!(makeEvent(), actions);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.text).toContain("Actions:");
    expect(payload.text).toContain("Open PR");
    expect(payload.text).toContain("/api/sessions/app-7/kill");
  });

  it("uses env fallback for token/chat", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "env-token";
    process.env["TELEGRAM_CHAT_ID"] = "-999";

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create();
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/botenv-token/sendMessage");
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.chat_id).toBe("-999");
  });

  it("does not send when token/chat missing", async () => {
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create();
    await notifier.notify(makeEvent());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing bot token or chat id"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on Telegram API error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: "123:abc", chatId: "42" });
    await expect(notifier.notify(makeEvent())).rejects.toThrow(
      "Telegram API failed (401): unauthorized",
    );
  });

  it("post() uses context channel override", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: "123:abc", chatId: "42" });
    await notifier.post!("hello", { channel: "-100500" });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.chat_id).toBe("-100500");
    expect(payload.text).toBe("hello");
  });
});
