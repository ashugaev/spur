import { test, expect } from "playwright/test";
import { makeWorkingSession, mockSessions, gotoMocked } from "./fixtures.js";

// R1: Mobile (<640px)
test.describe("R1: Mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header visible at mobile width", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "mob-1" })]);
    await page.goto("/");
    await expect(page.getByText("𖤓")).toBeVisible();
  });

  test("Spawn Session button visible on mobile", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
  });

  test("no horizontal scroll on mobile", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "mob-scroll-1" })]);
    await page.goto("/");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

// R2: Tablet
test.describe("R2: Tablet viewport (768px)", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("agent column visible at md breakpoint", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "tablet-1", agent: "claude" })]);
    await page.goto("/");

    // agent column has class md:inline, so at 768px it should be visible
    // The text "claude" appears in the session row agent column
    const row = page.locator(".data-row").first();
    await expect(row).toBeVisible();
    await expect(page.getByText("claude").first()).toBeVisible();
  });
});

// R3: Desktop
test.describe("R3: Desktop viewport (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("full layout renders at desktop", async ({ page }) => {
    await gotoMocked(page, "/", [makeWorkingSession({ id: "desktop-1" })]);

    await expect(page.locator("header span").filter({ hasText: "𖤓" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "All Projects" })).toBeVisible();
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
  });

  test("session row renders with project column at sm", async ({ page }) => {
    await gotoMocked(
      page, "/",
      [makeWorkingSession({ id: "desktop-row-1", project: "desktop-project" })],
      [{ id: "desktop-project", name: "desktop-project" }],
    );

    await expect(page.locator(".data-row span").filter({ hasText: "desktop-project" })).toBeVisible();
  });
});
