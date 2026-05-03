import { test, expect } from "playwright/test";
import { makeWorkingSession, mockSessions, gotoMocked } from "./fixtures.js";

// R1: Mobile (<640px)
test.describe("R1: Mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

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

  test("inputs and selects have font-size >= 16px to prevent auto-zoom", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    const minFontSize = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("input, select, textarea"));
      if (els.length === 0) return 16;
      return els.reduce((min, el) => {
        const size = parseFloat(window.getComputedStyle(el).fontSize);
        return size < min ? size : min;
      }, Infinity);
    });

    expect(minFontSize).toBeGreaterThanOrEqual(16);
  });

  test("attention zone collapses and expands on tap at mobile", async ({ page }) => {
    await gotoMocked(page, "/", [makeWorkingSession({ id: "acc-1", prompt: "Accordion session" })]);

    await expect(page.getByText("Accordion session")).toBeVisible();

    const zoneToggle = page
      .locator("section button")
      .filter({ hasText: /working/i })
      .first();
    await expect(zoneToggle).toBeVisible({ timeout: 5000 });
    await zoneToggle.click();
    await expect(page.getByText("Accordion session")).not.toBeVisible();

    await zoneToggle.click();
    await expect(page.getByText("Accordion session")).toBeVisible();
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

  test("header controls wrap one element at a time before compact stat labels", async ({
    page,
  }) => {
    await mockSessions(page, []);

    await page.setViewportSize({ width: 700, height: 844 });
    await page.goto("/");
    await expect(page.getByText("Completed:").first()).toBeVisible();

    const searchInput = page.getByPlaceholder("Filter sessions...");
    const projectFilter = page.getByRole("combobox", { name: "Project filter" });
    const spawnButton = page.getByRole("button", { name: /spawn session/i });

    const [projectWide, searchWide, buttonWide] = await Promise.all([
      projectFilter.boundingBox(),
      searchInput.boundingBox(),
      spawnButton.boundingBox(),
    ]);

    expect(projectWide).not.toBeNull();
    expect(searchWide).not.toBeNull();
    expect(buttonWide).not.toBeNull();
    if (!projectWide || !searchWide || !buttonWide) {
      throw new Error("Expected header controls to have bounding boxes");
    }
    expect(new Set([projectWide.y, searchWide.y, buttonWide.y]).size).toBeGreaterThan(1);
    expect(searchWide.y).toBeGreaterThan(projectWide.y + 8);

    await page.setViewportSize({ width: 430, height: 844 });
    await page.reload();

    const [projectNarrow, searchNarrow, buttonNarrow] = await Promise.all([
      projectFilter.boundingBox(),
      searchInput.boundingBox(),
      spawnButton.boundingBox(),
    ]);

    expect(projectNarrow).not.toBeNull();
    expect(searchNarrow).not.toBeNull();
    expect(buttonNarrow).not.toBeNull();
    if (!projectNarrow || !searchNarrow || !buttonNarrow) {
      throw new Error("Expected wrapped header controls to have bounding boxes");
    }
    expect(searchNarrow.y).toBeGreaterThan(projectNarrow.y + 8);
    expect(buttonNarrow.y).toBeGreaterThan(searchNarrow.y + 8);
  });

  test("stat filters wrap individually before labels collapse", async ({ page }) => {
    await mockSessions(page, []);

    await page.setViewportSize({ width: 645, height: 844 });
    await page.goto("/");
    await expect(page.getByText("Completed:").first()).toBeVisible();

    const statButtons = [
      page.getByRole("button", { name: /Needs Input/i }),
      page.getByRole("button", { name: /Working/i }),
      page.getByRole("button", { name: /Waiting/i }),
      page.getByRole("button", { name: /Stopped/i }),
      page.getByRole("button", { name: /Completed/i }),
    ];

    const boxes = await Promise.all(statButtons.map((button) => button.boundingBox()));
    for (const box of boxes) {
      expect(box).not.toBeNull();
    }

    const presentBoxes = boxes.filter((box) => box !== null);
    if (presentBoxes.length !== boxes.length) {
      throw new Error("Expected every stat filter to have a bounding box");
    }
    const rows = presentBoxes.map((box) => Math.round(box.y));
    expect(new Set(rows).size).toBeGreaterThan(1);
    expect(Math.min(...rows)).toBeLessThan(Math.max(...rows));
  });
});

// R3: Desktop
test.describe("R3: Desktop viewport (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("full layout renders at desktop", async ({ page }) => {
    await gotoMocked(page, "/", [makeWorkingSession({ id: "desktop-1" })]);

    await expect(page.locator("header span").filter({ hasText: "𖤓" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Project filter" })).toBeVisible();
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
  });

  test("session row renders with project column at sm", async ({ page }) => {
    await gotoMocked(
      page,
      "/",
      [makeWorkingSession({ id: "desktop-row-1", project: "desktop-project" })],
      [{ id: "desktop-project", name: "desktop-project" }],
    );

    await expect(
      page.locator(".data-row span").filter({ hasText: "desktop-project" }),
    ).toBeVisible();
  });
});
