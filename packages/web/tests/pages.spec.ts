import { test, expect, mockSessions } from "./fixtures.js";

for (const width of [1280, 390]) {
  test(`project menu opens Pages and returns to Agents at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockSessions(page, [], [{ id: "films-project", name: "Films Project" }]);
    await page.route("**/api/pages", (route) =>
      route.fulfill({ json: { pages: [{ id: "films", title: "My films", url: "/p/films/" }] } }),
    );
    await context.route("**/p/films/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>My films</h1>" }),
    );
    await page.goto("/?project=films-project");
    await page.getByRole("button", { name: "Project filter: Films Project" }).click();
    const entry = page.getByRole("menuitem", { name: "Pages", exact: true });
    await expect(entry).toHaveAttribute("href", "/pages?project=films-project");
    await entry.focus();
    await entry.press("Enter");
    await expect(page).toHaveURL(/\/pages\?project=films-project$/);
    const title = page.getByRole("link", { name: "My films", exact: true });
    await expect(title).toHaveAttribute("target", "_blank");
    await expect(title).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByRole("button", { name: /Create|Open/ })).toHaveCount(0);
    const popupPromise = page.waitForEvent("popup");
    await title.click();
    const popup = await popupPromise;
    await expect(popup.getByRole("heading", { name: "My films" })).toBeVisible();
    await popup.close();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(/\/\?project=films-project$/);
    await expect(page.getByRole("button", { name: "Project filter: Films Project" })).toBeVisible();
  });
}

test("Pages request failure retries to a compact empty catalogue", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/pages", (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fulfill({ json: { pages: [] } });
  });
  await page.goto("/pages");
  await expect(page.getByRole("alert")).toContainText("Could not load pages (503).");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No pages yet.", { exact: true })).toBeVisible();
});

test("Pages keeps loading distinct from an empty list", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/pages", async (route) => {
    await pending;
    await route.fulfill({ json: { pages: [] } });
  });
  await page.goto("/pages");
  await expect(page.getByRole("status", { name: "Loading pages" })).toBeVisible();
  await expect(page.getByText("No pages yet.")).toHaveCount(0);
  release();
  await expect(page.getByText("No pages yet.")).toBeVisible();
});
