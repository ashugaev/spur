import { test, expect, devices, type Page } from "playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeWorkingSession,
  makeCompletedSession,
  makeNeedsInputSession,
  makeSpawningSession,
  makeStoppedSession,
  mockAgentModels,
  mockSpawnDefaults,
} from "./fixtures.js";

type ElementBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function boxesOverlap(first: ElementBox, second: ElementBox): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

async function expectArtifactControlsOutsideSurface(page: Page): Promise<void> {
  const surfaceBox = await page.getByLabel("Artifact preview surface").boundingBox();
  const previousBox = await page.getByRole("button", { name: "Previous artifact" }).boundingBox();
  const nextBox = await page.getByRole("button", { name: "Next artifact" }).boundingBox();

  expect(surfaceBox).not.toBeNull();
  expect(previousBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  if (!surfaceBox || !previousBox || !nextBox) {
    throw new Error("Artifact lightbox layout missing bounds");
  }

  expect(boxesOverlap(previousBox, surfaceBox)).toBe(false);
  expect(boxesOverlap(nextBox, surfaceBox)).toBe(false);
}

async function mockTerminalWebSocket(page: Page) {
  await page.addInitScript(() => {
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = MockWebSocket.CONNECTING;
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      protocol = "";
      url: string;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        state.sockets.push(this);
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {}

      close(code?: number, reason?: string) {
        if (this.readyState >= MockWebSocket.CLOSING) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(
          new CloseEvent("close", {
            code: code ?? 1000,
            reason: reason ?? "Closed",
            wasClean: true,
          }),
        );
      }

      addEventListener() {}

      removeEventListener() {}

      dispatchEvent() {
        return true;
      }
    }

    const state = {
      sockets: [] as MockWebSocket[],
    };

    Object.defineProperty(window, "__directTerminalWsState", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });
  });
}

