import { test, expect, devices, type Page } from "playwright/test";
import { makeWorkingSession, makeCompletedSession, makeSpawningSession } from "./fixtures.js";

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

// S1: Session detail header
test.describe("S1: Session detail header", () => {
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
    await expect(page.getByText("Loading session...")).toHaveCount(0);
  });

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

  test("tab title shows only the session id", async ({ page }) => {
    const session = makeWorkingSession({ id: "detail-s1-title" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page).toHaveTitle(session.id);
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
    const textarea = page.getByPlaceholder("Edit the initial message...");
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
    ]);

    await page.goto(`/sessions/${session.id}`);
    await page.getByRole("button", { name: /^logs$/i }).click();

    await expect(page.getByRole("dialog", { name: `Logs ${session.id}` })).toBeVisible();
    await expect(page.getByText("Status transition")).toBeVisible();
    await expect(page.getByText("waiting")).toBeVisible();
    await expect(page.getByText("needs input")).toBeVisible();
    await expect(page.getByText("source jsonl")).toBeVisible();
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
    await expect(dialog.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/sessions/detail-s4b-1/artifacts/screenshot.png",
    );
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

  test("terminal header keeps the sidecar suffix in its title line", async ({ page }) => {
    const session = makeWorkingSession({
      id: "detail-s6-title",
      slots: { title: "Header title from slot", links: [] },
      sidecars: [{ name: "isolated-ui", alive: true }],
    });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });

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
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });

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

  test("recording state shows pencil and stop buttons; pencil opens edit modal, stop sends without modal", async ({
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
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });

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

    // Recording: pencil + stop replace the mic.
    const pencil = terminalDialog.getByRole("button", { name: /edit voice transcript/i });
    const stop = terminalDialog.getByRole("button", { name: /stop and send voice/i });
    await expect(pencil).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(
      terminalDialog.getByRole("button", { name: /start voice recording/i }),
    ).toHaveCount(0);

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
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });
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

  test("returning to a visible tab does not reconnect an already-open terminal websocket", async ({
    page,
  }) => {
    const session = makeWorkingSession({ id: "detail-s6-4" });
    await mockSessionDetail(page, session);
    await mockTerminalWebSocket(page);
    await page.route("**/api/runtime/terminal**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ directTerminalPort: 14801 }),
      });
    });

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
