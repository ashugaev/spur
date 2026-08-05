import { test, expect } from "playwright/test";
import { makeStoppedSession, makeWorkingSession, mockSessions, gotoMocked } from "./fixtures.js";

// Header controls share one row but not one exact pixel — the 17px brand
// glyph sits inside a row of 28px (h-7) controls, so `items-center` offsets
// its bounding-box `y` by roughly half the height difference even though it
// is visually on the same line. A wrapped (multi-row) header would differ by
// a full row height instead, so a generous single-digit tolerance still
// catches real wrapping while tolerating the icon/control height mismatch.
const ROW_BAND_TOLERANCE_PX = 12;

function expectOneRowBand(boxes: ({ y: number } | null)[]) {
  for (const box of boxes) {
    expect(box).not.toBeNull();
  }
  const present = boxes.filter((box): box is { y: number } => box !== null);
  if (present.length !== boxes.length) {
    throw new Error("Expected every header control to have a bounding box");
  }
  const ys = present.map((box) => box.y);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(ROW_BAND_TOLERANCE_PX);
}

// R1: Mobile (<640px)
test.describe("R1: Mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("header visible at mobile width", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "mob-1" })]);
    await page.goto("/");
    await expect(page.getByRole("img", { name: "Spur" })).toBeVisible();
  });

  test("Spawn Session button visible on mobile", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
  });

  test("spawn draft survives mobile close and full reload", async ({ page }) => {
    await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByPlaceholder("Prompt...").fill("Keep mobile draft");
    await page.getByLabel("branch name").fill("feature/mobile-draft");
    await page.getByLabel("Plan").check();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByPlaceholder("Prompt...")).toHaveValue("Keep mobile draft");
    await page.getByRole("button", { name: "Close" }).click();

    await page.reload();
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByPlaceholder("Prompt...")).toHaveValue("Keep mobile draft");
    await expect(page.getByLabel("branch name")).toHaveValue("feature/mobile-draft");
    await expect(page.getByLabel("Plan")).toBeChecked();
  });

  // Design acceptance criteria 1-3: the header collapses to a single row at
  // every width, the spawn FAB is reachable, and nothing overflows.
  test("header controls share one y-band, the FAB is visible, and there is no horizontal scroll", async ({
    page,
  }) => {
    await mockSessions(page, [makeWorkingSession({ id: "mob-band-1" })]);
    await page.goto("/");

    const glyph = page.getByRole("img", { name: "Spur" });
    const filtersTrigger = page.getByRole("button", { name: "Filters" });
    const searchInput = page.getByPlaceholder("Filter...");
    const shepherd = page.getByRole("button", { name: "Spawn Shepherd" });
    const fab = page.getByRole("button", { name: "Spawn Session" });

    const [glyphBox, filtersBox, searchBox, shepherdBox] = await Promise.all([
      glyph.boundingBox(),
      filtersTrigger.boundingBox(),
      searchInput.boundingBox(),
      shepherd.boundingBox(),
    ]);
    expectOneRowBand([glyphBox, filtersBox, searchBox, shepherdBox]);

    await expect(fab).toBeVisible();

    // The header spawn button is replaced by the FAB below md — only one
    // "Spawn Session" node should exist at this width.
    await expect(page.getByRole("button", { name: "Spawn Session" })).toHaveCount(1);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

    // The FAB stays reachable after scrolling to the bottom of the list.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(fab).toBeVisible();

    // No horizontal scroll with the Filters modal open either.
    await filtersTrigger.click();
    await expect(page.getByRole("dialog", { name: "Filters" })).toBeVisible();
    const scrollWidthOpen = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidthOpen).toBeLessThanOrEqual(innerWidth);
  });

  test("footer edge padding uses safe-area insets", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "mob-safe-1" })]);
    await page.goto("/");

    const footer = page.getByRole("contentinfo");
    await expect(footer).toBeVisible();
    const className = await footer.getAttribute("class");
    expect(className).not.toContain("env(safe-area-inset-bottom)");

    // env() resolves to 0 in a normal browser, so the max() falls back to the
    // base padding. A non-zero value proves the arbitrary-value calc() is valid
    // CSS and the declaration was not silently dropped.
    const padding = await footer.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
        bottom: parseFloat(style.paddingBottom),
      };
    });
    expect(padding.left).toBeGreaterThanOrEqual(8);
    expect(padding.right).toBeGreaterThanOrEqual(8);
    expect(padding.bottom).toBe(4);
  });

  test("no horizontal scroll on mobile", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "mob-scroll-1" })]);
    await page.goto("/");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });

  test("viewport pins maximum-scale=1 to prevent auto-zoom", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    const content = await page
      .locator('meta[name="viewport"]')
      .getAttribute("content", { timeout: 5000 });

    expect(content).toContain("maximum-scale=1");
  });

  test("fields keep their design font size instead of a 16px override", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input, select, textarea")).map((el) => ({
        fontSize: parseFloat(window.getComputedStyle(el).fontSize),
        zoom: window.getComputedStyle(el).zoom,
      })),
    );

    expect(sizes.length).toBeGreaterThan(0);
    for (const { fontSize, zoom } of sizes) {
      expect(fontSize).toBeLessThan(16);
      expect(zoom).toBe("1");
    }
  });

  test("focusing a field does not scale the visual viewport", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    const field = page.getByLabel("Filter sessions");
    await field.click();

    const scale = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    expect(scale).toBe(1);
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

  test("Stopped can start collapsed on mobile and expands on tap", async ({ page }) => {
    await gotoMocked(page, "/", [
      makeStoppedSession({
        id: "mob-stop-1",
        prompt: "Stopped mobile session",
      }),
    ]);
    await page.evaluate(() => {
      window.localStorage.setItem("spur:mobile-collapsed-categories", JSON.stringify(["stopped"]));
    });
    await page.reload();
    await page.waitForFunction(() => !document.body.innerText.includes("Loading..."), {
      timeout: 8000,
    });

    const zoneToggle = page
      .locator("section button")
      .filter({ hasText: /stopped/i })
      .first();
    await expect(zoneToggle).toBeVisible({ timeout: 5000 });
    await expect(zoneToggle).toContainText("Stopped");
    await expect(zoneToggle).toContainText("1");
    await expect(page.getByText("Stopped mobile session")).not.toBeVisible();
    await zoneToggle.click();
    await expect(page.getByText("Stopped mobile session")).toBeVisible();

    await zoneToggle.click();
    await expect(page.getByText("Stopped mobile session")).not.toBeVisible();
  });

  test("spawn slash suggestions stay within the viewport on mobile", async ({ page }) => {
    await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
    const longLabel = "/very-long-command-name-that-keeps-going-for-mobile-bounds";
    const longDetail =
      "Use a detailed slash command description that should expand the popup until the viewport limit";
    await page.route("**/api/projects/my-project/slash-commands?agent=claude", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agent: "claude",
          commands: [
            {
              id: "compact",
              label: "/compact",
              insertText: "/compact",
              detail: "Compact the chat",
              source: "built-in",
              kind: "command",
            },
            {
              id: "agents",
              label: longLabel,
              insertText: longLabel,
              detail: longDetail,
              source: "built-in",
              kind: "command",
            },
          ],
          skills: [],
          agents: [],
        }),
      });
    });
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    await page.getByRole("button", { name: "Slash", exact: true }).click();

    const menu = page.getByRole("menu", { name: "Slash suggestions" });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) {
      throw new Error("Expected mobile slash suggestions menu bounds");
    }

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await expect
      .poll(async () => menu.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await expect(menu.getByText(longLabel)).toHaveAttribute("title", longLabel);
    await expect(menu.getByText(longDetail)).toHaveAttribute("title", longDetail);
    await expect(menu.locator('span[title="built-in"]').first()).toBeVisible();
  });

  test("low-height mobile landscape spawn modal stays in viewport and scrolls to Spawn", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");

    const modal = page
      .getByRole("heading", { name: "Spawn Session" })
      .locator("xpath=ancestor::div[contains(@class, 'max-h')][1]");
    await expect(modal).toBeVisible();

    const before = await modal.boundingBox();
    expect(before).not.toBeNull();
    if (!before) {
      throw new Error("Expected spawn modal bounds before scrolling");
    }
    expect(before.y).toBeGreaterThanOrEqual(0);
    expect(before.y + before.height).toBeLessThanOrEqual(375);

    const submitButton = page.getByRole("button", { name: "Spawn", exact: true });
    await submitButton.scrollIntoViewIfNeeded();
    await expect(submitButton).toBeVisible();

    const after = await modal.boundingBox();
    expect(after).not.toBeNull();
    if (!after) {
      throw new Error("Expected spawn modal bounds after scrolling");
    }
    expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.y + after.height).toBeLessThanOrEqual(375);
  });

  test("spawn modal is full-screen on small mobile", async ({ page }) => {
    await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();

    const modal = page
      .getByRole("heading", { name: "Spawn Session" })
      .locator("xpath=ancestor::div[contains(@class, 'max-h')][1]");
    await expect(modal).toBeVisible();

    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    if (!box) {
      throw new Error("Expected spawn modal bounds");
    }
    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.y).toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThanOrEqual(389);
    expect(box.width).toBeLessThanOrEqual(391);
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

  // Previously named "header controls wrap one element at a time before
  // compact stat labels" and asserted a multi-row wrap at 700px/430px. The
  // redesign collapses the header to ONE row at every width below md — the
  // project name and stat cluster that used to force a wrap no longer live
  // in the header at all (project name is hidden below md; stats moved into
  // the Filters modal). Rewritten to assert the one-row invariant holds at
  // both widths instead of forcing the old wrap behavior to stay green.
  test("header stays one row at 700px and 390px, below the md breakpoint", async ({ page }) => {
    await mockSessions(page, []);

    await page.setViewportSize({ width: 700, height: 844 });
    await page.goto("/");

    // Scoped to the header: with zero sessions the EmptyState renders a second
    // "Spur" glyph inside main once it loads, and the bare locator goes ambiguous.
    const glyph = page.getByRole("banner").getByRole("img", { name: "Spur" });
    const filtersTrigger = page.getByRole("button", { name: "Filters" });
    const searchInput = page.getByPlaceholder("Filter...");
    const shepherd = page.getByRole("button", { name: "Spawn Shepherd" });

    const [glyphBox700, filtersBox700, searchBox700, shepherdBox700] = await Promise.all([
      glyph.boundingBox(),
      filtersTrigger.boundingBox(),
      searchInput.boundingBox(),
      shepherd.boundingBox(),
    ]);
    expectOneRowBand([glyphBox700, filtersBox700, searchBox700, shepherdBox700]);
    // Project name is hidden below md; the header spawn button is replaced
    // by the FAB, so only one "Spawn Session" node exists.
    await expect(page.getByRole("button", { name: /Project filter:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Spawn Session" })).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    const [glyphBox390, filtersBox390, searchBox390, shepherdBox390] = await Promise.all([
      glyph.boundingBox(),
      filtersTrigger.boundingBox(),
      searchInput.boundingBox(),
      shepherd.boundingBox(),
    ]);
    expectOneRowBand([glyphBox390, filtersBox390, searchBox390, shepherdBox390]);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });

  // Previously named "stat filters wrap individually before labels
  // collapse" and asserted the inline stat cluster wrapped across rows at
  // 645px. The stat cluster now lives in the Filters modal, not the header,
  // so the equivalent honest assertion at this width is the same one-row
  // header invariant.
  test("header controls share one y-band just under the md breakpoint (645px)", async ({
    page,
  }) => {
    await mockSessions(page, []);

    await page.setViewportSize({ width: 645, height: 844 });
    await page.goto("/");

    const controls = [
      // Header-scoped for the same reason as the 700px/390px test above.
      page.getByRole("banner").getByRole("img", { name: "Spur" }),
      page.getByRole("button", { name: "Filters" }),
      page.getByPlaceholder("Filter..."),
      page.getByRole("button", { name: "Spawn Shepherd" }),
    ];

    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    expectOneRowBand(boxes);

    await expect(page.getByRole("button", { name: "Spawn Session" })).toHaveCount(1);
  });
});

// R3: Desktop
test.describe("R3: Desktop viewport (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("full layout renders at desktop", async ({ page }) => {
    await gotoMocked(page, "/", [makeWorkingSession({ id: "desktop-1" })]);

    await expect(page.getByRole("img", { name: "Spur" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Project filter:/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
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