async function getTerminalSocketCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const windowWithState = window as unknown as {
      __directTerminalWsState?: {
        sockets: Array<{ url?: string }>;
      };
    };
    return (
      windowWithState.__directTerminalWsState?.sockets.filter((socket) =>
        socket.url?.includes("/ws?session="),
      ).length ?? 0
    );
  });
}

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  return page.route(`**/api/sessions/${session.id}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

function mockSessionConversation(
  page: Page,
  sessionId: string,
  state: "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed",
) {
  return page.route(`**/api/sessions/${sessionId}/conversation`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [], durationMs: 0, state }),
    });
  });
}

function mockSessionConversationPayload(
  page: Page,
  sessionId: string,
  payload: {
    messages: Array<{ role: "user" | "assistant"; text: string; timestampMs: number }>;
    durationMs: number;
    state: "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
  },
) {
  return page.route(`**/api/sessions/${sessionId}/conversation`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

function mockSessionLogs(page: Page, sessionId: string, payload: Array<Record<string, unknown>>) {
  return page.route(`**/api/sessions/${sessionId}/logs`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

function mockVoiceStatus(page: Page) {
  return page.route("**/api/runtime/voice", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
    });
  });
}

function mockVoiceTranscribe(page: Page, text: string, onRequest?: () => void) {
  return page.route("**/api/runtime/voice/transcribe", async (route) => {
    onRequest?.();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });
}

async function installVoiceMediaMocks(page: Page) {
  await page.addInitScript(() => {
    class TestMediaRecorder {
      mimeType = "audio/webm";
      state = "inactive";
      private listeners = new Map<string, Array<(event?: unknown) => void>>();

      addEventListener(type: string, listener: (event?: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        const blob = new Blob(["voice-audio"], { type: this.mimeType });
        this.emit("dataavailable", blob);
        this.emit("stop");
      }

      private emit(type: string, data?: Blob) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(data ? { data } : undefined);
        }
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    });
  });
}

async function dispatchTouchSwipe(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: end.x, y: end.y }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

async function dispatchPointerPinch(
  surface: ReturnType<Page["locator"]>,
  startGap: number,
  endGap: number,
) {
  const box = await surface.boundingBox();
  if (!box) throw new Error("Artifact pinch surface missing bounds");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const pointerInit = (id: number, x: number, y: number) => ({
    pointerId: id,
    pointerType: "touch",
    clientX: x,
    clientY: y,
    isPrimary: id === 1,
    bubbles: true,
  });
  await surface.dispatchEvent("pointerdown", pointerInit(1, cx - startGap, cy));
  await surface.dispatchEvent("pointerdown", pointerInit(2, cx + startGap, cy));
  await surface.dispatchEvent("pointermove", pointerInit(1, cx - endGap, cy));
  await surface.dispatchEvent("pointermove", pointerInit(2, cx + endGap, cy));
  await surface.dispatchEvent("pointerup", pointerInit(1, cx - endGap, cy));
  await surface.dispatchEvent("pointerup", pointerInit(2, cx + endGap, cy));
}

// S1: Session detail header
test.describe("S1: Session detail header", () => {
  test("maps the session boot wait to a centered loader", async ({ page }, testInfo) => {
    const session = makeWorkingSession({ id: "detail-loading-bar" });
    let releaseSession: (() => void) | undefined;
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    await page.route(`**/api/sessions/${session.id}`, async (route) => {
      await sessionReady;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    const loader = page.getByRole("status", { name: "Loading session" });
    await expect(loader).toBeVisible();
    await expect(loader.locator(".loader-centered-mark > span").first()).toHaveCSS(
      "animation-name",
      "loader-centered-pulse",
    );
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const center = await page.evaluate(() => {
        const mark = document.querySelector(".loader-centered-mark")?.getBoundingClientRect();
        const back = document.querySelector("main > a")?.getBoundingClientRect();
        const main = document.querySelector("main");
        if (!mark || !back || !main) return null;
        const paddingBottom = Number.parseFloat(getComputedStyle(main).paddingBottom);
        return {
          actualX: mark.left + mark.width / 2,
          actualY: mark.top + mark.height / 2,
          expectedX: window.innerWidth / 2,
          expectedY: (back.bottom + window.innerHeight - paddingBottom) / 2,
        };
      });
      expect(center).not.toBeNull();
      expect(Math.abs((center?.actualX ?? 0) - (center?.expectedX ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((center?.actualY ?? 0) - (center?.expectedY ?? 0))).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath("session-loading.png") });
    releaseSession?.();
    await expect(loader).toHaveCount(0);
    await expect(page.getByRole("link", { name: /back/i })).toBeVisible();
  });

  test("missing session shows an inline error instead of hanging", async ({ page }) => {
    await page.route("**/api/sessions/detail-missing", (route) => {
      void route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Session not found" }),
      });
    });
    await page.goto("/sessions/detail-missing");

    await expect(page.getByText("Session not found")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading session" })).toHaveCount(0);
  });

  test("back link visible", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s1-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByRole("link", { name: /back/i })).toBeVisible();
  });

  test("checkout group hides completed agents until ellipsis and never shows killed agents", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "detail-s1-desk-active",
      agent: "codex",
      deskGroupMembers: [
        {
          id: "detail-s1-desk-active",
          agent: "codex",
          status: "running",
          state: "working",
          runtimeAlive: true,
        },
        {
          id: "detail-s1-desk-complete",
          agent: "claude",
          status: "completed",
          state: "stopped",
          runtimeAlive: false,
        },
        {
          id: "detail-s1-desk-killed",
          agent: "cursor",
          status: "killed",
          state: "killed",
          runtimeAlive: false,
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const nav = page.getByRole("navigation", { name: "Checkout group" });
    await expect(nav.getByRole("link", { name: /codex.*detail-s1-desk-active/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /claude.*detail-s1-desk-complete/i })).toHaveCount(
      0,
    );
    await expect(nav.getByRole("link", { name: /cursor.*detail-s1-desk-killed/i })).toHaveCount(0);

    await nav.getByRole("button", { name: "Show completed desk agents" }).click();

    await expect(nav.getByRole("link", { name: /claude.*detail-s1-desk-complete/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /cursor.*detail-s1-desk-killed/i })).toHaveCount(0);
  });

  test("breadcrumb shows project, agent, session id", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s1-2",
      project: "my-project",
      agent: "claude",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // Wait for session to load — breadcrumb spans are in the header div
    const breadcrumb = page.locator("header div").filter({ hasText: "my-project" }).first();
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText("my-project");
    await expect(breadcrumb).toContainText("claude");
    // Session ID shown as font-mono span in breadcrumb (first font-mono span in header)
    await expect(page.locator("header span.font-mono").first()).toBeVisible();
  });

  test("title is shown uppercase bold", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s1-3",
      slots: { title: "My Session Title", links: [] },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const title = page.locator("h1");
    await expect(title).toBeVisible();
    // Title class includes uppercase and font-bold
    const classList = await title.getAttribute("class");
    expect(classList).toContain("uppercase");
    expect(classList).toContain("font-bold");
  });

  test("tab title shows only the task title", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s1-title",
      slots: { title: "Detail task title", links: [] },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page).toHaveTitle("Detail task title");
  });

  test("activity dot visible", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s1-4" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // ActivityDot renders as part of the header
    // It's rendered via the ActivityDot component — check it's present
    await expect(page.locator("header")).toBeVisible();
    // ActivityDot renders a span/div with colored dot — check session state area has content
    const header = page.locator("header").first();
    await expect(header).toContainText("claude");
  });

  test("wake timer is visible without opening a dashboard popup", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s1-wake-timer",
      intervalWake: {
        nextDueAt: new Date(Date.now() + 300_000).toISOString(),
        intervalMs: 300_000,
        message: "Check CI",
        stopCondition: "CI is green",
      },
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "working");
    await page.goto(`/sessions/${session.id}`);

    await expect(page.locator("header").getByText("interval wake")).toBeVisible();
    await expect(page.locator("header").getByText(/in \d+m/)).toBeVisible();
    await expect(page.getByText("Wake interval")).toBeVisible();
    await expect(page.getByText("5m").first()).toBeVisible();
    await expect(page.getByText("Wake stop condition")).toBeVisible();
    await expect(page.getByText("CI is green")).toBeVisible();
  });

  test("daily wake timer shows fixed times in detail", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s1-daily-wake",
      dailyWake: {
        dailyAt: ["09:00", "17:00"],
        nextDueAt: new Date(Date.now() + 300_000).toISOString(),
        message: "Check daily state",
        stopCondition: "Daily checks done",
      },
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "working");
    await page.goto(`/sessions/${session.id}`);

    await expect(page.locator("header").getByText("daily wake")).toBeVisible();
    await expect(page.locator("header").getByText(/in \d+m/)).toBeVisible();
    await expect(page.getByText("Wake daily at")).toBeVisible();
    await expect(page.getByText("09:00, 17:00").first()).toBeVisible();
    await expect(page.getByText("Wake stop condition")).toBeVisible();
    await expect(page.getByText("Daily checks done")).toBeVisible();
  });

  test("opening detail marks an unseen needs_input session opened", async ({ page }) => {
    let session = makeNeedsInputSession({
      id: "detail-s1-opened-needs-input",
      hasUnseenAttention: true,
    });
    let openedRequests = 0;
    await page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });
    await page.route(`**/api/sessions/${session.id}/opened`, (route) => {
      openedRequests += 1;
      session = {
        ...session,
        hasUnseenAttention: false,
        lastOpenedAt: "2026-04-28T10:01:00.000Z",
      };
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    await expect.poll(() => openedRequests).toBe(1);
  });

  test("copy task button writes the task prompt to clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const prompt = "Short visible prompt\n\nFull prompt details";
    const session = makeWorkingSession({ id: "detail-s1-copy-prompt", prompt });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: "Copy task" }).click();

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
    await expect(page.getByText("Task copied")).toBeVisible();
  });
});

test.describe("Spur ToDo audit", () => {
  test("renders delayed loading then a resolved expandable projection", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const session = makeCompletedSession({ id: "detail-todo-resolved" });
    await mockSessionDetail(page, session);
    let releaseTodo: (() => void) | undefined;
    const todoReady = new Promise<void>((resolve) => {
      releaseTodo = resolve;
    });
    await page.route(`**/api/sessions/${session.id}/todo`, async (route) => {
      await todoReady;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: "event-2",
          status: "resolved",
          counts: { total: 1, open: 0, held: 0, completed: 1, cancelled: 0 },
          items: [
            {
              id: "item-12345678",
              text: "Implement native ToDo",
              status: "completed",
              added: {
                reason: "Created from the session objective",
                actor: { kind: "system", source: "spawn" },
                at: "2026-08-20T10:00:00.000Z",
              },
              latestTransition: {
                type: "completed",
                reason: "All checks passed",
                actor: { kind: "agent", agent: "codex", sessionId: session.id },
                at: "2026-08-20T10:10:00.000Z",
              },
              history: [
                {
                  eventId: "event-1",
                  type: "item_added",
                  reason: "Created from the session objective",
                  actor: { kind: "system", source: "spawn" },
                  at: "2026-08-20T10:00:00.000Z",
                },
                {
                  eventId: "event-2",
                  type: "item_completed",
                  reason: "All checks passed",
                  actor: { kind: "agent", agent: "codex", sessionId: session.id },
                  at: "2026-08-20T10:10:00.000Z",
                },
              ],
            },
          ],
          finishOverrides: [],
        }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByLabel("Loading ToDo")).toBeVisible();
    const screenshotDir = join(
      process.env["SPUR_SESSION_ARTIFACTS_DIR"] ?? test.info().outputDir,
      "screenshots",
    );
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, "todo-loading.png"), fullPage: true });
    releaseTodo?.();
    await expect(page.getByLabel("1 of 1 ToDo items resolved")).toBeVisible();
    await expect(page.getByText("0 open")).toHaveCount(0);
    await expect(page.getByText("0 held")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const toggle = page.getByRole("button", { name: /Implement native ToDo/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.locator("#todo-audit-item-12345678").getByText("All checks passed"),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshotDir, "todo-resolved.png"), fullPage: true });
  });

  test("AC14 detail renders all four item states with shared tokens in dark and light", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-todo-status-matrix" });
    await mockSessionDetail(page, session);
    const statuses = ["open", "held", "completed", "cancelled"] as const;
    const tokenByStatus = {
      open: "--color-status-working",
      held: "--color-status-attention",
      completed: "--color-status-ready",
      cancelled: "--color-status-error",
    } as const;
    const symbolByStatus = { open: "○", held: "Ⅱ", completed: "✓", cancelled: "×" } as const;
    await page.route(`**/api/sessions/${session.id}/todo`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: "event-cancelled",
          status: "active",
          counts: { total: 4, open: 1, held: 1, completed: 1, cancelled: 1 },
          items: statuses.map((status, index) => {
            const itemId = `item-${status}`;
            const added = {
              eventId: `event-add-${status}`,
              type: "item_added",
              reason: "Added for status coverage",
              actor: { kind: "system", source: "spawn" },
              at: `2026-08-20T10:0${index}:00.000Z`,
            };
            const transition =
              status === "open"
                ? undefined
                : {
                    eventId: `event-${status}`,
                    type:
                      status === "held"
                        ? "item_held"
                        : status === "completed"
                          ? "item_completed"
                          : "item_cancelled",
                    reason: `${status} reason`,
                    ...(status === "held" ? { blocker: { kind: "external" } } : {}),
                    actor: { kind: "agent", agent: "codex", sessionId: session.id },
                    at: `2026-08-20T10:1${index}:00.000Z`,
                  };
            return {
              id: itemId,
              text: `${status} item`,
              status,
              added: {
                reason: added.reason,
                actor: added.actor,
                at: added.at,
              },
              ...(transition
                ? {
                    latestTransition: {
                      type: status,
                      reason: transition.reason,
                      ...(status === "held" ? { blocker: transition.blocker } : {}),
                      actor: transition.actor,
                      at: transition.at,
                    },
                  }
                : {}),
              history: transition ? [added, transition] : [added],
            };
          }),
          finishOverrides: [],
        }),
      });
    });
    await page.goto(`/sessions/${session.id}`);
    const list = page.getByRole("list", { name: "Spur ToDo items" });
    await expect(list).toBeVisible();

    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((nextTheme) => {
        document.documentElement.dataset.theme = nextTheme;
      }, theme);
      for (const status of statuses) {
        const glyph = list.getByLabel(status);
        await expect(glyph).toHaveText(symbolByStatus[status]);
        await expect(glyph).toHaveAttribute("style", `color: var(${tokenByStatus[status]});`);
        const colors = await glyph.evaluate(
          (element, token) => ({
            actual: getComputedStyle(element).color,
            expected: getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
          }),
          tokenByStatus[status],
        );
        expect(colors.actual).toBe(colors.expected);
      }
    }
  });
});

// S2: Actions bar
test.describe("S2: Actions bar", () => {
  test("Terminal button visible when session is attachable", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: /^terminal$/i })).toBeVisible();
  });

  test("Pause button visible when session is running", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s2-2",
      status: "running",
      runtimeAlive: true,
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: /^pause$/i })).toBeVisible();
  });

  test("Complete button visible when session is completable", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-3" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: /^complete$/i })).toBeVisible();
  });

  test("Kill button visible when session not completed/killed", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-4" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: /^kill$/i })).toBeVisible();
  });

  test("Kill button click shows confirm dialog", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-5" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    let dialogShown = false;
    page.once("dialog", (dialog) => {
      dialogShown = true;
      void dialog.dismiss();
    });

    await page.getByRole("button", { name: /^kill$/i }).click();
    expect(dialogShown).toBe(true);
  });

  test("restore failure shows a persistent dismissible toast", async ({ page }) => {
    const session = makeStoppedSession({ id: "detail-s2-restore-fail" });
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/restore`, async (route) => {
      await route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "Restore detail failed",
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^restore$/i }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "Restore detail failed" }),
    ).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(
      page.getByRole("alert").filter({ hasText: "Restore detail failed" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Dismiss toast" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Restore detail failed" })).toHaveCount(
      0,
    );
  });

  test("long persistent error toast stays bounded and dismissible on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const session = makeStoppedSession({ id: "detail-s2-restore-long-toast" });
    const longError = Array.from({ length: 80 }, (_, index) => {
      return `Restore failed line ${index + 1}: Spur daemon reported a detailed persistent error.`;
    }).join("\n");
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/restore`, async (route) => {
      await route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: longError,
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^restore$/i }).click();

    const toast = page.getByRole("alert").filter({ hasText: "Restore failed line 80" });
    await expect(toast).toBeVisible();

    const metrics = await toast.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Expected toast element");
      }
      const scrollArea = element.querySelector("[data-toast-scroll]");
      if (!(scrollArea instanceof HTMLElement)) {
        throw new Error("Expected toast scroll region");
      }
      const rect = element.getBoundingClientRect();
      const scrollAreaRect = scrollArea.getBoundingClientRect();
      const backgroundColor = window.getComputedStyle(element).backgroundColor;
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--color-bg-base)";
      document.body.append(probe);
      const expectedBackgroundColor = window.getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        backgroundColor,
        bottom: rect.bottom,
        expectedBackgroundColor,
        scrollAreaClientHeight: scrollArea.clientHeight,
        scrollAreaScrollHeight: scrollArea.scrollHeight,
        scrollAreaTop: scrollAreaRect.top,
        top: rect.top,
      };
    });
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(640);
    expect(metrics.scrollAreaTop).toBeGreaterThanOrEqual(metrics.top);
    expect(metrics.scrollAreaClientHeight).toBeLessThan(metrics.scrollAreaScrollHeight);
    expect(metrics.backgroundColor).toBe(metrics.expectedBackgroundColor);

    const closeButton = toast.getByRole("button", { name: "Dismiss toast" });
    await expect(closeButton).toBeVisible();
    const closeBox = await closeButton.boundingBox();
    expect(closeBox).not.toBeNull();
    if (!closeBox) {
      throw new Error("Expected dismiss button bounds");
    }
    expect(closeBox.y).toBeGreaterThanOrEqual(0);
    expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(640);

    await toast.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Expected toast element");
      }
      const scrollArea = element.querySelector("[data-toast-scroll]");
      if (!(scrollArea instanceof HTMLElement)) {
        throw new Error("Expected toast scroll region");
      }
      scrollArea.scrollTop = scrollArea.scrollHeight;
    });
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect(toast).toHaveCount(0);
  });

  test("Kill retries with close PR action without a second dirty confirmation", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s2-open-pr" });
    await mockSessionDetail(page, session);

    let killAttempts = 0;
    const killBodies: string[] = [];
    await page.route(`**/api/sessions/${session.id}/kill`, async (route) => {
      killAttempts += 1;
      killBodies.push(route.request().postData() ?? "");
      if (killAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "open_pr_action_required",
            sessionId: session.id,
            pr: {
              number: 42,
              title: "Close me",
              url: "https://github.com/test/repo/pull/42",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    let dialogCount = 0;
    page.on("dialog", (dialog) => {
      dialogCount += 1;
      void dialog.accept();
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^kill$/i }).click();

    await expect(page.getByRole("dialog", { name: "Open Pull Request" })).toBeVisible();
    await page.getByRole("button", { name: "Close Pull Request" }).click();

    await expect.poll(() => killAttempts).toBe(2);
    expect(dialogCount).toBe(1);
    expect(killBodies).toEqual([
      JSON.stringify({ force: true }),
      JSON.stringify({ force: true, prAction: "close" }),
    ]);
  });

  test("Complete skips the PR check and retries when GitHub is rate limited", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-pr-check" });
    await mockSessionDetail(page, session);

    let completeAttempts = 0;
    const completeBodies: string[] = [];
    await page.route(`**/api/sessions/${session.id}/complete`, async (route) => {
      completeAttempts += 1;
      completeBodies.push(route.request().postData() ?? "");
      if (completeAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "github_pr_check_unavailable",
            sessionId: session.id,
            rateLimited: true,
            pr: {
              number: 42,
              repo: "test/repo",
              url: "https://github.com/test/repo/pull/42",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...session, status: "completed" }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^complete$/i }).click();

    const dialog = page.getByRole("dialog", { name: "GitHub PR Check Unavailable" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/test/repo/pull/42",
    );
    await dialog.getByRole("button", { name: "Skip PR Check & Proceed" }).click();

    await expect.poll(() => completeAttempts).toBe(2);
    expect(completeBodies).toEqual(["", JSON.stringify({ skipPrCheck: true })]);
  });

  test("PR check dialog hides Retry when the failure is not a rate limit", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-pr-check-generic" });
    await mockSessionDetail(page, session);

    await page.route(`**/api/sessions/${session.id}/complete`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "github_pr_check_unavailable",
          sessionId: session.id,
          rateLimited: false,
          pr: {
            number: 42,
            repo: "test/repo",
            url: "https://github.com/test/repo/pull/42",
          },
        }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^complete$/i }).click();

    const dialog = page.getByRole("dialog", { name: "GitHub PR Check Unavailable" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Retry PR Check" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Skip PR Check & Proceed" })).toBeVisible();
  });

  test("PR check dialog renders fallback text and no link when there is no PR", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s2-pr-check-nopr" });
    await mockSessionDetail(page, session);

    await page.route(`**/api/sessions/${session.id}/complete`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "github_pr_check_unavailable",
          sessionId: session.id,
          rateLimited: true,
          pr: null,
        }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^complete$/i }).click();

    const dialog = page.getByRole("dialog", { name: "GitHub PR Check Unavailable" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("No linked pull request URL is available.")).toBeVisible();
    await expect(dialog.getByRole("link")).toHaveCount(0);
  });

  test("PR check dialog Retry resends the original request without skipPrCheck", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s2-pr-check-retry" });
    await mockSessionDetail(page, session);

    let completeAttempts = 0;
    const completeBodies: string[] = [];
    await page.route(`**/api/sessions/${session.id}/complete`, async (route) => {
      completeAttempts += 1;
      completeBodies.push(route.request().postData() ?? "");
      if (completeAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "github_pr_check_unavailable",
            sessionId: session.id,
            rateLimited: true,
            pr: {
              number: 42,
              repo: "test/repo",
              url: "https://github.com/test/repo/pull/42",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...session, status: "completed" }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^complete$/i }).click();

    const dialog = page.getByRole("dialog", { name: "GitHub PR Check Unavailable" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Retry PR Check" }).click();

    await expect.poll(() => completeAttempts).toBe(2);
    expect(completeBodies).toEqual(["", ""]);
  });

  test("no Terminal button when session status is completed", async ({ page }) => {
    const session = makeCompletedSession({ id: "detail-s2-6" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // canAttach = runtimeAlive && !isTerminalSession && tmuxSession
    // completed → isTerminalSession = true → no terminal button
    await expect(page.getByRole("button", { name: /^terminal$/i })).toHaveCount(0);
  });

  test("Edit & Respawn accepts pasted images and forwards startup image selections", async ({
    page,
  }) => {
    let respawnBody: Record<string, unknown> | null = null;
    const session = makeCompletedSession({
      id: "detail-s2-respawn-1",
      prompt: "Retry with screenshot",
      startupAttachmentIds: ["1715000000000-source.png"],
      artifacts: [
        {
          id: "1715000000000-source.png",
          name: "1715000000000-source.png",
          size: 12,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await mockSessionDetail(page, makeSpawningSession({ id: "detail-s2-respawn-next" }));
    await page.route(`**/api/sessions/${session.id}/respawn`, async (route) => {
      respawnBody = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSpawningSession({ id: "detail-s2-respawn-next" })),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /edit & respawn/i }).click();
    await expect(page.getByRole("button", { name: "Attach file" })).toBeVisible();
    const textarea = page.getByPlaceholder("Initial message...");
    await expect(textarea).toHaveValue("Retry with screenshot");
    await textarea.fill("Retry with a fresh screenshot");
    await textarea.evaluate((textarea) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["PNG"], "respawn.png", { type: "image/png" }));
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await expect(page.locator('img[alt="respawn.png"]')).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /^respawn$/i }).click();
    await page.waitForURL("**/sessions/detail-s2-respawn-next");

    expect(respawnBody).toMatchObject({
      prompt: "Retry with a fresh screenshot",
      startupAttachmentIds: ["1715000000000-source.png"],
      attachments: [{ name: "respawn.png", data: expect.any(String) }],
    });
  });

  test("Edit & Respawn clear button resets the prompt", async ({ page }) => {
    const session = makeCompletedSession({
      id: "detail-s2-respawn-clear",
      prompt: "Retry with screenshot",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /edit & respawn/i }).click();
    const textarea = page.getByPlaceholder("Initial message...");
    await expect(textarea).toHaveValue("Retry with screenshot");
    await page.getByRole("button", { name: "Clear respawn prompt" }).click();

    await expect(textarea).toHaveValue("");
    await expect(textarea).toBeFocused();
  });

  test("Edit & Respawn modal footer matches the spawn footer with slash, history, and hotkey submit", async ({
    page,
  }) => {
    const session = makeCompletedSession({
      id: "detail-s2-respawn-footer",
      prompt: "Retry with screenshot",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /edit & respawn/i }).click();
    await expect(page.getByRole("button", { name: "Slash" })).toBeVisible();
    await expect(page.getByRole("button", { name: "History" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^respawn$/i })).toContainText("⌘ + ⏎");
  });

  test("Desk agent modal renders a single footer row with slash, history, cancel, and hotkey submit", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s2-desk-footer", worktree: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^desk agent$/i }).click();
    const deskModal = page
      .getByRole("heading", { name: "Desk agent" })
      .locator("xpath=ancestor::div[contains(@class,'shadow')][1]");
    await expect(deskModal.getByRole("button", { name: "Slash" })).toBeVisible();
    await expect(deskModal.getByRole("button", { name: "History" })).toBeVisible();
    await expect(deskModal.getByRole("button", { name: /^cancel$/i })).toBeVisible();
    await expect(deskModal.getByRole("button", { name: /^spawn$/i })).toContainText("⌘ + ⏎");
  });

  test("Handoff modal sends agent, model, and optional notes", async ({ page }) => {
    let handoffBody: Record<string, unknown> | null = null;
    const session = makeWorkingSession({
      id: "detail-s2-handoff-1",
      agent: "codex",
      model: "codex-model-id",
      workspaceExists: true,
    });
    const handedOff = makeSpawningSession({ id: "detail-s2-handoff-next", agent: "cursor" });
    await mockSessionDetail(page, session);
    await mockSessionDetail(page, handedOff);
    await mockSessionConversation(page, session.id, "working");
    await mockAgentModels(page, {
      claude: [{ id: "opus", label: "Opus" }],
      cursor: [{ id: "composer-2.5", label: "Composer 2.5" }],
    });
    await mockSpawnDefaults(page);
    await page.route(`**/api/sessions/${session.id}/handoff`, async (route) => {
      handoffBody = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(handedOff),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^handoff$/i }).click();
    const handoffAgent = page.getByRole("combobox", { name: "Handoff agent" });
    await expect(handoffAgent).toHaveValue("claude");
    // Handing off to a different agent (default) never carries the source
    // session's model: the control resolves that agent's own catalog.
    await expect(page.getByRole("button", { name: "Handoff model" })).toHaveText(/Opus/);
    await handoffAgent.selectOption("cursor");
    await expect(page.getByRole("button", { name: "Handoff model" })).toHaveText(/Composer 2.5/);
    await page.getByRole("textbox", { name: "Handoff notes" }).fill("Continue from codex");
    const handoffSubmit = page.getByRole("button", { name: /^handoff$/i }).last();
    await expect(handoffSubmit).toBeEnabled();
    await handoffSubmit.click();

    await expect(page).toHaveURL(/\/sessions\/detail-s2-handoff-next/);
    expect(handoffBody).toMatchObject({
      agent: "cursor",
      model: "composer-2.5",
      notes: "Continue from codex",
    });
  });

  test("Desk agent modal sends fixed session context with branch, plan, and steps", async ({
    page,
  }) => {
    let spawnBody: Record<string, unknown> | null = null;
    const session = makeWorkingSession({
      id: "detail-s2-desk-spawn-1",
      project: "fixed-project",
      branch: "feature/current-session",
      worktree: true,
    });
    const spawned = makeSpawningSession({ id: "detail-s2-desk-spawn-next" });
    await mockSessionDetail(page, session);
    await mockSessionDetail(page, spawned);
    await page.route("**/api/spawn", async (route) => {
      spawnBody = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(spawned),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^desk agent$/i }).click();
    await expect(page.getByRole("combobox", { name: "Spawn project" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "workspace mode" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Desk spawn agent" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "branch name" })).toHaveValue(
      "feature/current-session",
    );

    await page.getByRole("textbox", { name: "Desk agent prompt" }).fill("Spawn helper");
    await page.getByLabel("Plan").check();
    await page.getByRole("button", { name: /^\+ step$/i }).click();
    await page.getByRole("textbox", { name: "step 1" }).fill("Inspect failing test");
    await page.getByRole("button", { name: /^\+ step$/i }).click();
    await page.getByRole("textbox", { name: "step 2" }).fill("Patch focused fix");
    await page.getByRole("button", { name: /^spawn/i }).click();

    await expect(page).toHaveURL(/\/sessions\/detail-s2-desk-spawn-next/);
    expect(spawnBody).toMatchObject({
      projectId: "fixed-project",
      prompt: "Spawn helper",
      agent: "claude",
      reuseWorkspaceSessionId: session.id,
      overrides: { worktree: true },
      branch: "feature/current-session",
      planMode: true,
      steps: ["Inspect failing test", "Patch focused fix"],
    });
  });

  test("Desk agent clear button resets the prompt", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s2-desk-clear" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^desk agent$/i }).click();
    const textarea = page.getByRole("textbox", { name: "Desk agent prompt" });
    await textarea.fill("Prompt to clear");
    await page.getByRole("button", { name: "Clear desk agent prompt" }).click();

    await expect(textarea).toHaveValue("");
    await expect(textarea).toBeFocused();
  });

  test("Desk agent modal allows attachment-only spawn and preserves failed input", async ({
    page,
  }) => {
    let spawnBody: Record<string, unknown> | null = null;
    const session = makeWorkingSession({ id: "detail-s2-desk-attach-1" });
    await mockSessionDetail(page, session);
    await page.route("**/api/spawn", async (route) => {
      spawnBody = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "spawn failed" }),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^desk agent$/i }).click();
    const textarea = page.getByRole("textbox", { name: "Desk agent prompt" });
    await textarea.evaluate((element) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["PNG"], "desk.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(page.locator('img[alt="desk.png"]')).toBeVisible();
    await page.getByRole("button", { name: /^spawn/i }).click();

    await expect(page.getByRole("heading", { name: /desk agent/i })).toBeVisible();
    await expect(textarea).toHaveValue("");
    await expect(page.locator('img[alt="desk.png"]')).toBeVisible();
    expect(spawnBody).toMatchObject({
      projectId: "test-project",
      prompt: "",
      reuseWorkspaceSessionId: session.id,
      attachments: [{ name: "desk.png", data: expect.any(String) }],
      overrides: { worktree: true },
    });
  });

  test("Desk agent rapid repeat submit sends one spawn request", async ({ page }) => {
    let spawnCalls = 0;
    let releaseSpawn: (() => void) | null = null;
    const session = makeWorkingSession({ id: "detail-s2-desk-single-1" });
    const spawned = makeSpawningSession({ id: "detail-s2-desk-single-next" });
    await mockSessionDetail(page, session);
    await mockSessionDetail(page, spawned);
    await page.route("**/api/spawn", async (route) => {
      spawnCalls += 1;
      await new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(spawned),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^desk agent$/i }).click();
    await page.getByRole("textbox", { name: "Desk agent prompt" }).fill("Spawn once");
    await page.getByRole("button", { name: /^spawn/i }).dblclick();

    await expect.poll(() => spawnCalls).toBe(1);
    releaseSpawn?.();
    await expect(page).toHaveURL(/\/sessions\/detail-s2-desk-single-next/);
  });

  test("link workspace access entries are visible when configured", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s2-7",
      workspaceAccess: {
        items: [
          {
            label: "Web IDE",
            kind: "link",
            value: "https://code.example.com/?folder=%2Ftmp%2Fworktrees%2Fdetail-s2-7",
          },
        ],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Workspace Access")).toBeVisible();
    await expect(page.getByRole("link", { name: /^open web ide$/i })).toHaveAttribute(
      "href",
      "https://code.example.com/?folder=%2Ftmp%2Fworktrees%2Fdetail-s2-7",
    );
  });
});

// S2a: Logs modal
test.describe("S2a: Logs modal", () => {
  test("hides automatic history snapshot download in the default agent view", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s2a-1",
      artifacts: [
        {
          id: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
          name: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "waiting");
    await mockSessionLogs(page, session.id, [
      {
        timestamp: "2026-04-02T10:01:00.000Z",
        event: "session.state.transition",
        level: "info",
        message: "Status changed from waiting to needs_input",
        details: {
          fromState: "waiting",
          toState: "needs_input",
          source: "jsonl",
          historyArtifactId: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
        },
      },
      {
        timestamp: "2026-04-02T10:01:10.000Z",
        event: "session.input.received",
        level: "info",
        message: "Fix the failing test",
        details: {
          inputKind: "send_message",
          source: "send_direct",
          text: "Fix the failing test",
          attachments: [{ id: "upload.png", name: "upload.png" }],
        },
      },
    ]);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^logs$/i }).click();

    await expect(page.getByRole("dialog", { name: `Logs ${session.id}` })).toBeVisible();
    await expect(page.getByText("waiting")).toBeVisible();
    await expect(page.getByText("needs input")).toBeVisible();
    await expect(page.getByText("source jsonl")).toBeVisible();
    await expect(page.getByText("User input")).toBeVisible();
    await expect(page.getByText("send message")).toBeVisible();
    await expect(page.getByText("Fix the failing test")).toBeVisible();
    await expect(page.getByText("Attachment upload.png")).toBeVisible();
    await expect(page.getByRole("link", { name: /history snapshot/i })).toHaveCount(0);
  });

  test("shows automatic history snapshot download after switching to system artifacts", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "detail-s2a-2",
      artifacts: [
        {
          id: "agent-output.txt",
          name: "agent-output.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
          name: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "waiting");
    await mockSessionLogs(page, session.id, [
      {
        timestamp: "2026-04-02T10:01:00.000Z",
        event: "session.state.transition",
        level: "info",
        message: "Status changed from waiting to needs_input",
        details: {
          fromState: "waiting",
          toState: "needs_input",
          source: "jsonl",
          historyArtifactId: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
        },
      },
    ]);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: "System (1)" }).click();
    await page.getByRole("button", { name: /^logs$/i }).click();

    await expect(page.getByRole("dialog", { name: `Logs ${session.id}` })).toBeVisible();
    await expect(page.getByRole("link", { name: /history snapshot/i })).toHaveAttribute(
      "href",
      `/api/sessions/${session.id}/artifacts/agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl`,
    );
  });

  test("keeps automatic history snapshot download hidden in attached artifacts", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "detail-s2a-3",
      artifacts: [
        {
          id: "upload.png",
          name: "upload.png",
          size: 1400,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          addedByUser: true,
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
          name: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "waiting");
    await mockSessionLogs(page, session.id, [
      {
        timestamp: "2026-04-02T10:01:00.000Z",
        event: "session.state.transition",
        level: "info",
        message: "Status changed from waiting to needs_input",
        details: {
          fromState: "waiting",
          toState: "needs_input",
          source: "jsonl",
          historyArtifactId: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
        },
      },
    ]);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: "Attached (1)" }).click();
    await page.getByRole("button", { name: /^logs$/i }).click();

    await expect(page.getByRole("dialog", { name: `Logs ${session.id}` })).toBeVisible();
    await expect(page.getByRole("link", { name: /history snapshot/i })).toHaveCount(0);
  });
});

// S2b: Conversation dialog
test.describe("S2b: Conversation dialog", () => {
  test("long unbroken dialog and queued tokens hard-wrap on mobile without horizontal overflow", async ({
    page,
  }) => {
    const longToken = "supercalifragilisticexpialidocious".repeat(12);
    const session = makeWorkingSession({
      id: "detail-s2b-1",
      queuedMessages: {
        messages: [longToken],
        awaitingPrompt: false,
      },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await mockSessionDetail(page, session);
    await mockSessionConversationPayload(page, session.id, {
      messages: [
        { role: "user", text: "Prompt", timestampMs: 1 },
        { role: "assistant", text: longToken, timestampMs: 2 },
      ],
      durationMs: 60_000,
      state: "waiting",
    });
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("heading", { name: /dialog/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /queued messages/i })).toBeVisible();

    const layout = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        mainScrollWidth: main?.scrollWidth ?? null,
        mainClientWidth: main?.clientWidth ?? null,
      };
    });

    expect(layout.bodyScrollWidth).toBe(layout.bodyClientWidth);
    expect(layout.mainScrollWidth).toBe(layout.mainClientWidth);
  });

  test("wide dialog code blocks and tables stay within the mobile viewport width", async ({
    page,
  }) => {
    // A fenced code block (white-space: pre) and a wide table have irreducible
    // min-content that `overflow-wrap` cannot break — unlike the plain long token
    // above. They only stay contained when the mobile grid columns carry min-w-0,
    // so this guards that fix. See SessionDetail content grid.
    const wideCodeLine = `const payload = "${"x".repeat(180)}";`;
    const wideTable = [
      `| ${"alpha".repeat(6)} | ${"bravo".repeat(6)} |`,
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    const session = makeWorkingSession({ id: "detail-s2b-wide-content" });

    await page.setViewportSize({ width: 390, height: 844 });
    await mockSessionDetail(page, session);
    await mockSessionConversationPayload(page, session.id, {
      messages: [
        { role: "assistant", text: `\`\`\`\n${wideCodeLine}\n\`\`\``, timestampMs: 1 },
        { role: "assistant", text: wideTable, timestampMs: 2 },
      ],
      durationMs: 60_000,
      state: "waiting",
    });
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("heading", { name: /dialog/i })).toBeVisible();
    await expect(page.getByText("const payload", { exact: false })).toBeVisible();

    const layout = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        mainScrollWidth: main?.scrollWidth ?? null,
        mainClientWidth: main?.clientWidth ?? null,
      };
    });

    expect(layout.bodyScrollWidth).toBe(layout.bodyClientWidth);
    expect(layout.mainScrollWidth).toBe(layout.mainClientWidth);
  });

  test("long unbroken dialog and queued tokens hard-wrap on desktop without horizontal overflow", async ({
    page,
  }) => {
    const longToken = "supercalifragilisticexpialidocious".repeat(12);
    const session = makeWorkingSession({
      id: "detail-s2b-2",
      queuedMessages: {
        messages: [longToken],
        awaitingPrompt: false,
      },
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await mockSessionDetail(page, session);
    await mockSessionConversationPayload(page, session.id, {
      messages: [
        { role: "user", text: "Prompt", timestampMs: 1 },
        { role: "assistant", text: longToken, timestampMs: 2 },
      ],
      durationMs: 60_000,
      state: "waiting",
    });
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("heading", { name: /dialog/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /queued messages/i })).toBeVisible();

    const layout = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        mainScrollWidth: main?.scrollWidth ?? null,
        mainClientWidth: main?.clientWidth ?? null,
      };
    });

    expect(layout.bodyScrollWidth).toBe(layout.bodyClientWidth);
    expect(layout.mainScrollWidth).toBe(layout.mainClientWidth);

    const dialogOverflowX = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h2")).find((h) =>
        /dialog/i.test(h.textContent ?? ""),
      );
      const container = heading?.parentElement?.querySelector(".overflow-x-hidden");
      return container ? getComputedStyle(container).overflowX : null;
    });
    expect(dialogOverflowX).toBe("hidden");
  });
});

