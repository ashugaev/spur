import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession, mockSessions } from "./fixtures.js";

async function mockRecoveringTerminal(page: Page) {
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
        terminalState.sockets.push(this);
        queueMicrotask(() => {
          if (!terminalState.alive) {
            this.fail();
            return;
          }
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send() {}

      close() {
        this.readyState = MockWebSocket.CLOSED;
      }

      fail() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code: 1006, reason: "Backend unavailable" } as CloseEvent);
      }

      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
    }

    const terminalState = {
      alive: true,
      sockets: [] as MockWebSocket[],
    };
    Object.defineProperty(window, "__recoveryTerminal", {
      configurable: true,
      value: {
        socketCount: () => terminalState.sockets.length,
        setAlive: (alive: boolean) => {
          terminalState.alive = alive;
          if (!alive) terminalState.sockets.at(-1)?.fail();
        },
      },
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });
  });
}

async function setTerminalAlive(page: Page, alive: boolean) {
  await page.evaluate((nextAlive) => {
    (
      window as unknown as {
        __recoveryTerminal: { setAlive(value: boolean): void };
      }
    ).__recoveryTerminal.setAlive(nextAlive);
  }, alive);
}

async function terminalSocketCount(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __recoveryTerminal: { socketCount(): number };
        }
      ).__recoveryTerminal.socketCount(),
  );
}

interface RuntimeState {
  alive: boolean;
  version: string;
  // Count of healthy (200) probes served, so a test can wait for the gate
  // to capture its version baseline before inducing an outage.
  healthyServed: number;
}

// Real daemon restart/update ~ a version change; a transient blip on the
// same daemon reports the same version back once recovered.
async function routeRuntimeInfo(page: Page, getState: () => RuntimeState) {
  await page.route("/api/runtime/info", (route) => {
    const state = getState();
    if (!state.alive) {
      void route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Bad gateway" }),
      });
      return;
    }
    state.healthyServed += 1;
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: state.version }),
    });
  });
}

test.describe("D6e: Backend-connection gate", () => {
  test.describe.configure({ timeout: 90_000 });
  test("recovers transport and server data without reloading or losing mobile UI state", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockRecoveringTerminal(page);
    let sessions = [
      makeWorkingSession({ id: "recovery-session", prompt: "Recovery state initial" }),
    ];
    await mockSessions(page, () => sessions);

    const state: RuntimeState = { alive: true, version: "1.4.2", healthyServed: 0 };
    await routeRuntimeInfo(page, () => state);

    await page.goto("/");
    const filter = page.getByRole("textbox", { name: "Filter sessions" });
    await filter.fill("Recovery state");
    await page
      .getByRole("button", { name: "Open web terminal for recovery-session" })
      .click();
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
    );
    await expect(filter).toHaveValue("Recovery state");
    await expect(page.getByTestId("backend-connection-overlay")).toHaveCount(0);
    await expect(page.locator("[inert]")).toHaveCount(0);
    await expect.poll(() => state.healthyServed, { timeout: 10_000 }).toBeGreaterThan(0);

    state.alive = false;
    await setTerminalAlive(page, false);
    await expect(page.getByTestId("backend-connection-overlay")).toBeVisible({ timeout: 35_000 });
    await expect(page.getByText("Reconnecting to Spur…")).toBeVisible();
    await expect(filter).toHaveValue("Recovery state");

    // The background app tree is marked inert while the overlay blocks it.
    await expect(page.locator("[inert]")).toHaveCount(1);

    let reloaded = false;
    await page.exposeFunction("__markReloaded", () => {
      reloaded = true;
    });
    await page.evaluate(() => {
      window.addEventListener("beforeunload", () => {
        (window as unknown as { __markReloaded: () => void }).__markReloaded();
      });
    });

    sessions = [
      makeWorkingSession({ id: "recovery-session", prompt: "Recovery state refreshed" }),
    ];
    await setTerminalAlive(page, true);
    state.alive = true;
    state.version = "1.5.0";
    await expect(page.getByTestId("backend-connection-overlay")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator("[inert]")).toHaveCount(0);
    await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "data-ws-status",
      "connected",
      { timeout: 10_000 },
    );
    await expect.poll(() => terminalSocketCount(page), { timeout: 10_000 }).toBeGreaterThan(1);
    expect(reloaded).toBe(false);
    await page.getByRole("button", { name: "Close terminal" }).click();
    await expect(filter).toHaveValue("Recovery state");
    await expect(page.getByRole("link", { name: "Recovery state refreshed" })).toBeVisible({
      timeout: 6_000,
    });
    expect(reloaded).toBe(false);
  });
});
