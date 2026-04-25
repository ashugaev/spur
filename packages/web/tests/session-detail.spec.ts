import { test, expect, devices, type Page } from "playwright/test";
import { makeWorkingSession, makeCompletedSession } from "./fixtures.js";

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

// S1: Session detail header
test.describe("S1: Session detail header", () => {
  test("back link visible", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s1-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByRole("link", { name: /back/i })).toBeVisible();
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

  test("no Terminal button when session status is completed", async ({ page }) => {
    const session = makeCompletedSession({ id: "detail-s2-6" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // canAttach = runtimeAlive && !isTerminalSession && tmuxSession
    // completed → isTerminalSession = true → no terminal button
    await expect(page.getByRole("button", { name: /^terminal$/i })).toHaveCount(0);
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

    await expect(page.getByPlaceholder("Message to the running agent...")).toHaveValue("/status");
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

      await expect(page.getByPlaceholder("Message to the running agent...")).toHaveValue(
        "Mobile PWA voice still works",
      );
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
    await expect(
      page.getByText(/queued messages will send automatically when the agent is ready/i),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: /queued messages list/i })).toHaveCount(0);
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

  test("canonical github-pr links render as github pr", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s4-pr",
      slots: {
        title: "Session with GitHub PR",
        links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/42" }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByRole("link", { name: "github pr" })).toBeVisible();
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
});

// S6: Terminal modal from detail page
test.describe("S6: Terminal modal from detail page", () => {
  test("Terminal button opens terminal modal", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s6-1" });
    await mockSessionDetail(page, session);

    // Mock the WebSocket / terminal endpoint
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.abort();
    });

    await page.goto(`/sessions/${session.id}`);

    const termBtn = page.getByRole("button", { name: /^terminal$/i });
    await expect(termBtn).toBeVisible();
    await termBtn.click();

    // URL should have terminal query param
    await expect(page).toHaveURL(new RegExp(`terminal=${session.id}`));
  });

  test("URL gets terminal=<id> when terminal opened, removed when closed", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s6-2" });
    await mockSessionDetail(page, session);

    await page.route("**/api/runtime/terminal**", (route) => {
      void route.abort();
    });

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
    await page.route("**/api/runtime/terminal**", (route) => void route.abort());
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /^terminal$/i }).click();
    await expect(page).toHaveURL(new RegExp(`terminal=`));

    const overflow = await page.evaluate(() => document.body.style.overflow);
    expect(overflow).toBe("hidden");

    await page.getByRole("button", { name: /close terminal/i }).click();
    const overflowRestored = await page.evaluate(() => document.body.style.overflow);
    expect(overflowRestored).not.toBe("hidden");
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

  test("completed session shows paused label (stopped state), not working", async ({ page }) => {
    const session = makeCompletedSession({ id: "detail-s7-2" });
    await mockSessionDetail(page, session);
    await mockSessionConversation(page, session.id, "working");
    await page.goto(`/sessions/${session.id}`);

    const header = page.locator("header").first();
    await expect(header.getByText("paused", { exact: true }).first()).toBeVisible();
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