// S3: Message section
test.describe("S3: Message section", () => {
  test("textarea visible when session accepts input", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.locator("textarea")).toBeVisible();
  });

  test("Queue and Send now buttons are disabled when textarea is empty", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-2", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: /^queue$/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^send now$/i })).toBeDisabled();
  });

  test("slash button inserts a suggested command into the message composer", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-slash", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/slash-commands`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agent: "claude",
          commands: [
            {
              id: "status",
              label: "/status",
              insertText: "/status",
              detail: "Show status",
              source: "built-in",
              kind: "command",
            },
          ],
          skills: [],
          agents: [],
        }),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: "Slash" }).click();
    await page.getByRole("menuitem", { name: /\/status/i }).click();

    await expect(page.getByPlaceholder("Message...")).toHaveValue("/status");
  });

  test("message clear button resets the composer", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-clear", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const textarea = page.getByPlaceholder("Message...");
    await textarea.fill("Message to clear");
    await page.getByRole("button", { name: "Clear message" }).click();

    await expect(textarea).toHaveValue("");
    await expect(textarea).toBeFocused();
  });

  test("Not accepting input message when session is completed", async ({ page }) => {
    const session = makeCompletedSession({ id: "detail-s3-3" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText(/not accepting input/i)).toBeVisible();
  });

  test("drop image file shows thumbnail", async ({ page }) => {
    const session = makeWorkingSession({ id: "drop-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible();

    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["PNG"], "test.png", { type: "image/png" }));
      return dt;
    });
    await textarea.dispatchEvent("drop", { dataTransfer });

    await expect(page.locator('img[alt="test.png"]')).toBeVisible({ timeout: 5000 });
  });

  test("paste image shows thumbnail", async ({ page }) => {
    const session = makeWorkingSession({ id: "paste-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible();

    await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return;
      const dt = new DataTransfer();
      dt.items.add(new File(["PNG"], "paste.png", { type: "image/png" }));
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      ta.dispatchEvent(ev);
    });

    await expect(page.locator('img[alt="paste.png"]')).toBeVisible({ timeout: 5000 });
  });

  test("paste pdf shows file chip and sends attachment", async ({ page }) => {
    const session = makeWorkingSession({ id: "paste-pdf-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    let body: Record<string, unknown> | null = null;
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      body = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();

    await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return;
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF"], "report.pdf", { type: "application/pdf" }));
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      ta.dispatchEvent(ev);
    });

    await expect(page.locator('[title="report.pdf"]')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Remove report.pdf" })).toBeVisible();

    await page.getByRole("button", { name: /^send now$/i }).click();
    await expect.poll(() => body).not.toBeNull();
    const payload = body as Record<string, unknown> | null;
    expect(payload?.attachments).toEqual([{ name: "report.pdf", data: expect.any(String) }]);
  });

  test("Queue and Send now enable when attachment is present with empty text", async ({ page }) => {
    const session = makeWorkingSession({ id: "attach-send-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const queueBtn = page.getByRole("button", { name: /^queue$/i });
    const sendNowBtn = page.getByRole("button", { name: /^send now$/i });
    await expect(queueBtn).toBeDisabled();
    await expect(sendNowBtn).toBeDisabled();

    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["PNG"], "attach.png", { type: "image/png" }));
      return dt;
    });
    await page.locator("textarea").dispatchEvent("drop", { dataTransfer });

    await expect(queueBtn).not.toBeDisabled({ timeout: 5000 });
    await expect(sendNowBtn).not.toBeDisabled({ timeout: 5000 });
  });

  test("Queue posts a queued send payload", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-7", runtimeAlive: true });
    await mockSessionDetail(page, session);
    let body: Record<string, unknown> | null = null;
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      body = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("textbox").fill("Queued follow up");
    await page.getByRole("button", { name: /^queue$/i }).click();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toEqual({ message: "Queued follow up", queue: true });
  });

  test("Queue shows a spinner and blocks duplicate submissions while in flight", async ({
    page,
  }) => {
    test.slow();
    const session = makeWorkingSession({ id: "queue-spinner-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    let postCount = 0;
    let releaseSend: () => void = () => {};
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      postCount += 1;
      await sendPending;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("textbox").fill("Queued spinner check");
    const queueIdle = page.getByRole("button", { name: /^queue$/i });
    await queueIdle.click();

    const queueBusy = page.getByRole("button", { name: /^queueing/i });
    const sendBusy = page.getByRole("button", { name: /^sending/i });

    await expect(queueBusy.locator(".voice-spinner")).toBeVisible();
    await expect(queueBusy).toBeDisabled();
    await expect(sendBusy).toBeDisabled();

    await queueBusy.click({ force: true }).catch(() => {});
    await expect.poll(() => postCount, { timeout: 1500 }).toBe(1);

    releaseSend();
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
  });

  test("composer buttons show inline hotkey hints", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-hotkeys-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: /^queue$/i })).not.toContainText("⌘ + ⏎");
    await expect(page.getByRole("button", { name: /^send now$/i })).toContainText("⌘ + ⏎");
  });

  test("Cmd+Enter posts the direct-send payload", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-hotkeys-2", runtimeAlive: true });
    await mockSessionDetail(page, session);
    let body: Record<string, unknown> | null = null;
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      body = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    const textarea = page.getByRole("textbox");
    await textarea.fill("Direct with hotkey");
    await textarea.press("Meta+Enter");

    await expect.poll(() => body).not.toBeNull();
    expect(body).toEqual({
      message: "Direct with hotkey",
      queue: false,
      interrupt: true,
    });
  });

  test("plain Enter keeps the newline and does not submit", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-hotkeys-3", runtimeAlive: true });
    await mockSessionDetail(page, session);
    let sendCalls = 0;
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      sendCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    const textarea = page.getByRole("textbox");
    await textarea.fill("first line");
    await textarea.press("Enter");
    await textarea.type("second line");

    await expect(textarea).toHaveValue("first line\nsecond line");
    expect(sendCalls).toBe(0);
  });

  test("Send now posts a direct-send payload", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s3-8", runtimeAlive: true });
    await mockSessionDetail(page, session);
    let body: Record<string, unknown> | null = null;
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      body = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("textbox").fill("Send immediately");
    await page.getByRole("button", { name: /^send now$/i }).click();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toEqual({
      message: "Send immediately",
      queue: false,
      interrupt: true,
    });
  });

  test("history restores a saved message with its timestamp", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "spur:input-history:session-message",
        JSON.stringify([
          {
            value: "Saved follow up",
            savedAt: "2026-04-17T08:15:00.000Z",
          },
        ]),
      );
    });
    const session = makeWorkingSession({ id: "detail-s3-history-1", runtimeAlive: true });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^history$/i }).click();
    await expect(page.getByText("2026-04-17 08:15 UTC")).toBeVisible();
    await page.getByRole("button", { name: /saved follow up/i }).click();
    await expect(page.getByRole("textbox")).toHaveValue("Saved follow up");
  });

  test("failed voice transcription keeps playback and retry controls", async ({ page }) => {
    await installVoiceMediaMocks(page);
    const session = makeWorkingSession({ id: "detail-s3-retained-voice", runtimeAlive: true });
    let transcribeCalls = 0;
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);
    await page.route("**/api/runtime/voice/transcribe", async (route) => {
      transcribeCalls += 1;
      if (transcribeCalls <= 3) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Voice API unavailable" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "Recovered retained recording" }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /start voice recording/i }).click();
    await expect(page.getByRole("button", { name: /stop voice recording/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /cancel voice recording/i })).toBeVisible();
    await page.getByRole("button", { name: /stop voice recording/i }).click();

    await expect(page.getByText(/Failed to transcribe audio after 3 attempts/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /play failed voice recording/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /retry failed voice recording/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /discard failed voice recording/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /retry failed voice recording/i }).click();

    await expect(page.getByRole("textbox")).toHaveValue("Recovered retained recording");
    await expect(page.getByRole("button", { name: /start voice recording/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /retry failed voice recording/i })).toHaveCount(
      0,
    );
  });
});

