import type { Page } from "playwright/test";

export async function installMockVoiceRecorder(
  page: Page,
  options?: { delayedFinalChunk?: boolean },
) {
  const delayedFinalChunk = options?.delayedFinalChunk ?? false;
  await page.addInitScript(({ delayedFinalChunk }) => {
    class MockMediaRecorder {
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
        if (delayedFinalChunk && this.requestedFlush) {
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
      value: MockMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    });
  }, { delayedFinalChunk });
}

export function mockVoiceStatus(page: Page) {
  return page.route("**/api/runtime/voice", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
    });
  });
}

export function mockVoiceTranscribe(page: Page, text: string, onRequest?: () => void) {
  return page.route("**/api/runtime/voice/transcribe", async (route) => {
    onRequest?.();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });
}

export function mockVoiceTranscribeSequence(
  page: Page,
  texts: string[],
  onRequest?: (index: number, text: string) => void,
) {
  let requestCount = 0;
  return page.route("**/api/runtime/voice/transcribe", async (route) => {
    const index = Math.min(requestCount, Math.max(0, texts.length - 1));
    const text = texts[index] ?? "";
    requestCount += 1;
    onRequest?.(index, text);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });
}
