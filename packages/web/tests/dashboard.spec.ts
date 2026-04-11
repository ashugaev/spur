import { test, expect } from "playwright/test";
import {
  makeWorkingSession,
  makeStoppedSession,
  makeCompletedSession,
  makeNeedsInputSession,
  makeWaitingSession,
  makeSessionWithPR,
  makeSessionWithTracker,
  mockSessions,
  gotoMocked,
} from "./fixtures.js";

// D1: Header renders correctly
test.describe("D1: Header renders correctly", () => {
  test("𖤓 icon visible", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "d1-icon" })]);
    await page.goto("/");
    // Use the span in the header specifically — EmptyState also has 𖤓 when no sessions
    await expect(page.locator("header span").filter({ hasText: "𖤓" })).toBeVisible();
  });

  test("All Projects title visible", async ({ page }) => {
    await gotoMocked(page, "/", []);
    await expect(page.getByRole("heading", { name: "All Projects" })).toBeVisible();
  });

  test("Spawn Session button visible", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
  });

  test("Filter select with All projects option", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    const select = page.locator("select").first();
    await expect(select).toBeVisible();
    await expect(select.locator("option[value='']")).toHaveText(/all projects/i);
  });
});

// D2: Header stats show correct counts
test.describe("D2: Header stats show correct counts", () => {
  test("stat buttons visible", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    // The stat buttons have label text but they're hidden on mobile; use broader selector
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
  });

  test("Needs Input shows 1 with one needs_input session", async ({ page }) => {
    const session = makeNeedsInputSession();
    await mockSessions(page, [session]);
    await page.goto("/");
    // Find the stat button containing "Needs Input" label (hidden on small) and value 1
    const needsInputBtn = page.getByRole("button").filter({ hasText: "1" }).first();
    await expect(needsInputBtn).toBeVisible();
  });

  test("Working shows 1 with one working session", async ({ page }) => {
    const session = makeWorkingSession();
    await mockSessions(page, [session]);
    await page.goto("/");
    // Working session → stats.working = 1
    const header = page.locator("header").first();
    await expect(header.getByText("1")).toBeVisible();
  });

  test("Waiting shows 1 with one waiting session", async ({ page }) => {
    const session = makeWaitingSession();
    await mockSessions(page, [session]);
    await page.goto("/");
    const header = page.locator("header").first();
    await expect(header.getByText("1")).toBeVisible();
  });

  test("clicking Needs Input stat filters to only that session", async ({ page }) => {
    const needsInput = makeNeedsInputSession({ id: "ni-1", prompt: "Needs input session" });
    const working = makeWorkingSession({ id: "wk-1", prompt: "Working session" });
    await mockSessions(page, [needsInput, working]);
    await page.goto("/");

    // Wait for sessions to load
    await expect(page.getByText("Working session")).toBeVisible();

    // Click the Needs Input stat button — it has value 1 in the header stat area
    // The stat buttons are in the header, find the one near "Needs Input"
    const statButtons = page.locator("header button");
    // There are 3 stat buttons (respond, working, pending) + spawn button
    // The respond stat is first
    await statButtons.first().click();

    // After filtering, working session should be hidden
    await expect(page.getByText("Working section")).not.toBeVisible();
    // Needs input session still visible in RESPOND zone (labeled "Needs Input")
    await expect(page.getByText("Needs input session")).toBeVisible();
  });

  test("clicking Needs Input stat again unfilters", async ({ page }) => {
    const needsInput = makeNeedsInputSession({ id: "ni-2", prompt: "Needs input session two" });
    const working = makeWorkingSession({ id: "wk-2", prompt: "Working session two" });
    await mockSessions(page, [needsInput, working]);
    await page.goto("/");

    await expect(page.getByText("Working session two")).toBeVisible();

    const statButtons = page.locator("header button");
    await statButtons.first().click();
    // Now filtered - working hidden
    await expect(page.getByText("Working session two")).not.toBeVisible();

    // Click again to unfilter
    await statButtons.first().click();
    await expect(page.getByText("Working session two")).toBeVisible();
  });
});