test.describe("S3 mobile voice", () => {
  test("mobile voice input does not surface a spurious no-audio error in standalone-style flows", async ({
    browser,
  }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const session = makeWorkingSession({ id: "detail-s3-mobile-voice-1", runtimeAlive: true });
    let transcribeCalls = 0;

    try {
      await page.addInitScript(() => {
        class MobilePwaMediaRecorder {
          mimeType = "audio/webm";
          state = "inactive";
          private listeners = new Map<string, Array<(event?: unknown) => void>>();
          private requestedFlush = false;

          addEventListener(type: string, listener: (event?: unknown) => void) {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
          }

          start() {
            this.state = "recording";
          }

          requestData() {
            this.requestedFlush = true;
          }

          stop() {
            this.state = "inactive";
            const blob = new Blob(["voice-audio"], { type: this.mimeType });
            if (this.requestedFlush) {
              this.emit("stop");
              queueMicrotask(() => {
                this.emit("dataavailable", blob);
              });
              return;
            }
            this.emit("dataavailable", blob);
            this.emit("stop");
          }

          private emit(type: string, data?: Blob) {
            for (const listener of this.listeners.get(type) ?? []) {
              listener(data ? { data } : undefined);
            }
          }
        }

        Object.defineProperty(window, "MediaRecorder", {
          configurable: true,
          writable: true,
          value: MobilePwaMediaRecorder,
        });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => ({
              getTracks: () => [{ stop() {} }],
            }),
          },
        });
      });

      await mockSessionDetail(page, session);
      await mockSessionConversation(page, session.id, "waiting");
      await mockVoiceStatus(page);
      await mockVoiceTranscribe(page, "Mobile PWA voice still works", () => {
        transcribeCalls += 1;
      });

      await page.goto(`/sessions/${session.id}`);

      await page.getByRole("button", { name: /start voice recording/i }).click();
      await expect(page.getByRole("button", { name: /stop voice recording/i })).toBeVisible();
      await page.getByRole("button", { name: /stop voice recording/i }).click();

      await expect(page.getByPlaceholder("Message...")).toHaveValue("Mobile PWA voice still works");
      await expect(
        page.getByText(
          "Voice recording captured no audio. Check your microphone input and try again.",
        ),
      ).toHaveCount(0);
      expect(transcribeCalls).toBe(1);
    } finally {
      await context.close();
    }
  });
});

