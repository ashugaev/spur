import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession, makeSessionWithSidecar } from "./fixtures.js";

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  return page.route(`**/api/sessions/${session.id}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

// SC1: Sidecar terminal buttons
test.describe("SC1: Sidecar terminal buttons", () => {
  test("sidecars section visible when session has sidecars", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", true, { id: "sc-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    await expect(page.getByText("Sidecars").first()).toBeVisible();
  });

  test("alive sidecar shows name without text status", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", true, { id: "sc-alive-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection).toBeVisible();
    await expect(sidecarSection.getByText("dev")).toBeVisible();
    await expect
      .poll(async () =>
        sidecarSection.getByTestId("sidecar-status-dev").evaluate((marker) => {
          const { width } = marker.getBoundingClientRect();
          return Number.parseFloat(getComputedStyle(marker).borderRadius) >= width / 2;
        }),
      )
      .toBe(true);
    await expect(sidecarSection.locator("span").filter({ hasText: /^alive$/ })).toHaveCount(0);
    await expect(sidecarSection.locator("span").filter({ hasText: /^offline$/ })).toHaveCount(0);
  });

  test("alive sidecar terminal button visible and enabled", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", true, {
      id: "sc-term-alive-1",
      runtimeAlive: true,
      tmuxSession: "spur-sc-term-alive-1",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // Sidecar terminal button - it's a small "Terminal" button in the sidecar row
    // There are multiple terminal buttons; the sidecar one is in the sidecar section
    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection).toBeVisible();
    const sidecarTermBtn = sidecarSection.getByRole("button", { name: /terminal/i });
    await expect(sidecarTermBtn).toBeVisible();
    await expect(sidecarTermBtn).not.toBeDisabled();
  });

  test("offline sidecar shows play button", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", false, { id: "sc-start-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection.getByRole("button", { name: "Start sidecar dev" })).toBeVisible();
  });

  test("alive sidecar shows stop button", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", true, { id: "sc-stop-1" });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection.getByRole("button", { name: "Stop sidecar dev" })).toBeVisible();
  });

  test("clicking play updates the sidecar row to alive without leaving the page", async ({
    page,
  }) => {
    const session = makeSessionWithSidecar("dev", false, { id: "sc-start-click-1" });
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/sidecars/dev/start`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSessionWithSidecar("dev", true, { id: session.id })),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const startButton = page.getByRole("button", { name: "Start sidecar dev" });
    await startButton.click();

    await expect(page.getByRole("button", { name: "Stop sidecar dev" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}$`));
  });

  test("busy sidecar port can be selected and cleared", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", false, {
      id: "sc-port-conflict-1",
      sidecars: [
        {
          name: "dev",
          alive: false,
          ports: [{ id: "http", env: "SPUR_RESERVED_PORT_DEV", port: 3000 }],
        },
      ],
    });
    let clearBody: unknown;
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/sidecars/dev/start`, async (route) => {
      const postData = route.request().postData();
      if (postData) {
        try {
          clearBody = JSON.parse(postData) as unknown;
        } catch {
          clearBody = null;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeSessionWithSidecar("dev", true, { id: session.id })),
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "sidecar_port_busy",
          sidecarName: "dev",
          candidates: [
            {
              portId: "http",
              env: "SPUR_RESERVED_PORT_DEV",
              port: 3000,
            },
          ],
        }),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection.getByText(":3000")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Port busy" })).toHaveCount(0);
    await sidecarSection.getByRole("button", { name: "Start sidecar dev" }).click();
    const dialog = page.getByRole("dialog", { name: "Port busy" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Busy port for sidecar dev" })).toHaveValue(
      "3000",
    );
    await dialog.getByRole("button", { name: "Clear/Retry" }).click();

    await expect(sidecarSection.getByRole("button", { name: "Stop sidecar dev" })).toBeVisible();
    expect(clearBody).toEqual({ clearPort: 3000 });
  });

  test("clicking stop updates the sidecar row to offline without leaving the page", async ({
    page,
  }) => {
    const session = makeSessionWithSidecar("dev", true, { id: "sc-stop-click-1" });
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/sidecars/dev/stop`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSessionWithSidecar("dev", false, { id: session.id })),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const stopButton = page.getByRole("button", { name: "Stop sidecar dev" });
    await stopButton.click();

    await expect(page.getByRole("button", { name: "Start sidecar dev" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}$`));
  });

  test("dead sidecar shows no terminal button", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", false, {
      id: "sc-dead-1",
      runtimeAlive: true,
      tmuxSession: "spur-sc-dead-1",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // Dead sidecar should have no terminal button (sc.alive && canAttach condition)
    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection.locator("span").filter({ hasText: /^offline$/ })).toHaveCount(0);
    const sidecarTermBtn = sidecarSection.getByRole("button", { name: /terminal/i });
    await expect(sidecarTermBtn).toHaveCount(0);
  });

  test("no sidecars section when sidecars array is empty", async ({ page }) => {
    const session = makeWorkingSession({ id: "sc-empty-1", sidecars: [] });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    // Should not show a sidecars section
    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection).toHaveCount(0);
  });

  test("clicking alive sidecar terminal button opens terminal with sidecar id", async ({
    page,
  }) => {
    const session = makeSessionWithSidecar("my-sidecar", true, {
      id: "sc-click-1",
      runtimeAlive: true,
      tmuxSession: "spur-sc-click-1",
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    const sidecarTermBtn = sidecarSection.getByRole("button", { name: /terminal/i });
    await expect(sidecarTermBtn).toBeVisible();
    await sidecarTermBtn.click();

    // URL should contain terminal param with sidecar suffix
    await expect(page).toHaveURL(new RegExp(`terminal=${session.id}--my-sidecar`));
  });

  test("sidecar with matching slot link label shows Open link", async ({ page }) => {
    const session = makeWorkingSession({
      id: "sc-open-1",
      sidecars: [{ name: "isolated-ui", alive: true }],
      slots: {
        title: "Session with sidecar UI",
        links: [{ label: "isolated-ui", url: "http://example.com:5601" }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection).toBeVisible();

    const openLink = sidecarSection.getByRole("link", { name: /open/i });
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute("href", "http://example.com:5601");
  });

  test("start or stop sidecar action stays rightmost in the sidecar action cluster", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "sc-order-1",
      sidecars: [{ name: "isolated-ui", alive: true }],
      slots: {
        title: "Session with ordered sidecar actions",
        links: [{ label: "isolated-ui", url: "http://example.com:5601" }],
      },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const actionNames = await page
      .locator("section")
      .filter({ hasText: "Sidecars" })
      .evaluate((section) => {
        const row = Array.from(section.querySelectorAll("div")).find(
          (node) =>
            node.textContent?.includes("isolated-ui") &&
            node.querySelector('[aria-label="Stop sidecar isolated-ui"]'),
        );
        return row
          ? Array.from(row.querySelectorAll("a,button")).map(
              (node) => node.getAttribute("aria-label") || node.textContent?.trim() || "",
            )
          : [];
      });

    expect(actionNames).toEqual(["Terminal", "Open", "Stop sidecar isolated-ui"]);
  });
});