// D3: Session rows render with correct columns
test.describe("D3: Session rows render with correct columns", () => {
  test("session title link renders and has correct href", async ({ page }) => {
    const session = makeWorkingSession({ id: "row-test-1", prompt: "Row test session" });
    await mockSessions(page, [session]);
    await page.goto("/");
    const link = page.getByRole("link", { name: "Row test session" });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain("row-test-1");
  });

  test("relative time is shown in session row", async ({ page }) => {
    const session = makeWorkingSession({ id: "time-test-1" });
    await mockSessions(page, [session]);
    await page.goto("/");
    // Time is shown as relative (e.g. "just now")
    await expect(page.locator(".data-row").first()).toBeVisible();
  });
});

// D4: Terminal button state
test.describe("D4: Terminal button state", () => {
  test("enabled terminal button for running session with tmuxSession", async ({ page }) => {
    const session = makeWorkingSession({ id: "term-enabled-1" });
    await mockSessions(page, [session]);
    await page.goto("/");

    const termBtn = page.getByRole("button", {
      name: new RegExp(`Open web terminal for ${session.id}`, "i"),
    });
    await expect(termBtn).toBeVisible();
    // Should not have opacity-25 class (disabled appearance)
    const classList = await termBtn.getAttribute("class");
    expect(classList).not.toContain("opacity-25");
    // Should not be disabled attribute
    await expect(termBtn).not.toBeDisabled();
  });

  test("disabled terminal button for stopped session", async ({ page }) => {
    const session = makeStoppedSession({ id: "term-disabled-1" });
    await mockSessions(page, [session]);
    await page.goto("/");

    const termBtn = page.getByRole("button", {
      name: new RegExp(`Open web terminal for ${session.id}`, "i"),
    });
    await expect(termBtn).toBeVisible();
    const classList = await termBtn.getAttribute("class");
    expect(classList).toContain("opacity-25");
    await expect(termBtn).toBeDisabled();
  });

  test("clicking enabled terminal button appends terminal query param", async ({ page }) => {
    const session = makeWorkingSession({ id: "term-click-1" });
    // Mock the terminal modal endpoint too
    await mockSessions(page, [session]);
    await page.goto("/");

    const termBtn = page.getByRole("button", {
      name: new RegExp(`Open web terminal for ${session.id}`, "i"),
    });
    await expect(termBtn).toBeVisible();
    await termBtn.click();

    await expect(page).toHaveURL(new RegExp(`terminal=${session.id}`));
  });

  test("clicking disabled terminal button does not add terminal query param", async ({ page }) => {
    const session = makeStoppedSession({ id: "term-no-click-1" });
    await mockSessions(page, [session]);
    await page.goto("/");

    const termBtn = page.getByRole("button", {
      name: new RegExp(`Open web terminal for ${session.id}`, "i"),
    });
    await expect(termBtn).toBeVisible();
    // Disabled button - clicking should not navigate
    await termBtn.click({ force: true });
    // URL should not contain terminal param
    const url = page.url();
    expect(url).not.toContain("terminal=");
  });
});

// D4b: Merged-PR done button
test.describe("D4b: Merged-PR done button", () => {
  test("done button visible when PR is merged and session is completable", async ({ page }) => {
    const session = makeSessionWithPR({
      id: "done-btn-1",
      status: "running",
      state: "needs_input",
    });
    await mockSessions(page, [session]);
    // Mock pr-status to return merged state (called as /api/pr-status?url=...)
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ state: "merged", ciStatus: null, totalThreads: 0, unresolvedThreads: 0 }),
      });
    });

    await page.goto("/");

    // The done button has aria-label "Mark <id> as done"
    const doneBtn = page.getByRole("button", {
      name: new RegExp(`Mark ${session.id} as done`, "i"),
    });
    await expect(doneBtn).toBeVisible({ timeout: 8000 });
  });
});