// S3b: Queued messages section
test.describe("S3b: Queued messages section", () => {
  test("shows the full queued stack in FIFO order", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s3b-1",
      queuedMessages: {
        messages: [
          "Manual queued follow-up",
          "[Spur step 2/3: implement]\nDo only this step for the task below. When it is done, stop and wait for the next Spur message.\n\nTask:\nImplement the feature",
          "[Spur step 3/3: test]\nThis is the final step for the task below.\n\nTask:\nImplement the feature",
        ],
        awaitingPrompt: false,
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("heading", { name: /queued messages/i })).toBeVisible();
    const items = page.getByRole("list", { name: /queued messages list/i }).getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Manual queued follow-up");
    await expect(items.nth(1)).toContainText("[Spur step 2/3: implement]");
    await expect(items.nth(2)).toContainText("[Spur step 3/3: test]");
  });

  test("shows awaiting prompt hint when queue is blocked", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s3b-2",
      queuedMessages: {
        messages: [],
        awaitingPrompt: true,
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("heading", { name: /queued messages/i })).toBeVisible();
    await expect(page.getByText(/queued messages will send automatically/i)).toBeVisible();
    await expect(page.getByRole("list", { name: /queued messages list/i })).toHaveCount(0);
  });

  test("removes a real queued row, leaves the auto-step row uncontrolled, and never targets it by index", async ({
    page,
  }) => {
    let session = makeWorkingSession({
      id: "detail-s3b-3",
      queuedMessages: {
        messages: ["first follow-up", "second follow-up"],
        awaitingPrompt: false,
        pipelineMessages: ["Ship the feature — step 2/3: implement"],
      },
    });
    await page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });
    await mockSessionConversation(page, session.id, "waiting");
    await mockVoiceStatus(page);
    let removeRequestBody: unknown = null;
    await page.route(`**/api/sessions/${session.id}/queue/remove`, async (route) => {
      removeRequestBody = route.request().postDataJSON();
      const { message } = removeRequestBody as { message: string };
      const queuedMessages = session.queuedMessages ?? { messages: [], awaitingPrompt: false };
      session = {
        ...session,
        queuedMessages: {
          ...queuedMessages,
          messages: queuedMessages.messages.filter((m) => m !== message),
        },
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("first follow-up")).toBeVisible();
    await expect(page.getByText("second follow-up")).toBeVisible();
    await expect(page.getByText("Ship the feature — step 2/3: implement")).toBeVisible();

    // Both controls render on real rows only — the auto (pipeline-derived)
    // row has neither.
    await expect(page.getByLabel(/^Remove queued message #\d+$/)).toHaveCount(2);
    await expect(page.getByLabel(/^Send queued message #\d+ now$/)).toHaveCount(2);

    await page.getByLabel("Remove queued message #1").click();

    await expect.poll(() => removeRequestBody).toEqual({ message: "first follow-up" });
    await expect(page.getByText("first follow-up")).toHaveCount(0);
    await expect(page.getByText("second follow-up")).toBeVisible();
    // The auto row is unaffected and still carries no controls after the
    // refetch.
    await expect(page.getByText("Ship the feature — step 2/3: implement")).toBeVisible();
    await expect(page.getByLabel(/^Remove queued message #\d+$/)).toHaveCount(1);
  });

  test("flushing a row that hits a 409 (delivery in flight) surfaces the daemon's message as a toast and keeps the row", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "detail-s3b-4",
      queuedMessages: {
        messages: ["queued now"],
        awaitingPrompt: false,
      },
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "waiting");
    await mockVoiceStatus(page);
    await page.route(`**/api/sessions/${session.id}/queue/flush`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Delivery already in flight for detail-s3b-4" }),
      });
    });

    await page.goto(`/sessions/${session.id}`);

    await page.getByLabel("Send queued message #1 now").click();

    await expect(page.getByText("Delivery already in flight for detail-s3b-4")).toBeVisible();
    await expect(page.getByText("queued now")).toBeVisible();
  });
});

