import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession } from "./fixtures.js";

const ARTIFACTS_DIR = process.env.SPUR_SESSION_ARTIFACTS_DIR ?? "screenshots";

mkdirSync(ARTIFACTS_DIR, { recursive: true });

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
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
      body: JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
    });
  });
}

function mockVoiceTranscribe(page: Page, text: string) {
  return page.route("**/api/runtime/voice/transcribe", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });
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
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send() {}
      close() {
        if (this.readyState >= MockWebSocket.CLOSING) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000, reason: "Closed", wasClean: true }));
      }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });
  });
}

async function installMediaMocks(page: Page) {
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

test.describe("voice controls capture", () => {
  test("captures idle, recording, and edit-modal states", async ({ page }) => {
    await installMediaMocks(page);
    await mockTerminalWebSocket(page);

    const session = makeWorkingSession({ id: "voice-capture-1" });
    await mockSessionDetail(page, session);
    await mockVoiceStatus(page);
    await mockVoiceTranscribe(page, "Sample transcribed message for the screenshot");
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^terminal$/i }).click();
    const terminalDialog = page.getByRole("dialog", { name: /terminal/i });
    await expect(terminalDialog.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );

    // Idle: single mic button.
    const micButton = terminalDialog.getByRole("button", { name: /start voice recording/i });
    await expect(micButton).toBeVisible();
    await micButton.screenshot({ path: `${ARTIFACTS_DIR}/voice-idle.png` });

    // Recording: footer mic slot becomes cancel; edit/queue/send actions stack above it.
    await micButton.click();
    const pencil = terminalDialog.getByRole("button", { name: /edit voice transcript/i });
    const queue = terminalDialog.getByRole("button", { name: /send voice to queue/i });
    const stop = terminalDialog.getByRole("button", { name: /stop and send voice/i });
    const cancel = terminalDialog.getByRole("button", { name: /cancel voice recording/i });
    await expect(pencil).toBeVisible();
    await expect(queue).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(terminalDialog.getByRole("button", { name: /stop voice recording/i })).toHaveCount(
      0,
    );
    // Tight crop around the vertical actions stack.
    const recordingActions = pencil.locator("..");
    await recordingActions.screenshot({ path: `${ARTIFACTS_DIR}/voice-recording.png` });

    // Pencil opens VoiceConfirmModal with the transcript.
    await pencil.click();
    const modal = page.getByRole("dialog", { name: /confirm voice input/i });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Attach file" })).toBeVisible();
    await expect(modal.getByRole("button", { name: /add to queue/i })).toBeVisible();
    await expect(modal.getByRole("textbox")).toHaveValue(
      /Sample transcribed message for the screenshot/,
    );
    await modal.screenshot({ path: `${ARTIFACTS_DIR}/voice-edit-modal.png` });
  });
});
