import {
  test,
  expect,
  type Page,
  makeWorkingSession,
  makeSessionWithSidecar,
  mockTagCatalog,
} from "./fixtures.js";

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  return Promise.all([
    mockTagCatalog(page),
    page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    }),
  ]);
}

async function gotoSessionDetail(page: Page, sessionId: string) {
  await page.goto(`/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sidecars").first()).toBeVisible();
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

  test("#822: dead-pane sidecar keeps the terminal button and shows start", async ({ page }) => {
    const session = makeSessionWithSidecar("dev", false, {
      id: "sc-dead-pane-1",
      runtimeAlive: true,
      tmuxSession: "spur-sc-dead-pane-1",
      sidecars: [{ name: "dev", alive: false, deadPane: true }],
    });
    let startRequested = false;
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/sidecars/dev/start`, (route) => {
      startRequested = true;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSessionWithSidecar("dev", true, { id: session.id })),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    // Dead-pane status dot renders the same not-alive (grey) style as any
    // dead sidecar, not the alive fill — discriminates the row from an
    // alive one, since `deadPane` never accompanies `alive: true`.
    await expect(sidecarSection.getByTestId("sidecar-status-dev")).toHaveClass(
      /color-text-tertiary/,
    );
    await expect(sidecarSection.getByTestId("sidecar-status-dev")).not.toHaveClass(
      /color-chip-alive/,
    );
    await expect(sidecarSection.getByRole("button", { name: /terminal/i })).toBeVisible();
    await expect(sidecarSection.getByRole("link", { name: /open/i })).toHaveCount(0);

    const startButton = sidecarSection.getByRole("button", { name: "Start sidecar dev" });
    await expect(startButton).toBeVisible();
    await startButton.click();

    await expect(sidecarSection.getByRole("button", { name: "Stop sidecar dev" })).toBeVisible();
    expect(startRequested).toBe(true);
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

  test("ready URL shows Open without tmux and retains ordinary slot links", async ({ page }) => {
    const session = makeWorkingSession({
      id: "sc-open-1",
      sidecars: [{ name: "isolated-ui", alive: false, url: "https://ready.example.com/" }],
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
    await expect(openLink).toHaveAttribute("href", "https://ready.example.com/");
    await expect(sidecarSection.getByRole("button", { name: /terminal/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "isolated-ui", exact: true })).toHaveAttribute(
      "href",
      "http://example.com:5601",
    );
  });

  test("stale slot URL cannot create sidecar Open", async ({ page }) => {
    const session = makeWorkingSession({
      id: "sc-stale-slot",
      sidecars: [{ name: "dev", alive: true }],
      slots: { links: [{ label: "dev", url: "https://stale.example.com/" }] },
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);
    const section = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(section).toBeVisible();
    await expect(section.getByRole("link", { name: "Open" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "dev", exact: true })).toHaveAttribute(
      "href",
      "https://stale.example.com/",
    );
  });

  test("ready URL refresh adds Open and stop removes Open while preserving unmatched slot target", async ({
    page,
  }) => {
    let ready = false;
    let stopped = false;
    const session = makeWorkingSession({
      id: "sc-ready-refresh",
      sidecars: [{ name: "dev", alive: true }],
      slots: { links: [{ label: "dev", url: "https://legacy.example.com/" }] },
    });
    await mockTagCatalog(page);
    const current = () => ({
      ...session,
      sidecars: [
        {
          ...session.sidecars?.[0],
          name: "dev",
          alive: !stopped,
          ...(ready && !stopped ? { url: "https://ready.example.com/" } : {}),
        },
      ],
    });
    await page.route(`**/api/sessions/${session.id}`, (route) =>
      route.fulfill({ json: current() }),
    );
    await page.route(`**/api/sessions/${session.id}/sidecars/dev/stop`, (route) => {
      stopped = true;
      return route.fulfill({ json: current() });
    });
    await page.goto(`/sessions/${session.id}`);
    const section = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(section).toBeVisible();
    await expect(section.getByRole("link", { name: "Open" })).toHaveCount(0);
    ready = true;
    await expect(section.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "https://ready.example.com/",
      { timeout: 15000 },
    );
    await section.getByRole("button", { name: "Stop sidecar dev" }).click();
    await expect(section.getByRole("link", { name: "Open" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "dev", exact: true })).toHaveAttribute(
      "href",
      "https://legacy.example.com/",
    );
  });

  test("starting one sidecar keeps other sidecar start buttons enabled", async ({ page }) => {
    const session = makeWorkingSession({
      id: "sc-per-sidecar-disable-1",
      sidecars: [
        { name: "dev", alive: false },
        { name: "preview", alive: false },
      ],
    });
    await mockSessionDetail(page, session);
    await page.route(`**/api/sessions/${session.id}/sidecars/dev/start`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          makeWorkingSession({
            id: session.id,
            sidecars: [
              { name: "dev", alive: true },
              { name: "preview", alive: false },
            ],
          }),
        ),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    const devStart = sidecarSection.getByRole("button", { name: "Start sidecar dev" });
    const previewStart = sidecarSection.getByRole("button", { name: "Start sidecar preview" });

    await devStart.click();
    await expect(devStart).toBeDisabled();
    await expect(previewStart).toBeEnabled();
    await expect(sidecarSection.getByRole("button", { name: "Stop sidecar dev" })).toBeVisible();
    await expect(previewStart).toBeEnabled();
  });

  test("start or stop sidecar action stays rightmost in the sidecar action cluster", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "sc-order-1",
      sidecars: [{ name: "isolated-ui", alive: true, url: "http://example.com:5601" }],
    });
    await mockSessionDetail(page, session);
    await gotoSessionDetail(page, session.id);

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
