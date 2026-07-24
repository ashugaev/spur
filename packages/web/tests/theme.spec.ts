import { test, expect } from "playwright/test";
import { makeWorkingSession, mockSessions, gotoMocked, type ProjectInfo } from "./fixtures.js";

const LIGHT_BG = "rgb(255, 255, 255)";
const DARK_BG = "rgb(13, 13, 14)";

// T1: Theme persistence
test.describe("T1: Theme persistence", () => {
  test("toggling to light persists across a reload", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("body")).toHaveCSS("background-color", LIGHT_BG);
    await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
  });

  test("light theme and the project filter both survive a reload at /?project=<id>", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.addInitScript(() => {
      window.localStorage.setItem("spur:theme", "light");
    });

    const projects: ProjectInfo[] = [{ id: "test-project", name: "test-project" }];
    await gotoMocked(page, "/?project=test-project", [makeWorkingSession()], projects);

    expect(pageErrors).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // The project restore must not get stuck on the SSR default: a single
    // synchronous layout effect derives locationSearch + projectId together
    // from the URL pre-paint (see Dashboard.tsx), so once the page settles
    // the button must already read the requested project, not "All
    // Projects". This doesn't prove zero visible frames of "All Projects" —
    // that one frame is an accepted, out-of-scope SSR characteristic (this
    // is a client component with no server-side query awareness) and
    // Playwright has no reliable, non-flaky way to assert wall-clock paint
    // timing — but it does catch a regression where the restore silently
    // fails to apply.
    await expect(page.getByRole("button", { name: /^Project filter:/ })).toHaveAccessibleName(
      "Project filter: test-project",
    );
  });

  test("toggling back to dark persists across a reload", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    // Start from light (rather than seeding localStorage via addInitScript,
    // which re-fires on every reload and would clobber the toggle-to-dark
    // write below on the reload assertion further down).
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");

    await page.reload();

    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await expect(page.locator("body")).toHaveCSS("background-color", DARK_BG);
  });

  test("served HTML contains the pre-hydration theme script before </head>", async ({ page }) => {
    const response = await page.request.get("/");
    const body = await response.text();

    const scriptIndex = body.indexOf('localStorage.getItem("spur:theme")');
    const headCloseIndex = body.indexOf("</head>");

    expect(scriptIndex).toBeGreaterThan(-1);
    expect(headCloseIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(headCloseIndex);
  });
});