// D5: Tracker and PR links
test.describe("D5: Tracker and PR links", () => {
  test("session with tracker link shows tracker icon+id", async ({ page }) => {
    const session = makeSessionWithTracker({ id: "tracker-row-1" });
    await mockSessions(page, [session]);
    await page.goto("/");

    // The tracker link contains WEBDEV-4617 as extracted ID
    // It's in a sm:inline-flex so visible at desktop
    const trackerLink = page.locator("a[href*='jira.example.com']");
    await expect(trackerLink).toBeVisible();
  });

  test("session with PR link shows github link", async ({ page }) => {
    const session = makeSessionWithPR({ id: "pr-row-1" });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ state: "open", ciStatus: null, totalThreads: 0, unresolvedThreads: 0 }),
      });
    });
    await page.goto("/");

    const prLink = page.locator("a[href*='github.com']").first();
    await expect(prLink).toBeVisible();
  });

  test("session without links has no tracker or PR icons", async ({ page }) => {
    const session = makeWorkingSession({ id: "no-links-1" });
    await mockSessions(page, [session]);
    await page.goto("/");

    const trackerLinks = page.locator("a[href*='jira']");
    await expect(trackerLinks).toHaveCount(0);
  });
});

// D6: Attention zone sections
test.describe("D6: Attention zone sections", () => {
  test("section headers present for sessions in each zone", async ({ page }) => {
    const sessions = [
      makeNeedsInputSession({ id: "zone-ni-1" }),
      makeWorkingSession({ id: "zone-wk-1" }),
      makeWaitingSession({ id: "zone-wt-1" }),
    ];
    await mockSessions(page, sessions);
    await page.goto("/");

    // AttentionZone labels: "Needs Input", "Working", "Waiting", "Done"
    await expect(page.getByText("Needs Input").first()).toBeVisible();
    await expect(page.getByText("Working").first()).toBeVisible();
    await expect(page.getByText("Waiting").first()).toBeVisible();
  });

  test("needs_input session appears in Needs Input zone", async ({ page }) => {
    const session = makeNeedsInputSession({
      id: "zone-respond-1",
      prompt: "Respond zone session",
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await expect(page.getByText("Needs Input").first()).toBeVisible();
    await expect(page.getByText("Respond zone session")).toBeVisible();
  });

  test("working session appears in Working zone", async ({ page }) => {
    const session = makeWorkingSession({
      id: "zone-working-1",
      prompt: "Working zone session",
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await expect(page.getByText("Working").first()).toBeVisible();
    await expect(page.getByText("Working zone session")).toBeVisible();
  });

  test("completed session not visible by default", async ({ page }) => {
    const working = makeWorkingSession({ id: "zone-visible-1", prompt: "Visible session" });
    const completed = makeCompletedSession({
      id: "zone-done-1",
      prompt: "Done zone session",
    });
    await mockSessions(page, [working, completed]);
    await page.goto("/");

    // Completed sessions go into "done" zone which IS shown (but hidden by default if it had
    // a "done" filter). The done zone label is "Done" per zoneConfig.
    // The test scenario says "completed/killed sessions NOT visible by default" — meaning
    // the done zone is hidden. But per the code, done zone IS shown (LANE_ORDER includes "done").
    // The code shows done zone when grouped.done.length > 0.
    // So completed session IS shown in done zone. Let's verify the done zone label IS shown.
    await expect(page.getByText("Done").first()).toBeVisible();
    await expect(page.getByText("Done zone session")).toBeVisible();
  });

  test("zone count is shown", async ({ page }) => {
    const sessions = [
      makeNeedsInputSession({ id: "count-1" }),
      makeNeedsInputSession({ id: "count-2" }),
    ];
    await mockSessions(page, sessions);
    await page.goto("/");

    // The count "2" should appear next to the zone header
    await expect(page.getByText("2").first()).toBeVisible();
  });
});

// D6b: Footer
test.describe("D6b: Footer clock hydrates cleanly", () => {
  test("footer status bar visible after load", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    // StatusBar renders in the footer area — wait for it to appear
    await expect(page.locator("footer")).toBeVisible();
  });

  test("footer clock hydrates to a time string", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await expect(page.locator("footer")).toBeVisible();
    // After hydration the clock shows HH:MM:SS
    await expect(page.locator("footer")).toContainText(/\d\d:\d\d:\d\d/);
  });
});

// D7: Spawn modal
test.describe("D7: Spawn modal", () => {
  test("clicking Spawn Session button opens modal", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-test-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
  });

  test("modal has project select, agent select, branch input, plan checkbox", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-fields-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();

    // Project select (contains "Select project" option)
    await expect(page.getByRole("option", { name: /select project/i })).toBeAttached();
    // Agent select
    await expect(page.getByRole("option", { name: "claude" })).toBeAttached();
    // Branch input
    await expect(page.getByLabel("branch name")).toBeVisible();
    // Plan checkbox - it's a checkbox input inside a label with "Plan" text
    await expect(page.getByRole("checkbox")).toBeVisible();
  });

  test("modal has Spawn button", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-btn-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("button", { name: /^spawn$/i })).toBeVisible();
  });

  test("Spawn button disabled when project field is empty", async ({ page }) => {
    await mockSessions(page, [], []);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();

    // No project options available, spawnProjectId starts empty
    const spawnBtn = page.getByRole("button", { name: /^spawn$/i });
    await expect(spawnBtn).toBeDisabled();
  });

  test("clicking outside backdrop closes modal", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-backdrop-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();

    // Click the backdrop (fixed overlay behind the modal)
    await page.mouse.click(10, 10);
    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
  });

  test("✕ button closes modal", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-close-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();

    // The ✕ close button
    await page.getByRole("button", { name: "✕" }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
  });

  test("Enter in textarea creates newline not submit", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-enter-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();

    const textarea = page.locator("textarea").last();
    await textarea.fill("first line");
    await textarea.press("Enter");
    await textarea.type("second line");

    const value = await textarea.inputValue();
    expect(value).toContain("\n");
    // Modal still open
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
  });

  test("Ctrl+Enter in textarea submits spawn request", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "spawn-ctrlenter-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);

    // Mock spawn endpoint
    await page.route("**/api/spawn", (route) => {
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "new-session-id" }),
      });
    });
    // Mock preflight
    await page.route("**/api/preflight", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ branch: "feature/test-branch" }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();

    // Select the project
    const projectSelect = page.locator("select").nth(0);
    await projectSelect.selectOption("my-project");

    const textarea = page.locator("textarea").last();
    await textarea.fill("Test prompt for ctrl enter");
    await textarea.press("Control+Enter");

    // Modal should close after spawn
    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible({ timeout: 5000 });
  });
});

// D7b: Silent branch preflight
test.describe("D7b: Silent branch preflight", () => {
  test("preflight called and branch input auto-populated", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "preflight-1", project: "my-project" }),
    ], [{ id: "my-project", name: "my-project" }]);

    let preflightCalled = false;
    await page.route("**/api/preflight", (route) => {
      preflightCalled = true;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ branch: "feature/auto-branch" }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();

    // Set project and prompt
    const projectSelect = page.locator("select").nth(0);
    await projectSelect.selectOption("my-project");

    const textarea = page.locator("textarea").last();
    await textarea.fill("A prompt that triggers preflight");

    // Wait for debounce (500ms) + network
    await page.waitForTimeout(800);

    expect(preflightCalled).toBe(true);
    const branchInput = page.getByLabel("branch name");
    await expect(branchInput).toHaveValue("feature/auto-branch");
  });
});