// S4: Links section
test.describe("S4: Links section", () => {
  test("links section visible when session has links", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4-1",
      slots: {
        title: "Session with links",
        links: [{ label: "docs", url: "https://example.com/docs" }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // Links section header
    await expect(page.getByText("Links").first()).toBeVisible();
    const link = page.getByRole("link", { name: "docs" });
    await expect(link).toBeVisible();
  });

  test("canonical github-pr links stay surfaced as header badges", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4-pr",
      slots: {
        title: "Session with GitHub PR",
        links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/42" }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.locator('a[href="https://github.com/test/repo/pull/42"]')).toHaveCount(1);
    await expect(page.getByRole("link", { name: "#42" })).toBeVisible();
    await expect(page.getByRole("link", { name: "github pr" })).toHaveCount(0);
  });

  test("surfaced badge URLs are not repeated in the Links section", async ({ page }) => {
    const githubUrl = "https://github.com/test/repo/pull/42";
    const gitlabUrl = "https://gitlab.com/test/repo/-/merge_requests/7";
    const trackerUrl = "https://jira.example.com/browse/WEBDEV-4617";
    const docsUrl = "https://example.com/docs";
    const session = makeWorkingSession({
      id: "detail-s4-dedupe",
      slots: {
        title: "Session with surfaced links",
        links: [
          { label: "github-pr", url: githubUrl },
          { label: "docs", url: githubUrl },
          { label: "gitlab-pr", url: gitlabUrl },
          { label: "docs", url: gitlabUrl },
          { label: "tracker", url: trackerUrl },
          { label: "docs", url: trackerUrl },
          { label: "docs", url: docsUrl },
        ],
      },
    });
    await mockSessionDetail(page, session);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          totalThreads: 0,
          unresolvedThreads: 0,
          canMerge: false,
        }),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await expect(page.locator(`a[href="${docsUrl}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href="${githubUrl}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href="${gitlabUrl}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href="${trackerUrl}"]`)).toHaveCount(1);
    await expect(page.getByRole("link", { name: "docs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "github pr" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "gitlab mr" })).toHaveCount(0);
  });

  test("links open in new tab", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4-2",
      slots: {
        title: "Session with external link",
        links: [{ label: "docs", url: "https://example.com/docs" }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const link = page.getByRole("link", { name: "docs" });
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("PR links show compact approval indicator from reviewDecision", async ({ page }) => {
    const prUrl = "https://github.com/test/repo/pull/42002";
    const session = makeWorkingSession({
      id: "detail-s4-pr-1",
      slots: {
        title: "Session with PR",
        links: [{ label: "pr", url: prUrl }],
      },
    });
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          totalThreads: 2,
          unresolvedThreads: 0,
        }),
      });
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const prLink = page.locator(`a[href='${prUrl}']`).first();
    await expect(prLink).toBeVisible();
    await expect(prLink.locator("[data-pr-review-decision='approved']")).toBeVisible();
  });
});

test.describe("S4b: Artifacts section", () => {
  test("renders artifact cards with preview and download actions", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4b-1",
      artifacts: [
        {
          id: "screenshot.png",
          name: "screenshot.png",
          size: 1024,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "capture.webm",
          name: "capture.webm",
          size: 2048,
          mimeType: "video/webm",
          kind: "video",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "trace.log",
          name: "trace.log",
          size: 4096,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Artifacts")).toBeVisible();
    await expect(page.getByAltText("screenshot.png")).toBeVisible();
    await expect(page.getByLabel("capture.webm preview")).toBeVisible();
    await expect(page.getByText("trace.log")).toBeVisible();

    await page.getByText("screenshot.png").hover();
    await page.getByRole("button", { name: "Preview screenshot.png" }).click();
    const dialog = page.getByRole("dialog", { name: "Artifact preview screenshot.png" });
    await expect(dialog).toBeVisible();
    await expectArtifactControlsOutsideSurface(page);
    await expect(dialog.getByRole("button", { name: "Previous artifact" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Next artifact" })).toBeEnabled();
    await expect(dialog.getByRole("link", { name: "Download screenshot.png" })).toHaveAttribute(
      "href",
      "/api/sessions/detail-s4b-1/artifacts/screenshot.png",
    );

    const imageSurfaceBox = await dialog.getByLabel("Artifact preview surface").boundingBox();
    expect(imageSurfaceBox).not.toBeNull();
    if (!imageSurfaceBox) throw new Error("Artifact preview surface missing bounds");
    await page.mouse.click(
      imageSurfaceBox.x + imageSurfaceBox.width * 0.75,
      imageSurfaceBox.y + imageSurfaceBox.height / 2,
    );
    await expect(page.getByRole("dialog", { name: "Artifact preview capture.webm" })).toBeVisible();
    await expectArtifactControlsOutsideSurface(page);

    const videoDialog = page.getByRole("dialog", { name: "Artifact preview capture.webm" });
    const videoSurfaceBox = await videoDialog.getByLabel("Artifact preview surface").boundingBox();
    expect(videoSurfaceBox).not.toBeNull();
    if (!videoSurfaceBox) throw new Error("Artifact preview surface missing bounds");
    await page.mouse.move(
      videoSurfaceBox.x + videoSurfaceBox.width * 0.75,
      videoSurfaceBox.y + videoSurfaceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      videoSurfaceBox.x + videoSurfaceBox.width * 0.25,
      videoSurfaceBox.y + videoSurfaceBox.height / 2 + 4,
    );
    await page.mouse.up();
    const fileDialog = page.getByRole("dialog", { name: "Artifact preview trace.log" });
    await expect(fileDialog).toBeVisible();
    await expectArtifactControlsOutsideSurface(page);
    await expect(fileDialog.getByRole("button", { name: "Next artifact" })).toBeDisabled();
    await expect(fileDialog.getByRole("link", { name: "Download File" })).toHaveAttribute(
      "href",
      "/api/sessions/detail-s4b-1/artifacts/trace.log",
    );
    await fileDialog.getByRole("link", { name: "Download File" }).click({ trial: true });
    await expect(fileDialog).toBeVisible();

    await fileDialog.getByRole("button", { name: "Previous artifact" }).click();
    await expect(page.getByRole("dialog", { name: "Artifact preview capture.webm" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("image lightbox zoom buttons scale and reset the preview", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4b-zoom",
      artifacts: [
        {
          id: "shot.png",
          name: "shot.png",
          size: 1024,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Artifacts")).toBeVisible();
    await page.getByRole("button", { name: "Preview shot.png" }).click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Artifact preview shot.png" });
    await expect(dialog).toBeVisible();

    const image = dialog.locator("img");
    const zoomIn = dialog.getByRole("button", { name: "Zoom in" });
    const zoomOut = dialog.getByRole("button", { name: "Zoom out" });
    const resetZoom = dialog.getByRole("button", { name: "Reset zoom" });

    await expect(zoomOut).toBeDisabled();
    await expect(resetZoom).toBeDisabled();
    await expect(image).toHaveAttribute("style", /scale\(1\)/);

    await zoomIn.click();
    await expect(image).toHaveAttribute("style", /scale\(1\.5\)/);
    await expect(zoomOut).toBeEnabled();
    await expect(resetZoom).toBeEnabled();

    await resetZoom.click();
    await expect(image).toHaveAttribute("style", /scale\(1\)/);
    await expect(zoomOut).toBeDisabled();
    await expect(resetZoom).toBeDisabled();
  });

  test("text lightbox preview scrolls overflowing content", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4b-text-scroll",
      artifacts: [
        {
          id: "long.txt",
          name: "long.txt",
          size: 4096,
          mimeType: "text/plain; charset=utf-8",
          kind: "text",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.route("**/api/sessions/detail-s4b-text-scroll/artifacts/long.txt", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n"),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Artifacts")).toBeVisible();
    await page.getByRole("button", { name: "Preview long.txt" }).click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Artifact preview long.txt" });
    await expect(dialog).toBeVisible();

    const scroller = dialog.locator("[data-artifact-lightbox-interactive]");
    await expect(scroller).toBeVisible();
    const overflow = await scroller.evaluate((node) => node.scrollHeight > node.clientHeight);
    expect(overflow).toBe(true);
    await scroller.evaluate((node) => {
      node.scrollTop = 200;
    });
    const scrolled = await scroller.evaluate((node) => node.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await expect(scroller).toHaveCSS("overscroll-behavior-y", "contain");
  });

  test("tap on an oversize text preview still navigates to the next artifact", async ({ page }) => {
    // Oversize artifacts never get fetched (SessionDetail.tsx TEXT_ARTIFACT_MAX_BYTES guard),
    // so this reaches a deterministic non-content state without stalling any route.
    const session = makeWorkingSession({
      id: "detail-s4b-oversize-nav",
      artifacts: [
        {
          id: "huge-one.txt",
          name: "huge-one.txt",
          size: 1024 * 1024 + 1,
          mimeType: "text/plain; charset=utf-8",
          kind: "text",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "huge-two.txt",
          name: "huge-two.txt",
          size: 1024 * 1024 + 1,
          mimeType: "text/plain; charset=utf-8",
          kind: "text",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Artifacts")).toBeVisible();
    await page.getByRole("button", { name: "Preview huge-one.txt" }).click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Artifact preview huge-one.txt" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("File exceeds 1 MiB preview limit. Download to view the full content."),
    ).toBeVisible();

    const surfaceBox = await dialog.getByLabel("Artifact preview surface").boundingBox();
    expect(surfaceBox).not.toBeNull();
    if (!surfaceBox) throw new Error("Artifact preview surface missing bounds");
    await page.mouse.click(
      surfaceBox.x + surfaceBox.width * 0.75,
      surfaceBox.y + surfaceBox.height / 2,
    );

    await expect(page.getByRole("dialog", { name: "Artifact preview huge-two.txt" })).toBeVisible();
  });

  test("mobile text lightbox scrolls on first open without a pinch", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const session = makeWorkingSession({
      id: "detail-s4b-mobile-text-scroll",
      artifacts: [
        {
          id: "long.txt",
          name: "long.txt",
          size: 4096,
          mimeType: "text/plain; charset=utf-8",
          kind: "text",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    try {
      await mockSessionDetail(page, session);
      await page.route(
        "**/api/sessions/detail-s4b-mobile-text-scroll/artifacts/long.txt",
        (route) => {
          void route.fulfill({
            status: 200,
            contentType: "text/plain; charset=utf-8",
            body: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n"),
          });
        },
      );
      await page.goto(`/sessions/${session.id}`);
      await expect(page.getByText("Artifacts")).toBeVisible();
      await page.getByRole("button", { name: "Preview long.txt" }).click({ force: true });

      const dialog = page.getByRole("dialog", { name: "Artifact preview long.txt" });
      await expect(dialog).toBeVisible();

      const scroller = dialog.locator("[data-artifact-lightbox-interactive]");
      await expect(scroller).toHaveCSS("overflow-y", "auto");

      const overflow = await scroller.evaluate((node) => node.scrollHeight > node.clientHeight);
      expect(overflow).toBe(true);

      const box = await scroller.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error("Artifact preview scroller missing bounds");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);

      await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

      const bodyOverflow = await page.evaluate(() => document.body.style.overflow);
      expect(bodyOverflow).toBe("hidden");

      await expectArtifactControlsOutsideSurface(page);
    } finally {
      await context.close();
    }
  });

  test("mobile pinch zooms the image lightbox preview", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const session = makeWorkingSession({
      id: "detail-s4b-pinch",
      artifacts: [
        {
          id: "pinch.png",
          name: "pinch.png",
          size: 1024,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    try {
      await mockSessionDetail(page, session);
      await page.route(`**/api/sessions/${session.id}/artifacts/pinch.png`, (route) => {
        void route.fulfill({
          status: 200,
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
          ),
        });
      });
      await page.goto(`/sessions/${session.id}`);
      await expect(page.getByText("Artifacts")).toBeVisible();
      await page.getByRole("button", { name: "Preview pinch.png" }).click({ force: true });

      const dialog = page.getByRole("dialog", { name: "Artifact preview pinch.png" });
      await expect(dialog).toBeVisible();
      const pinchSurface = dialog.locator('[class*="touch-action:none"]').first();
      await expect(pinchSurface).toBeVisible();

      const image = dialog.locator("img");
      await expect(image).toHaveClass(/opacity-100/);

      await dispatchPointerPinch(pinchSurface, 40, 80);

      await expect(image).toHaveAttribute("style", /scale\((?:1\.\d|[2-5])/);
    } finally {
      await context.close();
    }
  });

  test("mobile touch swipe navigates the artifact lightbox without taking vertical scroll", async ({
    browser,
  }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const session = makeWorkingSession({
      id: "detail-s4b-touch-swipe",
      artifacts: [
        {
          id: "first.png",
          name: "first.png",
          size: 1024,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "second.png",
          name: "second.png",
          size: 1024,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    try {
      await mockSessionDetail(page, session);
      await page.goto(`/sessions/${session.id}`);
      await expect(page.getByText("Artifacts")).toBeVisible();
      await page.getByRole("button", { name: "Preview first.png" }).click({ force: true });

      const firstDialog = page.getByRole("dialog", { name: "Artifact preview first.png" });
      await expect(firstDialog).toBeVisible();
      await expectArtifactControlsOutsideSurface(page);
      const firstSurface = firstDialog.getByLabel("Artifact preview surface");
      await expect(firstSurface).toHaveCSS("touch-action", "pan-y");
      const firstSurfaceBox = await firstSurface.boundingBox();
      expect(firstSurfaceBox).not.toBeNull();
      if (!firstSurfaceBox) throw new Error("Artifact preview surface missing bounds");

      await dispatchTouchSwipe(
        page,
        {
          x: firstSurfaceBox.x + firstSurfaceBox.width * 0.75,
          y: firstSurfaceBox.y + firstSurfaceBox.height / 2,
        },
        {
          x: firstSurfaceBox.x + firstSurfaceBox.width * 0.25,
          y: firstSurfaceBox.y + firstSurfaceBox.height / 2 + 4,
        },
      );

      const secondDialog = page.getByRole("dialog", { name: "Artifact preview second.png" });
      await expect(secondDialog).toBeVisible();
      const secondSurfaceBox = await secondDialog
        .getByLabel("Artifact preview surface")
        .boundingBox();
      expect(secondSurfaceBox).not.toBeNull();
      if (!secondSurfaceBox) throw new Error("Artifact preview surface missing bounds");

      await dispatchTouchSwipe(
        page,
        {
          x: secondSurfaceBox.x + secondSurfaceBox.width / 2,
          y: secondSurfaceBox.y + secondSurfaceBox.height * 0.25,
        },
        {
          x: secondSurfaceBox.x + secondSurfaceBox.width / 2 + 8,
          y: secondSurfaceBox.y + secondSurfaceBox.height * 0.75,
        },
      );
      await expect(secondDialog).toBeVisible();

      await dispatchTouchSwipe(
        page,
        {
          x: secondSurfaceBox.x + secondSurfaceBox.width * 0.25,
          y: secondSurfaceBox.y + secondSurfaceBox.height / 2,
        },
        {
          x: secondSurfaceBox.x + secondSurfaceBox.width * 0.75,
          y: secondSurfaceBox.y + secondSurfaceBox.height / 2 + 4,
        },
      );
      await expect(page.getByRole("dialog", { name: "Artifact preview first.png" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("mobile text artifact preview keeps side controls outside wrapped content", async ({
    browser,
  }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const session = makeWorkingSession({
      id: "detail-s4b-mobile-text-controls",
      artifacts: [
        {
          id: "wrapped.txt",
          name: "wrapped.txt",
          size: 180,
          mimeType: "text/plain; charset=utf-8",
          kind: "text",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "next.txt",
          name: "next.txt",
          size: 24,
          mimeType: "text/plain; charset=utf-8",
          kind: "text",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    try {
      await mockSessionDetail(page, session);
      await page.route(
        "**/api/sessions/detail-s4b-mobile-text-controls/artifacts/wrapped.txt",
        (route) => {
          void route.fulfill({
            status: 200,
            contentType: "text/plain; charset=utf-8",
            body: "wrapped text preview starts with a deliberately long line that must wrap without sitting under the next control",
          });
        },
      );
      await page.route(
        "**/api/sessions/detail-s4b-mobile-text-controls/artifacts/next.txt",
        (route) => {
          void route.fulfill({
            status: 200,
            contentType: "text/plain; charset=utf-8",
            body: "next file",
          });
        },
      );

      await page.goto(`/sessions/${session.id}`);
      await expect(page.getByText("Artifacts")).toBeVisible();
      await page.getByRole("button", { name: "Preview wrapped.txt" }).click({ force: true });

      const dialog = page.getByRole("dialog", { name: "Artifact preview wrapped.txt" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/wrapped text preview starts/)).toBeVisible();
      await expectArtifactControlsOutsideSurface(page);
      await expect(dialog.getByRole("button", { name: "Next artifact" })).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  test("shows agent artifacts by default and reveals system artifacts only after toggle", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "detail-s4b-2",
      artifacts: [
        {
          id: "agent-output.txt",
          name: "agent-output.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "agent-history.jsonl",
          name: "agent-history.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("button", { name: "Agent (1)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("agent-output.txt")).toBeVisible();
    await expect(page.getByText("agent-history.jsonl")).toHaveCount(0);

    await page.getByRole("button", { name: "System (1)" }).click();

    await expect(page.getByText("agent-history.jsonl")).toBeVisible();
    await expect(page.getByText("agent-output.txt")).toHaveCount(0);
  });

  test("shows user-added artifacts only in the attached view", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4b-3",
      artifacts: [
        {
          id: "agent-output.txt",
          name: "agent-output.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "later-upload.png",
          name: "later-upload.png",
          size: 2200,
          mimeType: "image/png",
          kind: "image",
          origin: "intentional",
          addedByUser: true,
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("agent-output.txt")).toBeVisible();
    await expect(page.getByText("later-upload.png")).toHaveCount(0);

    await page.getByRole("button", { name: "Attached (1)" }).click();

    await expect(page.getByText("later-upload.png")).toBeVisible();
    const attachedCard = page.getByRole("article", {
      name: "Attached Image artifact later-upload.png",
    });
    await expect(attachedCard).toBeVisible();
    await expect(attachedCard.getByText("Attached Image")).toBeVisible();
    await expect(attachedCard.getByText("PNG", { exact: true })).toBeVisible();
    await expect(page.getByText("agent-output.txt")).toHaveCount(0);
  });

  test("resets to agent view after navigating to another session", async ({ page }) => {
    const firstSession = makeWorkingSession({
      id: "detail-s4b-4",
      artifacts: [
        {
          id: "agent-first.txt",
          name: "agent-first.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "agent-history-first.jsonl",
          name: "agent-history-first.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    const secondSession = makeWorkingSession({
      id: "detail-s4b-5",
      artifacts: [
        {
          id: "agent-second.txt",
          name: "agent-second.txt",
          size: 4200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });
    await mockSessionDetail(page, firstSession);
    await mockSessionDetail(page, secondSession);

    await page.goto(`/sessions/${firstSession.id}`);
    await page.getByRole("button", { name: "System (1)" }).click();
    await expect(page.getByText("agent-history-first.jsonl")).toBeVisible();

    await page.goto(`/sessions/${secondSession.id}`);

    await expect(page.getByText("agent-second.txt")).toBeVisible();
    await expect(page.getByText("agent-history-first.jsonl")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /system \(/i })).toHaveCount(0);
  });
});

// S5: Runtime sidebar
test.describe("S5: Runtime sidebar", () => {
  test("Created and Last activity fields visible", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s5-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Created")).toBeVisible();
    await expect(page.getByText("Last activity")).toBeVisible();
  });

  test("Worktree path visible", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s5-2",
      worktreePath: "/tmp/worktrees/detail-s5-2",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Worktree path")).toBeVisible();
    await expect(page.getByText(/worktrees\/detail-s5-2/)).toBeVisible();
  });

  test("copy workspace access entries are visible when configured", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s5-3",
      workspaceAccess: {
        items: [
          {
            label: "Cursor",
            kind: "copy",
            value: "cursor --remote ssh-remote+100.80.107.19 /tmp/worktrees/detail-s5-3",
          },
        ],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Cursor", { exact: true })).toBeVisible();
    await expect(
      page.getByText("cursor --remote ssh-remote+100.80.107.19 /tmp/worktrees/detail-s5-3"),
    ).toBeVisible();
  });

  test("workspace access copy action writes the command to clipboard and shows a toast", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const command = "cursor --remote ssh-remote+100.80.107.19 /tmp/worktrees/detail-s5-4";
    const session = makeWorkingSession({
      id: "detail-s5-4",
      workspaceAccess: {
        items: [{ label: "Cursor", kind: "copy", value: command }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^copy cursor$/i }).click();

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);
    await expect(page.getByText("Cursor copied")).toBeVisible();
  });
});

// S6: Terminal modal from detail page
test.describe("S6: Terminal modal from detail page", () => {
  test("Terminal button opens terminal modal", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s6-1" });
    await mockSessionDetail(page, session);

    await page.goto(`/sessions/${session.id}`);

    const termBtn = page.getByRole("button", { name: /^terminal$/i });
    await expect(termBtn).toBeVisible();
    await termBtn.click();

    // URL should have terminal query param
    await expect(page).toHaveURL(new RegExp(`terminal=${session.id}`));
  });

  test("terminal controls inset sideways for safe-area without extra vertical height", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s6-safe" });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);

    await page.goto(`/sessions/${session.id}?terminal=${session.id}`);

    const terminalDialog = page.getByRole("dialog", { name: new RegExp(`Terminal ${session.id}`) });
    await expect(terminalDialog).toBeVisible();

    const controls = terminalDialog.getByTestId("direct-terminal-controls");
    await expect(controls).toBeVisible();
    const padding = await controls.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
        top: parseFloat(style.paddingTop),
        bottom: parseFloat(style.paddingBottom),
      };
    });
    // Side padding resolves to the 0.5rem base (env insets are 0 in headless);
    // a dropped/invalid calc() would collapse this to 0.
    expect(padding.left).toBeGreaterThanOrEqual(8);
    expect(padding.right).toBeGreaterThanOrEqual(8);
    // Vertical padding stays at py-1.5 (6px) — the inset adds no top/bottom height.
    expect(padding.top).toBe(6);
    expect(padding.bottom).toBe(6);
  });

  test("terminal header keeps the sidecar suffix in its title line", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s6-title",
      slots: { title: "Header title from slot", links: [] },
      sidecars: [{ name: "isolated-ui", alive: true }],
    });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);

    await page.goto(`/sessions/${session.id}?terminal=${session.id}--isolated-ui`);

    const terminalDialog = page.getByRole("dialog", { name: new RegExp(`Terminal ${session.id}`) });
    await expect(terminalDialog).toBeVisible();
    await expect(terminalDialog.getByText("Header title from slot • isolated-ui")).toBeVisible();
    await expect(terminalDialog.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );
  });

  test("terminal header clamps long title to two CSS lines", async ({ page }) => {
    const title =
      "Terminal header title uses available space and clamps to two lines without clipping controls when the session title is very long";
    const session = makeWorkingSession({
      id: "detail-s6-wrap",
      project: "Terminal header project name uses available space and wraps without clipping",
      slots: { title, links: [] },
      sidecars: [{ name: "isolated-ui", alive: true }],
    });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);

    const overlaps = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 320, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/sessions/${session.id}?terminal=${session.id}--isolated-ui`);

      const terminalDialog = page.getByRole("dialog", {
        name: new RegExp(`Terminal ${session.id}`),
      });
      await expect(terminalDialog).toBeVisible();

      const header = terminalDialog.locator('[data-testid="direct-terminal-header"]');
      const titleText = header.getByTestId("direct-terminal-header-title");
      const statusDot = header.getByTestId("direct-terminal-header-status-dot");
      const closeButton = terminalDialog.getByRole("button", { name: /close terminal/i });
      const controls = terminalDialog.locator(":scope > div > div").nth(2);

      await expect(titleText).toContainText("isolated-ui");
      await expect(statusDot).toHaveAttribute("data-ws-status", "connected");
      await expect(controls).toBeVisible();

      const titleClamp = await titleText.evaluate((element) => {
        const styles = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          lineClamp: styles.getPropertyValue("-webkit-line-clamp"),
          lineHeight: Number.parseFloat(styles.lineHeight),
          overflow: styles.overflow,
        };
      });
      expect(titleClamp.lineClamp).toBe("2");
      expect(titleClamp.overflow).toBe("hidden");
      expect(titleClamp.height).toBeLessThanOrEqual(titleClamp.lineHeight * 2 + 1);

      const [titleBox, statusBox, closeBox] = await Promise.all([
        titleText.boundingBox(),
        statusDot.boundingBox(),
        closeButton.boundingBox(),
      ]);

      if (!titleBox || !statusBox || !closeBox) {
        throw new Error("Expected terminal header text and controls to have bounding boxes");
      }

      expect(overlaps(titleBox, statusBox)).toBe(false);
      expect(overlaps(titleBox, closeBox)).toBe(false);
      if (viewport.width >= 640) {
        const titleCenterY = titleBox.y + titleBox.height / 2;
        const statusCenterY = statusBox.y + statusBox.height / 2;
        const closeCenterY = closeBox.y + closeBox.height / 2;
        expect(Math.abs(titleCenterY - statusCenterY)).toBeLessThanOrEqual(1);
        expect(Math.abs(titleCenterY - closeCenterY)).toBeLessThanOrEqual(1);
      }

      const headerMetrics = await header.evaluate((element) => {
        const headerElement = element as HTMLDivElement;
        return {
          clientWidth: headerElement.clientWidth,
          scrollWidth: headerElement.scrollWidth,
        };
      });
      expect(headerMetrics.scrollWidth).toBeLessThanOrEqual(headerMetrics.clientWidth + 1);

      const overflowMetrics = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const controlsElement = dialog?.querySelector(":scope > div > div:nth-child(3)");
        if (!(dialog instanceof HTMLElement) || !(controlsElement instanceof HTMLElement)) {
          throw new Error("Expected terminal dialog and controls");
        }

        return {
          bodyScrollWidth: document.body.scrollWidth,
          controlsClientWidth: controlsElement.clientWidth,
          controlsScrollWidth: controlsElement.scrollWidth,
          dialogClientWidth: dialog.clientWidth,
          dialogScrollWidth: dialog.scrollWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(overflowMetrics.documentScrollWidth).toBeLessThanOrEqual(
        overflowMetrics.viewportWidth,
      );
      expect(overflowMetrics.bodyScrollWidth).toBeLessThanOrEqual(overflowMetrics.viewportWidth);
      expect(overflowMetrics.dialogScrollWidth).toBeLessThanOrEqual(
        overflowMetrics.dialogClientWidth,
      );
      expect(overflowMetrics.controlsScrollWidth).toBeLessThanOrEqual(
        overflowMetrics.controlsClientWidth,
      );
    }
  });

  test("URL gets terminal=<id> when terminal opened, removed when closed", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s6-2" });
    await mockSessionDetail(page, session);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page).toHaveURL(new RegExp(`terminal=${session.id}`));

    // Close the terminal modal via the Close terminal button (aria-label)
    const closeBtn = page.getByRole("button", { name: /close terminal/i });
    await expect(closeBtn).toBeVisible({ timeout: 8000 });
    await closeBtn.click();

    // URL should no longer contain terminal param
    await expect(page).not.toHaveURL(new RegExp(`terminal=`));
  });

  test("opening terminal sets body overflow hidden to block page scroll", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s6-3" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page).toHaveURL(new RegExp(`terminal=`));

    const overflow = await page.evaluate(() => document.body.style.overflow);
    expect(overflow).toBe("hidden");

    await page.getByRole("button", { name: /close terminal/i }).click();
    const overflowRestored = await page.evaluate(() => document.body.style.overflow);
    expect(overflowRestored).not.toBe("hidden");
  });

  test("recording state shows edit, queue, and send buttons; edit opens modal", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      class TestMediaRecorder {
        mimeType = "audio/webm";
        state = "inactive";
        private listeners = new Map<string, Array<(event?: unknown) => void>>();

        addEventListener(type: string, listener: (event?: unknown) => void) {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        start() {
          this.state = "recording";
        }

        stop() {
          this.state = "inactive";
          const blob = new Blob(["voice-audio"], { type: this.mimeType });
          this.emit("dataavailable", blob);
          this.emit("stop");
        }

        private emit(type: string, data?: Blob) {
          for (const listener of this.listeners.get(type) ?? []) {
            listener(data ? { data } : undefined);
          }
        }
      }

      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        writable: true,
        value: TestMediaRecorder,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
          }),
        },
      });
    });

    const session = makeWorkingSession({ id: "detail-s6-voice-rec" });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "stop button transcript");

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );

    const terminalDialog = page.getByRole("dialog", { name: /terminal/i });

    // Idle: only mic in terminal control bar.
    await expect(
      terminalDialog.getByRole("button", { name: /start voice recording/i }),
    ).toBeVisible();
    await expect(
      terminalDialog.getByRole("button", { name: /edit voice transcript/i }),
    ).toHaveCount(0);
    await expect(terminalDialog.getByRole("button", { name: /stop and send voice/i })).toHaveCount(
      0,
    );

    await terminalDialog.getByRole("button", { name: /start voice recording/i }).click();

    // Recording: footer mic slot becomes stop/send; edit/queue/cancel actions stack above it.
    const pencil = terminalDialog.getByRole("button", { name: /edit voice transcript/i });
    const queue = terminalDialog.getByRole("button", { name: /send voice to queue/i });
    const stop = terminalDialog.getByRole("button", { name: /stop and send voice/i });
    const cancel = terminalDialog.getByRole("button", { name: /cancel voice recording/i });
    await expect(pencil).toBeVisible();
    await expect(queue).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(queue).toHaveCSS("background-color", "rgb(13, 13, 14)");
    await expect(terminalDialog.getByRole("button", { name: /stop voice recording/i })).toHaveCount(
      0,
    );

    // Pencil click → opens modal (edit flow).
    await pencil.click();
    await expect(page.getByRole("dialog", { name: /confirm voice input/i })).toBeVisible();
  });

  test("pasted terminal image opens confirmation modal and sends an attachment", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s6-image-paste" });
    let sendPayload: unknown = null;
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      sendPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );

    await page.locator('[data-testid="direct-terminal-surface"]').evaluate((surface) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["PNG"], "terminal-paste.png", { type: "image/png" }));
      surface.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    await expect(modal.getByRole("img", { name: "terminal-paste.png" })).toBeVisible();
    await expect(modal.getByRole("button", { name: /add to queue/i })).toBeVisible();
    await modal.getByRole("button", { name: /insert/i }).click();

    await expect
      .poll(() => sendPayload)
      .toMatchObject({
        attachments: [{ name: "terminal-paste.png" }],
        interrupt: true,
        message: "",
        queue: false,
      });
  });

  test("direct-terminal send failing with 409 shows a rate-limited toast", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s6-rate-limited" });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: `Session ${session.id} is rate limited` }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );

    await page.locator('[data-testid="direct-terminal-surface"]').evaluate((surface) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["PNG"], "terminal-paste.png", { type: "image/png" }));
      surface.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    await expect(modal.getByRole("img", { name: "terminal-paste.png" })).toBeVisible();
    await modal.getByRole("button", { name: /insert/i }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "this session is currently rate limited" }),
    ).toBeVisible();
  });

  test("returning to a visible tab does not reconnect an already-open terminal websocket", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s6-4" });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );
    await expect.poll(async () => getTerminalSocketCount(page)).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await page.waitForTimeout(1_100);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect.poll(async () => getTerminalSocketCount(page)).toBe(1);
  });
});

// S7: Display state preserves terminal states over claude JSONL "working"
test.describe("S7: Display state override", () => {
  test("errored session shows error, not working, even when conversation reports working", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "detail-s7-1",
      status: "errored",
      state: "error",
      runtimeAlive: false,
      error: "Failed to fast-forward local branch",
    });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "working");
    await page.goto(`/sessions/${session.id}`);

    const header = page.locator("header").first();
    await expect(header.getByText("error", { exact: true }).first()).toBeVisible();
    await expect(header.getByText("working", { exact: true })).toHaveCount(0);
  });

  test("completed session shows stopped label, not working", async ({ page }) => {
    const session = makeCompletedSession({ id: "detail-s7-2" });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "working");
    await page.goto(`/sessions/${session.id}`);

    const header = page.locator("header").first();
    await expect(header.getByText("stopped", { exact: true }).first()).toBeVisible();
    await expect(header.getByText("working", { exact: true })).toHaveCount(0);
  });

  test("working session still shows working when conversation reports working", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s7-3" });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "working");
    await page.goto(`/sessions/${session.id}`);

    const header = page.locator("header").first();
    await expect(header.getByText("working", { exact: true }).first()).toBeVisible();
  });
});
