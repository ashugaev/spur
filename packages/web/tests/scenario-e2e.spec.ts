import { devices, test, expect, type Locator, type Page } from "playwright/test";
import { join } from "node:path";
import { makeWorkingSession, mockSessions, type ProjectInfo } from "./fixtures.js";

type WorkingSession = ReturnType<typeof makeWorkingSession>;

const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

async function openSpawnModal(page: Page) {
  const session = makeWorkingSession({ id: "scenario-spawn-base", project: "my-project" });
  await mockSessions(page, [session], DEFAULT_PROJECTS);
  await page.route("**/api/sessions**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/sessions") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [session],
        projects: [
          {
            id: "my-project",
            name: "my-project",
            configured: true,
            prefix: "my-project",
            path: "",
          },
        ],
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Spawn Session" }).click();
  await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
  const projectSelect = page.getByRole("combobox", { name: "Spawn project" });
  await expect(projectSelect.locator("option[value='my-project']")).toHaveCount(1);
  await projectSelect.selectOption("my-project");
}

function spawnModal(page: Page) {
  return page.getByRole("dialog", { name: /^spawn session$/i });
}

function mockSessionDetail(page: Page, session: WorkingSession) {
  return page.route(`**/api/sessions/${session.id}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

function mockVoiceStatus(page: Page) {
  return page.route("**/api/runtime/voice", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, language: "auto", modelPath: "/models/base.bin" }),
    });
  });
}

function mockVoiceTranscribe(
  page: Page,
  text: string,
  options: { failFirstAttempts?: number; onRequest?: () => void } = {},
) {
  let calls = 0;
  return page.route("**/api/runtime/voice/transcribe", async (route) => {
    calls += 1;
    options.onRequest?.();
    if (calls <= (options.failFirstAttempts ?? 0)) {
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

async function installBlockedMicrophoneMock(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });
}

async function mockTerminal(page: Page) {
  await page.addInitScript(() => {
    type SentInput = { raw: string; data?: string };
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

      send(raw: string) {
        const sent: SentInput = { raw };
        try {
          const parsed = JSON.parse(raw) as { type?: string; id?: string; data?: string };
          if (parsed.type === "input" && typeof parsed.id === "string") {
            sent.data = parsed.data;
            queueMicrotask(() => {
              this.onmessage?.(
                new MessageEvent("message", {
                  data: JSON.stringify({ type: "ack", id: parsed.id }),
                }),
              );
            });
          }
        } catch {
          sent.data = raw;
        }
        state.sent.push(sent);
      }

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
      sent: [] as SentInput[],
      emitOutput(data: string) {
        const socket = this.sockets.at(-1);
        socket?.onmessage?.(new MessageEvent("message", { data }));
      },
    };

    Object.defineProperty(window, "__scenarioTerminalState", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });
  });

  await page.route("**/api/runtime/terminal**", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ directTerminalPort: 14801 }),
    });
  });
}

async function openTerminal(page: Page, session: WorkingSession) {
  await mockSessionDetail(page, session);
  await mockTerminal(page);
  await page.goto(`/sessions/${session.id}`);
  await page.getByRole("button", { name: /^terminal$/i }).click();
  await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
    "data-ws-status",
    "connected",
  );
  return page.getByRole("dialog", { name: /terminal/i });
}

async function terminalSentData(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const windowWithState = window as unknown as {
      __scenarioTerminalState?: { sent: Array<{ data?: string }> };
    };
    return (
      windowWithState.__scenarioTerminalState?.sent
        .map((entry) => entry.data)
        .filter((entry): entry is string => typeof entry === "string") ?? []
    );
  });
}

async function emitTerminalOutput(page: Page, data: string) {
  await page.evaluate((output) => {
    const windowWithState = window as unknown as {
      __scenarioTerminalState?: { emitOutput: (value: string) => void };
    };
    windowWithState.__scenarioTerminalState?.emitOutput(output);
  }, data);
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

async function captureTerminalLinksState(page: Page, name: string) {
  const outputDir = process.env.SPUR_SESSION_ARTIFACTS_DIR ?? test.info().outputDir;
  await page.screenshot({ path: join(outputDir, `terminal-links-${name}.png`) });
}

async function expectTerminalLinksWithinViewport(
  page: Page,
  terminal: Locator,
  trigger: Locator,
  panel: Locator,
) {
  const viewport = page.viewportSize();
  const controlsBox = await terminal.getByTestId("direct-terminal-controls").boundingBox();
  const triggerBox = await trigger.boundingBox();
  const panelBox = await panel.boundingBox();
  if (!viewport || !controlsBox || !triggerBox || !panelBox) {
    throw new Error("Terminal links layout bounds unavailable");
  }
  expect(triggerBox.x).toBeGreaterThanOrEqual(controlsBox.x);
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(controlsBox.x + controlsBox.width);
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
  expect(panelBox.y).toBeGreaterThanOrEqual(0);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height);
}

test.describe("scenario migration E2E: spawn voice", () => {
  test("spawn recording can be cancelled without transcribing or changing prompt", async ({
    page,
  }) => {
    let transcribeCalls = 0;
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "unused", { onRequest: () => (transcribeCalls += 1) });
    await openSpawnModal(page);
    const modal = spawnModal(page);

    await modal.getByRole("button", { name: /start voice recording/i }).click();
    await expect(modal.getByRole("button", { name: /stop voice recording/i })).toBeVisible();
    await expect(modal.getByRole("button", { name: /cancel voice recording/i })).toBeVisible();
    await modal.getByRole("button", { name: /cancel voice recording/i }).click();

    await expect(modal.getByRole("button", { name: /start voice recording/i })).toBeVisible();
    await expect(page.getByPlaceholder("Prompt... Voice ⌘ + .")).toHaveValue("");
    expect(transcribeCalls).toBe(0);
  });

  test("spawn recording stop inserts transcription directly without confirmation modal", async ({
    page,
  }) => {
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Spawn prompt from voice");
    await openSpawnModal(page);
    const modal = spawnModal(page);

    await modal.getByRole("button", { name: /start voice recording/i }).click();
    await modal.getByRole("button", { name: /stop voice recording/i }).click();

    await expect(page.getByPlaceholder("Prompt... Voice ⌘ + .")).toHaveValue(
      "Spawn prompt from voice",
    );
    await expect(page.getByRole("dialog", { name: /confirm voice input/i })).toHaveCount(0);
  });

  test("spawn Cmd+. starts and stops voice recording", async ({ page }) => {
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Spawn hotkey transcript");
    await openSpawnModal(page);
    const modal = spawnModal(page);

    const textarea = page.getByLabel("Prompt...");
    await textarea.focus();
    await textarea.press("Meta+.");
    await expect(modal.getByRole("button", { name: /stop voice recording/i })).toBeVisible();
    await textarea.press("Meta+.");

    await expect(textarea).toHaveValue("Spawn hotkey transcript");
  });

  test("spawn failed transcription keeps retry controls across reload", async ({ page }) => {
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Recovered spawn recording", { failFirstAttempts: 3 });
    await openSpawnModal(page);
    const modal = spawnModal(page);

    await modal.getByRole("button", { name: /start voice recording/i }).click();
    await modal.getByRole("button", { name: /stop voice recording/i }).click();

    await expect(modal.getByText(/Failed to transcribe audio after 3 attempts/i)).toBeVisible();
    await expect(modal.getByRole("button", { name: /play failed voice recording/i })).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /retry failed voice recording/i }),
    ).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /discard failed voice recording/i }),
    ).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    const reopenedModal = spawnModal(page);
    await expect(
      reopenedModal.getByRole("button", { name: /retry failed voice recording/i }),
    ).toBeVisible();
    await reopenedModal.getByRole("button", { name: /retry failed voice recording/i }).click();

    await expect(page.getByPlaceholder("Prompt... Voice ⌘ + .")).toHaveValue(
      "Recovered spawn recording",
    );
  });

  test("spawn failed transcription can be discarded back to idle controls", async ({ page }) => {
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "unused", { failFirstAttempts: 3 });
    await openSpawnModal(page);
    const modal = spawnModal(page);

    await modal.getByRole("button", { name: /start voice recording/i }).click();
    await modal.getByRole("button", { name: /stop voice recording/i }).click();
    await expect(
      modal.getByRole("button", { name: /discard failed voice recording/i }),
    ).toBeVisible();

    await modal.getByRole("button", { name: /discard failed voice recording/i }).click();

    await expect(modal.getByRole("button", { name: /start voice recording/i })).toBeVisible();
    await expect(modal.getByRole("button", { name: /retry failed voice recording/i })).toHaveCount(
      0,
    );
    await expect(page.getByPlaceholder("Prompt... Voice ⌘ + .")).toHaveValue("");
  });
});

test.describe("scenario migration E2E: session composer voice", () => {
  test("message recording stop inserts transcription directly without confirmation modal", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-message-voice-direct" });
    await installVoiceMediaMocks(page);
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Message voice transcript");

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /start voice recording/i }).click();
    await page.getByRole("button", { name: /stop voice recording/i }).click();

    await expect(page.getByPlaceholder("Message... Voice ⌘ + .")).toHaveValue(
      "Message voice transcript",
    );
    await expect(page.getByRole("dialog", { name: /confirm voice input/i })).toHaveCount(0);
  });

  test("message recording cancel keeps composer empty and skips transcription", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-message-voice-cancel" });
    let transcribeCalls = 0;
    await installVoiceMediaMocks(page);
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "unused", { onRequest: () => (transcribeCalls += 1) });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /start voice recording/i }).click();
    await page.getByRole("button", { name: /cancel voice recording/i }).click();

    await expect(page.getByPlaceholder("Message... Voice ⌘ + .")).toHaveValue("");
    await expect(page.getByRole("button", { name: /start voice recording/i })).toBeVisible();
    expect(transcribeCalls).toBe(0);
  });

  test("message failed transcription survives reload and retries into composer", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-message-voice-reload" });
    await installVoiceMediaMocks(page);
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Recovered message recording", { failFirstAttempts: 3 });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /start voice recording/i }).click();
    await page.getByRole("button", { name: /stop voice recording/i }).click();

    await expect(page.getByText(/Failed to transcribe audio after 3 attempts/i)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: /retry failed voice recording/i })).toBeVisible();
    await page.getByRole("button", { name: /retry failed voice recording/i }).click();

    await expect(page.getByPlaceholder("Message... Voice ⌘ + .")).toHaveValue(
      "Recovered message recording",
    );
  });

  test("message microphone permission failure renders inline guidance", async ({ page }) => {
    const session = makeWorkingSession({ id: "scenario-message-voice-permission" });
    await installBlockedMicrophoneMock(page);
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /start voice recording/i }).click();

    await expect(
      page.getByText(/Microphone access is blocked\. Allow microphone permission/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /stop voice recording/i })).toHaveCount(0);
  });

  test("message Cmd+. toggles voice recording and inserts transcript", async ({ page }) => {
    const session = makeWorkingSession({ id: "scenario-message-voice-hotkey" });
    await installVoiceMediaMocks(page);
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Message hotkey transcript");

    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByPlaceholder("Message... Voice ⌘ + .")).toBeVisible();
    const textarea = page.locator("textarea").first();
    await textarea.focus();
    await textarea.press("Meta+.");
    await expect(page.getByRole("button", { name: /stop voice recording/i })).toBeVisible();
    await textarea.press("Meta+.");

    await expect(textarea).toHaveValue("Message hotkey transcript");
  });
});

test.describe("scenario migration E2E: terminal voice", () => {
  test("terminal voice send submits transcript directly over websocket", async ({ page }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-voice-send" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Send terminal voice");

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /stop and send voice/i }).click();

    await expect
      .poll(() => terminalSentData(page))
      .toEqual(["\u001b[200~Send terminal voice\u001b[201~", "\r"]);
    await expect(page.getByRole("dialog", { name: /confirm voice input/i })).toHaveCount(0);
  });

  test("terminal voice cancel discards recording without transcription or popup", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-voice-cancel" });
    let transcribeCalls = 0;
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "unused", { onRequest: () => (transcribeCalls += 1) });

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /cancel voice recording/i }).click();

    await expect(terminal.getByRole("button", { name: /start voice recording/i })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /confirm voice input/i })).toHaveCount(0);
    expect(transcribeCalls).toBe(0);
  });

  test("terminal voice queue transcribes and posts queued message without confirmation", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-voice-queue" });
    let sendPayload: unknown = null;
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Queue from terminal voice");
    await page.route(`**/api/sessions/${session.id}/send`, async (route) => {
      sendPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /send voice to queue/i }).click();

    await expect
      .poll(() => sendPayload)
      .toEqual({
        message: "Queue from terminal voice",
        queue: true,
      });
    await expect(page.getByRole("dialog", { name: /confirm voice input/i })).toHaveCount(0);
  });

  test("terminal failed send recording survives reload and retries original send path", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-voice-retry" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Recovered terminal send", { failFirstAttempts: 3 });

    let terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /stop and send voice/i }).click();
    await expect(page.getByText(/Failed to transcribe audio after 3 attempts/i)).toBeVisible();

    await page.reload();
    terminal = page.getByRole("dialog", { name: /terminal/i });
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );
    await expect(
      terminal.getByRole("button", { name: /retry failed voice recording/i }),
    ).toBeVisible();
    await terminal.getByRole("button", { name: /retry failed voice recording/i }).click();

    await expect
      .poll(() => terminalSentData(page))
      .toEqual(["\u001b[200~Recovered terminal send\u001b[201~", "\r"]);
  });

  test("terminal voice edit opens confirmation modal with transcript", async ({ page }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-voice-edit" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Edit terminal transcript");

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /edit voice transcript/i }).click();

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    await expect(modal.getByRole("textbox")).toHaveValue("Edit terminal transcript");
    await expect(modal.getByRole("button", { name: /add to queue/i })).toBeVisible();
    await expect(modal.getByRole("button", { name: /insert/i })).toBeVisible();
  });

  test("terminal confirmation history restores a saved draft", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "spur:input-history:terminal-draft",
        JSON.stringify([
          {
            value: "Saved terminal draft",
            savedAt: "2026-04-17T09:45:00.000Z",
          },
        ]),
      );
    });
    const session = makeWorkingSession({ id: "scenario-terminal-history" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Initial terminal transcript");

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /edit voice transcript/i }).click();

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    await modal.getByRole("button", { name: /^history$/i }).click();
    await expect(page.getByText("2026-04-17 09:45 UTC")).toBeVisible();
    await page.getByRole("button", { name: /saved terminal draft/i }).click();
    await expect(modal.getByRole("textbox")).toHaveValue("Saved terminal draft");
  });

  test("terminal confirmation clear button resets draft and keeps modal open", async ({ page }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-clear" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Clear this draft");

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /edit voice transcript/i }).click();

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    const textbox = modal.getByRole("textbox");
    await expect(textbox).toHaveValue("Clear this draft");
    await modal.getByRole("button", { name: /clear voice draft/i }).click();

    await expect(textbox).toHaveValue("");
    await expect(modal).toBeVisible();
  });

  test("terminal confirmation insert sends bracketed paste and Enter over websocket", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-insert" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Insert terminal transcript");

    const terminal = await openTerminal(page, session);
    await terminal.getByRole("button", { name: /start voice recording/i }).click();
    await terminal.getByRole("button", { name: /edit voice transcript/i }).click();

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    await modal.getByRole("button", { name: /insert/i }).click();

    await expect
      .poll(() => terminalSentData(page))
      .toEqual(["\u001b[200~Insert terminal transcript\u001b[201~", "\r"]);
    await expect(modal).toHaveCount(0);
  });

  test("terminal popup Cmd+. appends a second transcript to the draft", async ({ page }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-popup-hotkey" });
    await installVoiceMediaMocks(page);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Appended terminal voice");

    const terminal = await openTerminal(page, session);
    await terminal.getByTestId("direct-terminal-surface").evaluate((surface) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["PNG"], "terminal-image.png", { type: "image/png" }));
      surface.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });

    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    const textbox = modal.getByRole("textbox");
    await textbox.fill("Existing draft");
    await textbox.press("Meta+.");
    await expect(modal.getByRole("button", { name: /stop voice recording/i })).toBeVisible();
    await textbox.press("Meta+.");

    await expect(textbox).toHaveValue("Existing draft Appended terminal voice");
    await expect(modal.getByRole("img", { name: "terminal-image.png" })).toBeVisible();
  });
});

test.describe("scenario migration E2E: terminal touch scroll", () => {
  test("OpenCode terminal touch scroll sends position-aware SGR input", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    try {
      const session = makeWorkingSession({
        id: "scenario-terminal-touch-scroll",
        agent: "opencode",
        model: "openai/gpt-5",
      });
      const terminal = await openTerminal(page, session);
      const touchTarget = terminal.locator(".xterm-screen");
      const bounds = await touchTarget.boundingBox();
      if (!bounds) throw new Error("Terminal touch target bounds unavailable");
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;

      await dispatchTouchSwipe(page, { x, y: y - 40 }, { x, y });
      await dispatchTouchSwipe(page, { x, y }, { x, y: y - 40 });

      await expect
        .poll(async () => {
          const events = (await terminalSentData(page))
            .map((payload) =>
              payload.startsWith("\x1b[<") ? /^(64|65);(\d+);(\d+)M$/.exec(payload.slice(3)) : null,
            )
            .filter((match): match is RegExpExecArray => match !== null);
          return (
            events.some((match) => match[1] === "64") &&
            events.some((match) => match[1] === "65") &&
            events.every((match) => Number(match[2]) > 1 && Number(match[3]) > 1)
          );
        })
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});

test.describe("scenario migration E2E: terminal links", () => {
  test("discovers recent links and keeps the disclosure accessible at desktop and mobile", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "scenario-terminal-links", project: "my-project" });
    const terminal = await openTerminal(page, session);
    const trigger = terminal.getByRole("button", { name: "Open terminal links" });

    await expect(trigger).toHaveCount(0);
    await captureTerminalLinksState(page, "empty");

    await emitTerminalOutput(page, "First https://one.example/path");
    await expect(trigger).toHaveText("1");
    await captureTerminalLinksState(page, "one");

    const longUrl =
      "https://long.example/projects/terminal-links/builds/2026-08-13/results?source=terminal&mode=responsive#latest-artifact";
    await emitTerminalOutput(page, `\r\nLatest ${longUrl}`);
    await expect(trigger).toHaveText("2");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const idleTriggerStyle = await trigger.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
    });
    await captureTerminalLinksState(page, "idle");

    await trigger.hover();
    await expect
      .poll(async () => trigger.evaluate((element) => getComputedStyle(element).borderColor))
      .not.toBe(idleTriggerStyle.borderColor);
    await captureTerminalLinksState(page, "hover");
    await page.mouse.move(0, 0);
    await expect
      .poll(async () => trigger.evaluate((element) => getComputedStyle(element).borderColor))
      .toBe(idleTriggerStyle.borderColor);
    await trigger.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(trigger).toBeFocused();
    await expect
      .poll(async () =>
        trigger.evaluate((element, idleStyle) => {
          const style = getComputedStyle(element);
          return style.borderColor !== idleStyle.borderColor && style.color !== idleStyle.color;
        }, idleTriggerStyle),
      )
      .toBe(true);
    await captureTerminalLinksState(page, "focus");

    await page.keyboard.press("Enter");
    const panel = page.getByRole("region", { name: "Terminal links" });
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(async () =>
        trigger.evaluate((element, idleStyle) => {
          const style = getComputedStyle(element);
          return (
            style.backgroundColor !== idleStyle.backgroundColor &&
            style.borderColor !== idleStyle.borderColor
          );
        }, idleTriggerStyle),
      )
      .toBe(true);
    await expect(panel.getByRole("link")).toHaveCount(2);
    await expect(panel.getByRole("link").nth(0)).toContainText("long.example");
    await expect(panel.getByRole("link").nth(0)).toContainText(longUrl);
    await expect(panel.getByRole("link").nth(1)).toContainText("one.example");
    const newest = panel.getByRole("link").nth(0);
    await expect(newest).toHaveAttribute("href", longUrl);
    await expect(newest).toHaveAttribute("target", "_blank");
    await expect(newest).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByRole("menu", { name: "Terminal links" })).toHaveCount(0);
    await expect
      .poll(async () =>
        newest
          .locator("span")
          .nth(1)
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      )
      .toBe(true);
    await expectTerminalLinksWithinViewport(page, terminal, trigger, panel);
    await captureTerminalLinksState(page, "long-url");
    const idleLinkStyle = await newest.evaluate((element) => {
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, outlineStyle: style.outlineStyle };
    });
    await page.keyboard.press("Tab");
    await expect(newest).toBeFocused();
    await expect
      .poll(async () =>
        newest.evaluate((element, idleStyle) => {
          const style = getComputedStyle(element);
          return (
            style.backgroundColor !== idleStyle.backgroundColor &&
            style.outlineStyle !== idleStyle.outlineStyle
          );
        }, idleLinkStyle),
      )
      .toBe(true);
    await captureTerminalLinksState(page, "desktop-open");

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await terminal.getByTestId("direct-terminal-header").click();
    await expect(panel).toHaveCount(0);

    await trigger.click();
    const popupPromise = page.waitForEvent("popup");
    await panel.getByRole("link").nth(0).click();
    const popup = await popupPromise;
    await expect(panel).toHaveCount(0);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();

    await page.setViewportSize({ width: 320, height: 844 });
    await trigger.click();
    await expect(panel).toBeVisible();
    await expectTerminalLinksWithinViewport(page, terminal, trigger, panel);
    await captureTerminalLinksState(page, "mobile-open");
  });
});
