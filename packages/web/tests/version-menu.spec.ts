import { test, expect, type Page } from "playwright/test";
import { mockSessions, type ProjectInfo } from "./fixtures.js";

const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

interface VersionsFixture {
  current: string;
  autoUpdate: boolean;
  available: Array<{ tag: string; publishedAt: string }>;
}

async function mockVersionMenu(
  page: Page,
  versions: VersionsFixture,
  options?: {
    onAutoUpdate?: (body: unknown) => void;
    autoUpdateResponse?: { status: number; body: unknown };
  },
): Promise<void> {
  await page.route("**/api/runtime/info", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: versions.current }),
    });
  });
  await page.route("**/api/runtime/versions", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(versions),
    });
  });
  await page.route("**/api/runtime/versions/switch", (route) => {
    void route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, version: versions.available[0]?.tag ?? "" }),
    });
  });
  await page.route("**/api/runtime/auto-update", (route) => {
    const body: unknown = route.request().postDataJSON();
    options?.onAutoUpdate?.(body);
    const response = options?.autoUpdateResponse ?? { status: 200, body: { autoUpdate: true } };
    void route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
}

test.describe("Version menu Auto checkbox", () => {
  test("header keeps name+version and Auto on one row at 320px, no wrap", async ({ page }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: false,
      available: [{ tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" }],
    });
    await page.setViewportSize({ width: 320, height: 800 });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();

    const nameGroup = page.getByText("Spur", { exact: true }).locator("..");
    const autoLabel = page.getByRole("checkbox", { name: "Auto update" }).locator("..");
    const [nameBox, autoBox] = await Promise.all([
      nameGroup.boundingBox(),
      autoLabel.boundingBox(),
    ]);

    expect(nameBox).not.toBeNull();
    expect(autoBox).not.toBeNull();
    if (!nameBox || !autoBox) throw new Error("unreachable");
    expect(Math.abs(nameBox.y - autoBox.y)).toBeLessThanOrEqual(1);
  });

  test("off state: dimmed label, unchecked box", async ({ page }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: false,
      available: [{ tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" }],
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();

    const checkbox = page.getByRole("checkbox", { name: "Auto update" });
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByText("Auto", { exact: true })).toHaveCSS("color", "rgb(85, 85, 88)");
  });

  test("on state: bold primary label, checked box", async ({ page }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: true,
      available: [{ tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" }],
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();

    const checkbox = page.getByRole("checkbox", { name: "Auto update" });
    await expect(checkbox).toBeChecked();
    const label = page.getByText("Auto", { exact: true });
    await expect(label).toHaveCSS("color", "rgb(225, 225, 225)");
    await expect(label).toHaveCSS("font-weight", "700");
  });

  test("Auto label carries a non-empty tooltip", async ({ page }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: false,
      available: [{ tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" }],
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();

    const label = page.getByRole("checkbox", { name: "Auto update" }).locator("..");
    const title = await label.getAttribute("title");
    expect(title).toBeTruthy();
  });

  test("toggling posts enabled to the daemon and the box ends checked", async ({ page }) => {
    const autoUpdateCalls: unknown[] = [];
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(
      page,
      {
        current: "1.4.2",
        autoUpdate: false,
        available: [{ tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" }],
      },
      {
        onAutoUpdate: (body) => autoUpdateCalls.push(body),
        autoUpdateResponse: { status: 200, body: { autoUpdate: true } },
      },
    );

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();

    const checkbox = page.getByRole("checkbox", { name: "Auto update" });
    await checkbox.click();

    await expect(checkbox).toBeChecked();
    expect(autoUpdateCalls).toEqual([{ enabled: true }]);
  });

  test("version list markup is unchanged: Switch button still renders per non-current row", async ({
    page,
  }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: false,
      available: [
        { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
        { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
      ],
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();

    await expect(page.getByRole("button", { name: "Switch Spur to 1.5.0" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch Spur to 1.4.2" })).toHaveCount(0);
  });

  test("confirm dialog states the auto-update disarm only when Auto is on", async ({ page }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: true,
      available: [
        { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
        { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
      ],
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();
    await page.getByRole("button", { name: "Switch Spur to 1.5.0" }).click();

    const dialog = page.getByRole("dialog", { name: "Switch Spur version" });
    await expect(dialog).toContainText("Auto update will be turned off.");
  });

  test("confirm dialog omits the auto-update sentence when Auto is off", async ({ page }) => {
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await mockVersionMenu(page, {
      current: "1.4.2",
      autoUpdate: false,
      available: [
        { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
        { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
      ],
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();
    await page.getByRole("button", { name: "Switch Spur to 1.5.0" }).click();

    const dialog = page.getByRole("dialog", { name: "Switch Spur version" });
    await expect(dialog).not.toContainText("Auto update will be turned off.");
  });

  test("after a confirmed switch disarms auto-update, the reloaded page reopens with the box unchecked", async ({
    page,
  }) => {
    let liveVersion = "1.4.2";
    let autoUpdateFlag = true;
    await mockSessions(page, [], DEFAULT_PROJECTS);
    await page.route("**/api/runtime/info", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: liveVersion }),
      });
    });
    await page.route("**/api/runtime/versions", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          current: liveVersion,
          autoUpdate: autoUpdateFlag,
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        }),
      });
    });
    await page.route("**/api/runtime/versions/switch", (route) => {
      liveVersion = "1.5.0";
      autoUpdateFlag = false;
      void route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true, version: "1.5.0", autoUpdate: false }),
      });
    });

    await page.clock.install();
    await page.goto("/");
    await page.getByRole("button", { name: /Show Spur version information/ }).click();
    await page.getByRole("button", { name: "Switch Spur to 1.5.0" }).click();
    const dialog = page.getByRole("dialog", { name: "Switch Spur version" });
    await expect(dialog).toContainText("Auto update will be turned off.");
    await dialog.getByRole("button", { name: "Switch", exact: true }).click();

    // Confirmation poll runs every 3s; the daemon reports the new version on
    // the very next poll, which reloads the page.
    await page.clock.fastForward(3_100);
    await expect(
      page.getByRole("button", { name: /Show Spur version information/ }),
    ).toContainText("1.5.0");

    await page.getByRole("button", { name: /Show Spur version information/ }).click();
    const checkbox = page.getByRole("checkbox", { name: "Auto update" });
    await expect(checkbox).not.toBeChecked();
  });
});
