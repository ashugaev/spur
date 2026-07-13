import { test, expect, type Page } from "playwright/test";
import {
  makeWorkingSession,
  makeSpawningSession,
  makeStoppedSession,
  makeErroredSession,
  makeRateLimitedSession,
  makeCompletedSession,
  makeNeedsInputSession,
  makeWaitingSession,
  makeSessionWithPR,
  makeSessionWithTracker,
  mockGitHubStatus,
  mockGitLabStatus,
  mockSessions,
  type ProjectInfo,
  type SpurSessionView,
} from "./fixtures.js";

const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];
const DASHBOARD_POLL_WAIT_MS = 5_200;

async function openSpawnModal(
  page: Page,
  sessions: SpurSessionView[] | (() => SpurSessionView[]) = [],
  projects: ProjectInfo[] | (() => ProjectInfo[]) = DEFAULT_PROJECTS,
) {
  await mockSessions(page, sessions, projects);
  await page.goto("/");
  await page.getByRole("button", { name: /spawn session/i }).click();
  await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
}

async function fillSpawnForm(
  page: Page,
  {
    project = "my-project",
    prompt,
    branch,
    workspaceMode,
    baseBranch,
    planMode,
    selfDestruct,
    selfDestructConditions,
    steps,
  }: {
    project?: string;
    prompt?: string;
    branch?: string;
    workspaceMode?: "default" | "worktree" | "shared";
    baseBranch?: string;
    planMode?: boolean;
    selfDestruct?: boolean;
    selfDestructConditions?: string;
    steps?: string[];
  },
) {
  await page.getByRole("combobox", { name: "Spawn project" }).selectOption(project);

  if (workspaceMode) {
    await page.getByRole("combobox", { name: "workspace mode" }).selectOption(workspaceMode);
  }

  if (baseBranch !== undefined) {
    await page.getByPlaceholder("Base branch").fill(baseBranch);
  }

  if (planMode !== undefined) {
    const checkbox = page.getByRole("checkbox", { name: "Plan" });
    if ((await checkbox.isChecked()) !== planMode) {
      await checkbox.click();
    }
  }

  if (selfDestruct !== undefined) {
    const checkbox = page.getByRole("checkbox", { name: "Self-destruct" });
    if ((await checkbox.isChecked()) !== selfDestruct) {
      await checkbox.click();
    }
  }

  if (selfDestructConditions !== undefined) {
    await page.getByLabel("Self-destruct conditions").fill(selfDestructConditions);
  }

  if (steps) {
    for (let index = 0; index < steps.length; index += 1) {
      await page.getByRole("button", { name: /\+ step/i }).click();
      await page.getByLabel(`step ${index + 1}`).fill(steps[index] ?? "");
    }
  }

  if (branch !== undefined) {
    await page.getByLabel("branch name").fill(branch);
  }

  if (prompt !== undefined) {
    await page.getByPlaceholder("Prompt for the new session...").fill(prompt);
  }
}

function attentionZone(page: Page, label: string) {
  return page.locator("main > section > section").filter({
    has: page.getByText(label, { exact: true }),
  });
}

// D1: Header renders correctly
test.describe("D1: Header renders correctly", () => {
  test("𖤓 icon visible", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "d1-icon" })]);
    await page.goto("/");
    await expect(page.locator("main > header").first()).toContainText("𖤓");
  });

  test("project title menu visible with chevron indicator", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    const projectFilter = page.getByRole("button", { name: "Project filter: All Projects" });
    await expect(projectFilter).toBeVisible();
    await expect(projectFilter).toContainText("All Projects");
    await expect(page.getByTestId("project-filter-chevron")).toBeVisible();
  });

  test("split spawn control visible", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Spawn Shepherd" })).toBeVisible();
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
  });

  test("Shepherd side opens spawn modal with the built-in project selected", async ({ page }) => {
    await mockSessions(
      page,
      [],
      [
        {
          id: "spur-shepherd",
          name: "Shepherd",
          kind: "shepherd",
          prefix: "shp",
          path: "/tmp/spur-data/shepherd",
        },
      ],
    );

    await page.goto("/");
    await page.getByRole("button", { name: "Spawn Shepherd" }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Spawn project" })).toHaveValue(
      "spur-shepherd",
    );
    await expect(page.getByRole("combobox", { name: "Spawn agent" })).toHaveValue("claude");
  });

  test("tab title is Spur", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await expect(page).toHaveTitle("Spur");
  });

  test("browser find shortcut focuses and selects dashboard search", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({ id: "d1-search-shortcut", prompt: "Fix auth" }),
    ]);
    await page.goto("/");

    const searchInput = page.getByLabel("Filter sessions");
    await searchInput.fill("auth");
    await page.keyboard.press("Control+F");

    await expect(searchInput).toBeFocused();
    await expect
      .poll(async () =>
        searchInput.evaluate((element) => {
          if (!(element instanceof HTMLInputElement)) {
            throw new Error("Expected dashboard search input");
          }
          return [element.selectionStart, element.selectionEnd];
        }),
      )
      .toEqual([0, "auth".length]);

    await page.getByRole("button", { name: "Spawn Session" }).click();
    await expect(page.getByRole("heading", { name: "Spawn Session" })).toBeVisible();
    await page.keyboard.press("Control+F");
    await expect(searchInput).not.toBeFocused();
  });

  test("project title menu has All Projects option", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    await page.getByRole("button", { name: "Project filter: All Projects" }).click();
    await expect(page.getByRole("menuitemradio", { name: "All Projects" })).toBeVisible();
  });

  test("project title menu aligns selected rows and includes Shepherd badge in the option", async ({
    page,
  }) => {
    await mockSessions(
      page,
      [],
      [
        {
          id: "spur-shepherd",
          name: "Shepherd",
          kind: "shepherd",
          prefix: "shp",
          path: "/tmp/spur-data/shepherd",
        },
        {
          id: "api",
          name: "API",
          prefix: "api",
          path: "/repo/api",
        },
      ],
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Project filter: All Projects" }).click();

    const allProjectsOption = page.getByRole("menuitemradio", { name: "All Projects" });
    const shepherdOption = page.getByRole("menuitemradio", { name: /Shepherd\s+built-in/i });
    await expect(shepherdOption).toBeVisible();

    const allProjectsBox = await allProjectsOption.boundingBox();
    const shepherdBox = await shepherdOption.boundingBox();
    expect(allProjectsBox).not.toBeNull();
    expect(shepherdBox).not.toBeNull();
    if (allProjectsBox === null || shepherdBox === null) {
      throw new Error("Project menu option bounds missing");
    }
    expect(Math.abs(allProjectsBox.x - shepherdBox.x)).toBeLessThanOrEqual(1);

    await shepherdOption.getByText("built-in").click();
    await expect(page.getByRole("button", { name: "Project filter: Shepherd" })).toBeVisible();
  });

  test("project edit modal uses in-app delete confirmation", async ({ page }) => {
    let deleted = false;
    let nativeDialogOpened = false;
    await mockSessions(page, [], () =>
      deleted
        ? []
        : [
            {
              id: "stub",
              name: "Stub",
              configured: false,
              prefix: "stub",
              path: "/tmp/stub",
            },
          ],
    );
    page.on("dialog", async (dialog) => {
      nativeDialogOpened = true;
      await dialog.dismiss();
    });
    await page.route("**/api/projects/stub", async (route) => {
      deleted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ removedKind: "unconfigured", projects: [] }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Project filter: All Projects" }).click();
    await page.getByRole("menuitem", { name: "Edit Stub" }).click();

    await expect(page.getByRole("dialog", { name: "Project settings" })).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Delete Stub?")).toBeVisible();
    expect(nativeDialogOpened).toBe(false);

    await page.getByRole("button", { name: "Cancel Delete" }).click();
    await expect(page.getByText("Delete Stub?")).toHaveCount(0);
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Confirm Delete" }).click();

    await expect(page.getByRole("dialog", { name: "Project settings" })).toHaveCount(0);
    expect(nativeDialogOpened).toBe(false);
  });

  test("dashboard search clear button resets and refocuses search", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "search-clear-1" })]);
    await page.route("**/api/runtime/voice", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: false, language: "" }),
      });
    });

    await page.goto("/");

    const searchInput = page.getByRole("textbox", { name: "Filter sessions" });
    await expect(page.getByRole("button", { name: "Clear dashboard search" })).toBeHidden();

    await searchInput.fill("feature");
    await expect(page.getByRole("button", { name: "Clear dashboard search" })).toBeVisible();

    await page.getByRole("button", { name: "Clear dashboard search" }).click();

    await expect(searchInput).toHaveValue("");
    await expect(searchInput).toBeFocused();
    await expect(page.getByRole("button", { name: "Clear dashboard search" })).toBeHidden();
  });

  test("dashboard search shows voice controls when voice is available", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession({ id: "search-voice-1" })]);
    await page.route("**/api/runtime/voice", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
      });
    });

    await page.goto("/");

    await expect(page.getByPlaceholder("Filter sessions... Voice ⌘ + .")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start voice recording" })).toBeVisible();
  });

  test("dashboard search shows voice recording errors inline", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () =>
            Promise.reject(
              Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
            ),
        },
      });
    });
    await mockSessions(page, [makeWorkingSession({ id: "search-voice-error-1" })]);
    await page.route("**/api/runtime/voice", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Start voice recording" }).click();

    await expect(
      page.getByText(
        "Microphone access is blocked. Allow microphone permission in your browser and try again.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Filter sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Spawn Session" })).toBeVisible();
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

  test("Errors stat appears only for error sessions and Needs Input excludes them", async ({
    page,
  }) => {
    const errored = makeErroredSession({
      id: "err-stat-1",
      prompt: "Errored runtime session",
    });
    const needsInput = makeNeedsInputSession({
      id: "ni-stat-1",
      prompt: "Needs response session",
    });
    await mockSessions(page, [errored, needsInput]);
    await page.goto("/");

    await expect(page.getByRole("button", { name: /Errors:\s*1/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Needs Input:\s*1/i })).toBeVisible();

    await page.getByRole("button", { name: /errors/i }).click();
    await expect(page.getByText("Errored runtime session")).toBeVisible();
    await expect(page.getByText("Needs response session")).not.toBeVisible();

    await page.getByRole("button", { name: /errors/i }).click();
    await page.getByRole("button", { name: /needs input/i }).click();
    await expect(page.getByText("Needs response session")).toBeVisible();
    await expect(page.getByText("Errored runtime session")).not.toBeVisible();
  });

  test("Errors stat is hidden when there are no error sessions", async ({ page }) => {
    const session = makeNeedsInputSession();
    await mockSessions(page, [session]);
    await page.goto("/");

    await expect(page.locator("header").getByRole("button", { name: /Errors/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Needs Input:\s*1/i })).toBeVisible();
  });

  test("Working shows 1 with one working session", async ({ page }) => {
    const session = makeWorkingSession();
    await mockSessions(page, [session]);
    await page.goto("/");
    // Working session → stats.working = 1
    const header = page.locator("header").first();
    await expect(header.getByText("1")).toBeVisible();
  });

  test("spawning session stays in Working instead of Needs Input", async ({ page }) => {
    const session = makeSpawningSession({
      id: "spawning-working-1",
      prompt: "Spawning startup session",
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await expect(page.getByRole("button", { name: /Needs Input:\s*0/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Working:\s*1/i })).toBeVisible();

    await page.getByRole("button", { name: /needs input/i }).click();
    await expect(page.getByText("Spawning startup session")).not.toBeVisible();

    await page.getByRole("button", { name: /working/i }).click();
    await expect(page.getByText("Spawning startup session")).toBeVisible();
  });

  test("Waiting shows 1 with one waiting session", async ({ page }) => {
    const session = makeWaitingSession();
    await mockSessions(page, [session]);
    await page.goto("/");
    const header = page.locator("header").first();
    await expect(header.getByText("1")).toBeVisible();
  });

  test("Stopped shows 1 with one stopped session", async ({ page }) => {
    const session = makeStoppedSession({ prompt: "Stopped session" });
    await mockSessions(page, [session]);
    await page.goto("/");
    await expect(page.locator("header").getByRole("button", { name: /Stopped/i })).toContainText(
      "1",
    );
  });

  test("Completed shows 1 with one completed session", async ({ page }) => {
    const session = makeCompletedSession({ prompt: "Completed session" });
    await mockSessions(page, [session]);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Completed/i })).toContainText("1");
  });

  test("Completed count updates after polling when a session finishes", async ({ page }) => {
    const working = makeWorkingSession({
      id: "wk-complete-1",
      prompt: "Completes after poll",
    });
    let sessions = [working];
    await mockSessions(page, () => sessions);
    await page.goto("/");

    await expect(page.getByText("Completes after poll")).toBeVisible();
    await expect(page.getByRole("button", { name: /Completed/i })).toContainText("0");

    sessions = [
      {
        ...working,
        status: "completed",
        state: "stopped",
        runtimeAlive: false,
        tmuxSession: null,
      },
    ];

    await page.waitForTimeout(5500);

    await expect(page.getByRole("button", { name: /Completed/i })).toContainText("1");
    await expect(page.getByText("Completes after poll")).not.toBeVisible();

    await page.getByRole("button", { name: /Completed/i }).click();
    await expect(page.getByText("Completes after poll")).toBeVisible();
  });

  test("clicking Needs Input stat filters to only that session", async ({ page }) => {
    const needsInput = makeNeedsInputSession({ id: "ni-1", prompt: "Needs input session" });
    const working = makeWorkingSession({ id: "wk-1", prompt: "Working session" });
    await mockSessions(page, [needsInput, working]);
    await page.goto("/");

    // Wait for sessions to load
    await expect(page.getByText("Working session")).toBeVisible();

    // Click the Needs Input stat button — accessible name comes from the visible label
    await page.getByRole("button", { name: /needs input/i }).click();

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

    const needsInputStat = page.getByRole("button", { name: /needs input/i });
    await needsInputStat.click();
    // Now filtered - working hidden
    await expect(page.getByText("Working session two")).not.toBeVisible();

    // Click again to unfilter
    await needsInputStat.click();
    await expect(page.getByText("Working session two")).toBeVisible();
  });

  test("clicking Completed filters to only completed sessions", async ({ page }) => {
    const working = makeWorkingSession({ id: "wk-done-1", prompt: "Working still active" });
    const completed = makeCompletedSession({
      id: "done-only-1",
      prompt: "Completed and archived",
    });
    await mockSessions(page, [working, completed]);
    await page.goto("/");

    await expect(page.getByText("Working still active")).toBeVisible();
    await expect(page.getByText("Completed and archived")).not.toBeVisible();

    await page.getByRole("button", { name: /Completed/i }).click();

    await expect(page.getByText("Completed and archived")).toBeVisible();
    await expect(page.getByText("Working still active")).not.toBeVisible();
    await expect(page.locator("section").getByText("Completed").first()).toBeVisible();
  });

  test("clicking Completed again returns to current sessions", async ({ page }) => {
    const working = makeWorkingSession({ id: "wk-done-2", prompt: "Working returns" });
    const completed = makeCompletedSession({
      id: "done-only-2",
      prompt: "Completed hides again",
    });
    await mockSessions(page, [working, completed]);
    await page.goto("/");

    const completedToggle = page.getByRole("button", { name: /Completed/i });
    await completedToggle.click();
    await expect(page.getByText("Completed hides again")).toBeVisible();

    await completedToggle.click();

    await expect(page.getByText("Working returns")).toBeVisible();
    await expect(page.getByText("Completed hides again")).not.toBeVisible();
  });

  test("shows placeholder with reset filters when a stat filter hides all sessions", async ({
    page,
  }) => {
    const working = makeWorkingSession({ id: "wk-empty-1", prompt: "Only working session" });
    await mockSessions(page, [working]);
    await page.goto("/");

    await expect(page.getByText("Only working session")).toBeVisible();

    await page.getByRole("button", { name: /needs input/i }).click();

    await expect(page.getByText("No sessions match the current filters.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset Filters" })).toBeVisible();

    await page.getByRole("button", { name: "Reset Filters" }).click();

    await expect(page.getByText("Only working session")).toBeVisible();
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

  test("todo progress renders colored compact circles in dashboard rows", async ({ page }) => {
    const completeSession = makeWorkingSession({
      id: "row-todo-complete",
      prompt: "Todo complete session",
      todo: {
        status: "completed",
        total: 3,
        done: 3,
        skipped: 0,
        failed: 0,
        items: [],
      },
    });
    const partialSession = makeWorkingSession({
      id: "row-todo-partial-demo",
      agent: "cursor",
      prompt: "Partial todo demo agent",
      todo: {
        status: "running",
        total: 4,
        done: 1,
        skipped: 1,
        failed: 0,
        items: [],
      },
    });
    await mockSessions(page, [completeSession, partialSession]);
    await page.goto("/");

    const completeProgress = page.getByLabel("Todo progress 3 of 3");
    await expect(completeProgress).toBeVisible();
    await expect(completeProgress).toHaveClass(/text-\[var\(--color-status-ready\)\]/);
    const partialProgress = page.getByLabel("Todo progress 2 of 4");
    await expect(partialProgress).toBeVisible();
    await expect(partialProgress).toHaveClass(/text-\[var\(--color-status-attention\)\]/);
    await expect(page.getByText("Partial todo demo agent")).toBeVisible();
    await expect(page.getByText("cursor")).toBeVisible();
    await expect(page.getByText("todo 2/3")).toHaveCount(0);
  });

  test("wake markers open timer details from the session row", async ({ page }) => {
    const dueAt = new Date(Date.now() + 300_000).toISOString();
    const session = makeWorkingSession({
      id: "wake-test-1",
      prompt: "Wake marker session",
      intervalWake: {
        nextDueAt: dueAt,
        intervalMs: 300_000,
        message: "Check CI",
        stopCondition: "CI is green",
      },
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await page.getByLabel("Interval wake scheduled").click();
    const wakePanel = page.locator("#wake-wake-test-1");
    await expect(wakePanel.getByText("Interval wake")).toBeVisible();
    await expect(wakePanel.getByText(/in \d+m/)).toBeVisible();
    await expect(wakePanel.getByText("every 5m")).toBeVisible();
    await expect(wakePanel.getByText("until CI is green")).toBeVisible();
  });

  test("one-shot wake marker identifies one-time timer", async ({ page }) => {
    const session = makeWorkingSession({
      id: "wake-test-2",
      prompt: "One-shot wake session",
      scheduledWake: {
        dueAt: new Date(Date.now() + 120_000).toISOString(),
        message: "Ask user for status",
      },
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await page.getByLabel("Wake scheduled").click();
    const wakePanel = page.locator("#wake-wake-test-2");
    await expect(wakePanel.getByText("Wake")).toBeVisible();
    await expect(wakePanel.getByText(/in \d+m/)).toBeVisible();
    await expect(wakePanel.getByText("Ask user for status")).toBeVisible();
  });

  test("running sidecar marker opens exact sidecar names and links available URLs", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "sidecar-marker-1",
      prompt: "Sidecar marker session",
      runningSidecarNames: ["isolated-ui", "preview"],
      slots: {
        links: [{ label: "isolated-ui", url: "http://127.0.0.1:5625/" }],
      },
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await page.getByLabel("Running sidecars for sidecar-marker-1").click();
    const sidecarPanel = page.locator("#sidecars-sidecar-marker-1");
    await expect(sidecarPanel.getByText("Running Sidecars")).toBeVisible();
    await expect(sidecarPanel.getByRole("link", { name: "isolated-ui" })).toHaveAttribute(
      "href",
      "http://127.0.0.1:5625/",
    );
    await expect(sidecarPanel.getByText("preview")).toBeVisible();
    await expect(sidecarPanel.getByRole("button")).toHaveCount(0);
    await expect(sidecarPanel.getByRole("link")).toHaveCount(1);
  });

  test("daily wake marker identifies fixed-time timer", async ({ page }) => {
    const session = makeWorkingSession({
      id: "wake-test-3",
      prompt: "Daily wake session",
      dailyWake: {
        dailyAt: ["09:00", "17:00"],
        nextDueAt: new Date(Date.now() + 300_000).toISOString(),
        message: "Check daily state",
        stopCondition: "Daily checks done",
      },
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await page.getByLabel("Daily wake scheduled").click();
    const wakePanel = page.locator("#wake-wake-test-3");
    await expect(wakePanel.getByText("Daily wake")).toBeVisible();
    await expect(wakePanel.getByText(/in \d+m/)).toBeVisible();
    await expect(wakePanel.getByText("daily 09:00, 17:00")).toBeVisible();
    await expect(wakePanel.getByText("until Daily checks done")).toBeVisible();
  });

  test("wake and running sidecar row panels do not overlap", async ({ page }) => {
    const session = makeWorkingSession({
      id: "row-panels-1",
      prompt: "Wake and sidecar marker session",
      dailyWake: {
        dailyAt: ["09:00"],
        nextDueAt: new Date(Date.now() + 300_000).toISOString(),
        message: "Check daily state",
      },
      runningSidecarNames: ["isolated-ui"],
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    const wakeButton = page.getByLabel("Daily wake scheduled");
    const sidecarButton = page.getByLabel("Running sidecars for row-panels-1");
    const wakePanel = page.locator("#wake-row-panels-1");
    const sidecarPanel = page.locator("#sidecars-row-panels-1");

    await wakeButton.click();
    await expect(wakePanel.getByText("Daily wake")).toBeVisible();
    await expect(sidecarPanel).toHaveCount(0);

    await sidecarButton.click();
    await expect(wakePanel).toHaveCount(0);
    await expect(sidecarPanel.getByText("Running Sidecars")).toBeVisible();
    await expect(sidecarPanel.getByText("isolated-ui")).toBeVisible();
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

  test("disabled terminal button for running session without tmuxSession", async ({ page }) => {
    const session = makeWorkingSession({ id: "term-disabled-1", tmuxSession: null });
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
    const session = makeWorkingSession({ id: "term-no-click-1", tmuxSession: null });
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

  test("stopped restorable session shows restore instead of disabled terminal", async ({
    page,
  }) => {
    const session = makeStoppedSession({ id: "restore-visible-1", prompt: "Restore visible" });
    await mockSessions(page, [session]);
    await page.goto("/");

    const restoreBtn = page.getByRole("button", {
      name: new RegExp(`Restore session ${session.id}`, "i"),
    });
    await expect(restoreBtn).toBeVisible();
    await expect(restoreBtn).not.toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Open web terminal for ${session.id}`, "i"),
      }),
    ).toHaveCount(0);
  });

  test("errored restorable session shows restore instead of disabled terminal", async ({
    page,
  }) => {
    const session = makeErroredSession({ id: "restore-error-1", prompt: "Restore errored" });
    await mockSessions(page, [session]);
    await page.goto("/");

    const restoreBtn = page.getByRole("button", {
      name: new RegExp(`Restore session ${session.id}`, "i"),
    });
    await expect(restoreBtn).toBeVisible();
    await expect(restoreBtn).not.toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Open web terminal for ${session.id}`, "i"),
      }),
    ).toHaveCount(0);
  });

  test("clicking restore posts and refetches sessions", async ({ page }) => {
    const stopped = makeStoppedSession({ id: "restore-click-1", prompt: "Restore click" });
    const restored = makeWorkingSession({
      ...stopped,
      status: "running",
      state: "working",
      runtimeAlive: true,
      tmuxSession: "spur-restore-click-1",
    });
    let restoredState = false;
    let restoreCalls = 0;

    await mockSessions(page, () => (restoredState ? [restored] : [stopped]));
    await page.route(`**/api/sessions/${stopped.id}/restore`, async (route) => {
      restoreCalls += 1;
      restoredState = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto("/");

    await page
      .getByRole("button", { name: new RegExp(`Restore session ${stopped.id}`, "i") })
      .click();

    await expect.poll(() => restoreCalls).toBe(1);
    await expect(
      page.getByRole("button", { name: new RegExp(`Open web terminal for ${stopped.id}`, "i") }),
    ).toBeVisible();
  });

  test("restore failure leaves row visible and shows error", async ({ page }) => {
    const session = makeStoppedSession({ id: "restore-fail-1", prompt: "Restore fails" });
    await mockSessions(page, [session]);
    await page.route(`**/api/sessions/${session.id}/restore`, async (route) => {
      await route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "Restore failed",
      });
    });
    await page.goto("/");

    await page
      .getByRole("button", { name: new RegExp(`Restore session ${session.id}`, "i") })
      .click();

    await expect(page.getByRole("alert").filter({ hasText: "Restore failed" })).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.getByRole("alert").filter({ hasText: "Restore failed" })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss toast" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Restore failed" })).toHaveCount(0);
    await expect(page.getByText("Restore fails")).toBeVisible();
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
        body: JSON.stringify({
          state: "merged",
          ciStatus: null,
          canMerge: false,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });

    await page.goto("/");

    // The done button has aria-label "Mark <id> as done"
    const doneBtn = page.getByRole("button", {
      name: new RegExp(`Mark ${session.id} as done`, "i"),
    });
    await expect(doneBtn).toBeVisible({ timeout: 8000 });
  });

  test("done click hides the row optimistically before complete API resolves", async ({ page }) => {
    const session = makeSessionWithPR({
      id: "done-optimistic-1",
      prompt: "Optimistic done row",
      status: "running",
      state: "needs_input",
      slots: {
        title: "Optimistic done row",
        links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/42" }],
      },
    });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "merged",
          reviewDecision: null,
          ciStatus: "success",
          canMerge: false,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });

    let releaseComplete: () => void = () => undefined;
    let completeRequestSeen = false;
    const completeHold = new Promise<void>((resolve) => {
      releaseComplete = resolve;
    });
    await page.route(`/api/sessions/${session.id}/complete`, async (route) => {
      completeRequestSeen = true;
      await completeHold;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/");

    await page.getByRole("button", { name: new RegExp(`Mark ${session.id} as done`, "i") }).click();

    await expect.poll(() => completeRequestSeen).toBe(true);
    await expect(page.getByText("Optimistic done row")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Completed:\s*1/i })).toBeVisible();

    await page.getByRole("button", { name: /Completed/i }).click();
    await expect(page.getByText("Optimistic done row")).toBeVisible();

    releaseComplete();
  });

  test("done click rolls back and retries when open PR action is required", async ({ page }) => {
    const session = makeSessionWithPR({
      id: "done-open-pr-1",
      prompt: "Open PR action row",
      status: "running",
      state: "needs_input",
      slots: {
        title: "Open PR action row",
        links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/42" }],
      },
    });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "merged",
          reviewDecision: null,
          ciStatus: "success",
          canMerge: false,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });

    let completeAttempts = 0;
    const completeBodies: unknown[] = [];
    await page.route(`/api/sessions/${session.id}/complete`, async (route) => {
      completeAttempts += 1;
      completeBodies.push(route.request().postDataJSON());
      if (completeAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "open_pr_action_required",
            sessionId: session.id,
            pr: {
              number: 42,
              title: "Open PR action row",
              url: "https://github.com/test/repo/pull/42",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(`Mark ${session.id} as done`, "i") }).click();

    await expect(page.getByRole("dialog", { name: "Open Pull Request" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Leave Pull Request Open" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Pull Request" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open PR action row" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Leave Pull Request Open" }).click();

    await expect.poll(() => completeAttempts).toBe(2);
    expect(completeBodies).toEqual([{ scope: "desk" }, { scope: "desk", prAction: "leave_open" }]);
  });

  test("done click confirms active desk subagents and sends desk-scoped complete", async ({
    page,
  }) => {
    const session = makeSessionWithPR({
      id: "done-desk-1",
      prompt: "Desk done row",
      status: "running",
      state: "needs_input",
      slots: {
        title: "Desk done row",
        links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/42" }],
      },
    });
    const subagent = makeWorkingSession({
      id: "done-desk-2",
      deskId: session.id,
      prompt: "Desk helper",
      slots: { title: "Desk helper", links: [] },
    });
    await mockSessions(page, [session, subagent]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "merged",
          reviewDecision: null,
          ciStatus: "success",
          canMerge: false,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });

    let completeBody: unknown = null;
    await page.route(`/api/sessions/${session.id}/complete`, async (route) => {
      completeBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ completedIds: [session.id, subagent.id] }),
      });
    });
    page.on("dialog", async (dialog) => {
      expect(dialog.message()).toBe(
        "Complete this desk? 1 subagent on this checkout will be ended.",
      );
      await dialog.accept();
    });

    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(`Mark ${session.id} as done`, "i") }).click();

    await expect.poll(() => completeBody).toEqual({ scope: "desk" });
  });

  test("merge button replaces terminal button when PR can merge", async ({ page }) => {
    const session = makeSessionWithPR({
      id: "merge-btn-1",
      status: "running",
      state: "needs_input",
    });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status\?/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "open",
          reviewDecision: null,
          ciStatus: "success",
          canMerge: true,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });
    await page.route("/api/pr-status/merge", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, merged: true, sha: "abc123" }),
      });
    });

    await page.goto("/");

    const mergeBtn = page.getByRole("button", {
      name: new RegExp(`Merge PR for ${session.id}`, "i"),
    });
    await expect(mergeBtn).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Open web terminal for ${session.id}`, "i"),
      }),
    ).toHaveCount(0);

    await mergeBtn.click();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Mark ${session.id} as done`, "i"),
      }),
    ).toBeVisible();
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
    const prUrl = "https://github.com/test/repo/pull/42001";
    const session = makeSessionWithPR({
      id: "pr-row-1",
      slots: {
        title: "Session with PR",
        links: [{ label: "pr", url: prUrl }],
      },
    });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          canMerge: true,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });
    await page.goto("/");

    const prLink = page.locator(`a[href='${prUrl}']`).first();
    await expect(prLink).toBeVisible();
    await expect(prLink.locator("[data-pr-review-decision='approved']")).toBeVisible();
  });

  test("session with GitLab MR link shows compact merge request id", async ({ page }) => {
    const session = makeWorkingSession({
      id: "gitlab-pr-row-1",
      slots: {
        title: "Session with GitLab MR",
        links: [{ label: "pr", url: "https://gitlab.com/test/repo/-/merge_requests/42" }],
      },
    });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "open",
          ciStatus: null,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });
    await page.goto("/");

    const prLink = page.locator("a[href*='gitlab.com']").first();
    await expect(prLink).toBeVisible();
    await expect(prLink).toContainText("!42");
    await expect(prLink.locator("svg")).toHaveCount(1);
  });

  test("stale PR payload does not affect the footer GitHub health indicator", async ({ page }) => {
    const session = makeSessionWithPR({
      id: "pr-row-missing-1",
      slots: {
        title: "Missing PR",
        links: [{ label: "pr", url: "https://github.com/test/repo/pull/999" }],
      },
    });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: null,
          ciStatus: null,
          totalThreads: 0,
          unresolvedThreads: 0,
        }),
      });
    });
    await page.goto("/");

    await expect(
      page.locator("a[href='https://github.com/test/repo/pull/999']").first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "GitHub connection healthy" })).toBeVisible();
  });

  test("soft PR status errors do not replace the footer GitHub connection status", async ({
    page,
  }) => {
    const session = makeSessionWithPR({ id: "pr-row-soft-error-1" });
    await mockSessions(page, [session]);
    await page.route(/\/api\/pr-status/, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: null,
          ciStatus: null,
          totalThreads: 0,
          unresolvedThreads: 0,
          error: "GitHub API 503",
        }),
      });
    });
    await page.goto("/");

    await expect(page.getByRole("button", { name: "GitHub connection healthy" })).toBeVisible();
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
      makeErroredSession({ id: "zone-err-1" }),
      makeNeedsInputSession({ id: "zone-ni-1" }),
      makeWorkingSession({ id: "zone-wk-1" }),
      makeWaitingSession({ id: "zone-wt-1" }),
    ];
    await mockSessions(page, sessions);
    await page.goto("/");

    // AttentionZone labels: "Errors", "Needs Input", "Working", "Waiting", "Stopped", "Completed"
    await expect(page.getByText("Errors").first()).toBeVisible();
    await expect(page.getByText("Needs Input").first()).toBeVisible();
    await expect(page.getByText("Working").first()).toBeVisible();
    await expect(page.getByText("Waiting").first()).toBeVisible();
  });

  test("errored session appears in Errors zone", async ({ page }) => {
    const session = makeErroredSession({
      id: "zone-error-1",
      prompt: "Errors zone session",
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await expect(attentionZone(page, "Errors")).toBeVisible();
    await expect(page.getByText("Errors zone session")).toBeVisible();
    await expect(attentionZone(page, "Needs Input")).toHaveCount(0);
  });

  test("rate_limited session appears in Rate Limited zone under Errors", async ({ page }) => {
    const sessions = [
      makeErroredSession({ id: "zone-err-before-rl", prompt: "Error above rate limit" }),
      makeRateLimitedSession({
        id: "zone-rate-limited-1",
        prompt: "Rate limited zone session",
      }),
      makeNeedsInputSession({ id: "zone-ni-after-rl", prompt: "Needs input below rate limit" }),
    ];
    await mockSessions(page, sessions);
    await page.goto("/");

    const errorsZone = attentionZone(page, "Errors");
    const rateLimitedZone = attentionZone(page, "Rate Limited");
    const needsInputZone = attentionZone(page, "Needs Input");
    await expect(errorsZone).toBeVisible();
    await expect(rateLimitedZone).toBeVisible();
    await expect(needsInputZone).toBeVisible();

    const errorsY = (await errorsZone.boundingBox())!.y;
    const rateLimitedY = (await rateLimitedZone.boundingBox())!.y;
    const needsInputY = (await needsInputZone.boundingBox())!.y;
    expect(rateLimitedY).toBeGreaterThan(errorsY);
    expect(needsInputY).toBeGreaterThan(rateLimitedY);

    await expect(page.getByText("Rate limited zone session")).toBeVisible();
    await expect(page.getByRole("button", { name: /Rate Limited:\s*1/i })).toBeVisible();
  });

  test("Rate Limited stat filter isolates rate_limited sessions", async ({ page }) => {
    const sessions = [
      makeRateLimitedSession({ id: "filter-rl-1", prompt: "Filtered rate limited" }),
      makeWorkingSession({ id: "filter-wk-1", prompt: "Hidden while filtered" }),
    ];
    await mockSessions(page, sessions);
    await page.goto("/");

    await page.getByRole("button", { name: /Rate Limited:\s*1/i }).click();
    await expect(page.getByText("Filtered rate limited")).toBeVisible();
    await expect(page.getByText("Hidden while filtered")).toHaveCount(0);
    await expect(attentionZone(page, "Working")).toHaveCount(0);
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

  test("stopped session appears in Stopped zone", async ({ page }) => {
    const session = makeStoppedSession({
      id: "zone-stopped-1",
      prompt: "Stopped zone session",
    });
    await mockSessions(page, [session]);
    await page.goto("/");

    await expect(page.getByText("Stopped").first()).toBeVisible();
    await expect(page.getByText("Stopped zone session")).toBeVisible();
  });

  test("completed session not visible by default", async ({ page }) => {
    const working = makeWorkingSession({ id: "zone-visible-1", prompt: "Visible session" });
    const completed = makeCompletedSession({
      id: "zone-done-1",
      prompt: "Done zone session",
    });
    await mockSessions(page, [working, completed]);
    await page.goto("/");

    await expect(page.getByText("Visible session")).toBeVisible();
    await expect(page.getByText("Done zone session")).not.toBeVisible();
    await expect(page.locator("section").getByText("Completed").first()).not.toBeVisible();
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

test.describe("D6a: Backlog zone", () => {
  test("shows backlog above sessions only when available items exist", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession()], DEFAULT_PROJECTS, [
      {
        provider: "jira",
        projectId: "my-project",
        backlogId: "features",
        externalId: "10001",
        key: "WEB-17",
        title: "Fix checkout",
        url: "https://jira.example.com/browse/WEB-17",
        fetchedAt: "2026-06-16T12:00:00.000Z",
      },
    ]);

    await page.goto("/");

    await expect(page.getByText("Backlog")).toBeVisible();
    const backlogLink = page.getByRole("link", { name: /WEB-17/ });
    await expect(backlogLink).toBeVisible();
    await expect(backlogLink).toHaveAttribute("href", "https://jira.example.com/browse/WEB-17");
    await expect(backlogLink).toHaveAttribute("target", "_blank");
  });

  test("hides backlog category when no available items exist", async ({ page }) => {
    await mockSessions(page, [makeWorkingSession()], DEFAULT_PROJECTS);

    await page.goto("/");

    await expect(page.getByText("Backlog")).toHaveCount(0);
  });
});

// D6b: Footer
test.describe("D6b: Footer clock hydrates cleanly", () => {
  test("no hydration error overlay visible after load", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    // In dev, Next may mount an empty error portal. In production, it may be absent entirely.
    const errorOverlay = page.locator("nextjs-portal");
    if ((await errorOverlay.count()) > 0) {
      await expect(errorOverlay).toContainText(/^$/);
    }
  });

  test("footer contains version text", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");
    // StatusBar footer renders the VersionMenu trigger; label is the daemon version or "dev" when /api/runtime/info is unreachable.
    await expect(page.locator("footer")).toBeVisible();
    await expect(
      page.locator("footer").getByRole("button", { name: "Show Spur version information" }),
    ).toBeVisible();
  });

  test("footer shows healthy GitHub status with the last request timestamp in a tooltip", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.unroute("/api/github-status");
    await mockGitHubStatus(page, {
      ok: true,
      requestedAt: "2026-04-28T10:00:00.000Z",
      configured: true,
    });
    await page.goto("/");

    const githubStatus = page.getByRole("button", { name: "GitHub connection healthy" });
    await expect(githubStatus).toBeVisible();
    await githubStatus.hover();

    await expect(page.getByText("GitHub")).toBeVisible();
    await expect(page.getByText(/Last request:/)).toBeVisible();
  });

  test("footer shows healthy GitLab status with the last request timestamp in a tooltip", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.unroute("/api/gitlab-status");
    await mockGitLabStatus(page, {
      ok: true,
      requestedAt: "2026-04-28T10:00:00.000Z",
      configured: true,
    });
    await page.goto("/");

    const gitlabStatus = page.getByRole("button", { name: "GitLab connection healthy" });
    await expect(gitlabStatus).toBeVisible();
    await gitlabStatus.hover();

    await expect(page.getByText("GitLab")).toBeVisible();
    await expect(page.getByText(/Last request:/)).toBeVisible();
  });

  test("footer keeps the GitHub tooltip pinned after clicking the healthy icon", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.unroute("/api/github-status");
    await mockGitHubStatus(page, {
      ok: true,
      requestedAt: "2026-04-28T10:00:00.000Z",
      configured: true,
    });
    await page.goto("/");

    const githubStatus = page.getByRole("button", { name: "GitHub connection healthy" });
    await githubStatus.click();
    await page.mouse.move(1200, 40);

    await expect(page.getByText("GitHub")).toBeVisible();
    await expect(page.getByText(/Last request:/)).toBeVisible();

    await githubStatus.click();
    await page.mouse.move(1200, 40);
    await expect(page.getByText(/Last request:/)).not.toBeVisible();
  });

  test("footer keeps GitHub and GitLab status buttons icon-only", async ({ page }) => {
    await mockSessions(page, []);
    await page.goto("/");

    await expect(page.getByRole("button", { name: "GitHub connection healthy" })).toHaveText("");
    await expect(page.getByRole("button", { name: "GitLab connection healthy" })).toHaveText("");
  });

  test("footer shows the GitHub error text in a tooltip when the health check fails", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.unroute("/api/github-status");
    await mockGitHubStatus(page, {
      ok: false,
      error: "GitHub API 503",
      requestedAt: "2026-04-28T10:00:00.000Z",
      configured: true,
    });
    await page.goto("/");

    await page.getByRole("button", { name: "GitHub connection error" }).click();
    await expect(page.getByText("GitHub API 503")).toBeVisible();
  });

  test("footer shows auth and unavailable GitHub errors in a tooltip from mocked responses", async ({
    page,
  }) => {
    await mockSessions(page, [
      makeWorkingSession({
        id: "github-pr-session",
        slots: {
          links: [{ label: "github-pr", url: "https://github.com/acme/repo/pull/1" }],
        },
      }),
    ]);
    await page.unroute("/api/github-status");
    await mockGitHubStatus(page, {
      ok: false,
      error: "GitHub auth unavailable",
      requestedAt: null,
      configured: false,
    });
    await page.goto("/");

    await page.getByRole("button", { name: "GitHub connection error" }).click();
    await expect(page.getByText("GitHub auth unavailable")).toBeVisible();

    await page.unroute("/api/github-status");
    await mockGitHubStatus(page, { error: "ignored" }, { status: 503 });
    await page.reload();

    await page.getByRole("button", { name: "GitHub connection error" }).click();
    await expect(page.getByText("GitHub status unavailable (503)")).toBeVisible();
  });

  test("footer shows aggregated healthy tooltip with daemon and resource details", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.route("/api/runtime/resources", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 21,
          memoryPercent: 43,
          diskPercent: 65,
        }),
      });
    });
    await page.goto("/");

    const onlineButton = page.getByRole("button", { name: "Show aggregated system status" });
    await expect(onlineButton).toBeVisible();
    await expect(onlineButton).toHaveAttribute("data-status", "ready");
    await expect(onlineButton.locator("svg")).toBeVisible();
    await onlineButton.click();

    await expect(page.getByText("System")).toBeVisible();
    await expect(page.getByLabel("Daemon online healthy")).toBeVisible();
    await expect(page.getByLabel("CPU 21% healthy")).toBeVisible();
    await expect(page.getByLabel("RAM 43% healthy")).toBeVisible();
    await expect(page.getByLabel("HDD 65% healthy")).toBeVisible();
  });

  test("footer keeps system metrics inside the tooltip when runtime resources are unavailable", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.goto("/");

    const footer = page.locator("footer");
    await expect(footer).not.toContainText(/CPU \d+%/);
    await expect(footer).not.toContainText(/RAM \d+%/);
    await expect(footer).not.toContainText(/DISK \d+%/);

    await page.getByRole("button", { name: "Show aggregated system status" }).click();
    await expect(page.getByLabel("Daemon online healthy")).toBeVisible();
    await expect(page.getByLabel("CPU unavailable unavailable")).toBeVisible();
    await expect(page.getByLabel("RAM unavailable unavailable")).toBeVisible();
    await expect(page.getByLabel("HDD unavailable unavailable")).toBeVisible();
  });

  test("footer syncs warning status text and closes the tooltip after clicking its content", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.route("/api/runtime/resources", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 86,
          memoryPercent: 43,
          diskPercent: 22,
        }),
      });
    });
    await page.goto("/");

    const onlineButton = page.getByRole("button", { name: "Show aggregated system status" });
    await expect(onlineButton).toHaveAttribute("data-status", "attention");
    await onlineButton.click();

    const tooltip = page.getByText("System").locator("..");
    await expect(tooltip).toContainText("Warning");
    await tooltip.click();
    await expect(page.getByText("System")).not.toBeVisible();
  });

  test("footer health tooltip still opens on hover and closes on mouse leave", async ({ page }) => {
    await mockSessions(page, []);
    await page.route("/api/runtime/resources", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 21,
          memoryPercent: 43,
          diskPercent: 65,
        }),
      });
    });
    await page.goto("/");

    const onlineButton = page.getByRole("button", { name: "Show aggregated system status" });
    await onlineButton.hover();
    await expect(page.getByText("System")).toBeVisible();

    await page.mouse.move(0, 0);
    await expect(page.getByText("System")).not.toBeVisible();
  });

  test("footer right side shows a Claude accounts trigger next to the version menu with a count of authenticated accounts", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.route("/api/claude-accounts", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accounts: [
            { id: "acc-ready-01", label: "Work", authenticated: true },
            { id: "acc-idle-02", label: "Home", authenticated: false },
          ],
        }),
      });
    });
    await page.goto("/");

    const footer = page.locator("footer");
    const trigger = footer.getByRole("button", { name: "Manage Claude accounts" });
    const versionMenu = footer.getByRole("button", { name: "Show Spur version information" });
    await expect(trigger).toBeVisible();
    await expect(versionMenu).toBeVisible();

    // Trigger sits in the same right-aligned footer group as the version menu.
    const rightGroup = footer.locator("div.ml-auto");
    await expect(rightGroup.getByRole("button", { name: "Manage Claude accounts" })).toBeVisible();
    await expect(
      rightGroup.getByRole("button", { name: "Show Spur version information" }),
    ).toBeVisible();

    // Count reflects only authenticated accounts (1 of 2) once the list loads.
    await trigger.click();
    await expect(page.getByText("1 ready")).toBeVisible();
    await expect(trigger).toContainText("1");
  });

  test("opening the Claude accounts menu lists each account by label or short id with a ready/not-logged-in badge and a per-account Remove action", async ({
    page,
  }) => {
    await mockSessions(page, []);
    await page.route("/api/claude-accounts", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accounts: [
            { id: "acc-labelled-01", label: "Work", authenticated: true },
            { id: "abcdef1234567890", authenticated: false },
          ],
        }),
      });
    });
    await page.goto("/");

    await page.getByRole("button", { name: "Manage Claude accounts" }).click();

    // Labelled account renders its label with the "ready" badge and a Remove action.
    const labelledRow = page.getByRole("listitem").filter({ hasText: "Work" });
    await expect(labelledRow).toContainText("ready");
    await expect(
      labelledRow.getByRole("button", { name: "Remove Claude account Work" }),
    ).toBeVisible();

    // No label falls back to the first 8 chars of the id, with the "not logged in" badge.
    const shortIdRow = page.getByRole("listitem").filter({ hasText: "abcdef12" });
    await expect(shortIdRow).toContainText("not logged in");
    await expect(
      shortIdRow.getByRole("button", { name: "Remove Claude account abcdef12" }),
    ).toBeVisible();
  });

  test("adding an account posts to /api/claude-accounts/add and opens the login terminal, auto-closing once login-status authenticates", async ({
    page,
  }) => {
    await mockSessions(page, []);

    let loginStatusCalls = 0;
    let finishLoginCalled = false;

    await page.route("/api/claude-accounts", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accounts: [] }),
      });
    });
    await page.route("/api/claude-accounts/add", (route) => {
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          account: { id: "new-1", label: "New", authenticated: false },
          loginTmuxSession: "claude-login-x",
        }),
      });
    });
    await page.route("/api/claude-accounts/new-1/login-status", (route) => {
      loginStatusCalls += 1;
      // First poll is still pending; the next poll reports the account authenticated.
      const authenticated = loginStatusCalls > 1;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated, loginActive: !authenticated }),
      });
    });
    await page.route("/api/claude-accounts/new-1/finish-login", (route) => {
      finishLoginCalled = true;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true }),
      });
    });

    await page.goto("/");

    await page.getByRole("button", { name: "Manage Claude accounts" }).click();
    await page.getByTestId("add-account").click();

    // The login terminal opens on the returned tmux session (session id claude-login-new-1).
    const loginTerminal = page.getByRole("dialog", { name: "Terminal claude-login-new-1" });
    await expect(loginTerminal).toBeVisible();

    // Polling login-status (every LOGIN_POLL_INTERVAL_MS = 3s) flips to authenticated,
    // which finishes login and auto-closes the terminal.
    await expect(loginTerminal).toBeHidden({ timeout: 15_000 });
    expect(finishLoginCalled).toBe(true);
  });
});

test.describe("D6c: Footer touch tooltip dismissal", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await mockSessions(page, []);
    await page.route("/api/runtime/resources", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 86,
          memoryPercent: 43,
          diskPercent: 22,
        }),
      });
    });
    await page.goto("/");
  });

  test("touch tap on tooltip content closes it", async ({ page }) => {
    await page.getByRole("button", { name: "Show aggregated system status" }).tap();
    const tooltip = page.getByText("System").locator("..");
    await expect(tooltip).toContainText("Warning");
    await tooltip.tap();
    await expect(page.getByText("System")).not.toBeVisible();
  });

  test("touch tap outside tooltip closes it", async ({ page }) => {
    await page.getByRole("button", { name: "Show aggregated system status" }).tap();
    await expect(page.getByText("System")).toBeVisible();
    await page.getByPlaceholder("Filter sessions...").tap();
    await expect(page.getByText("System")).not.toBeVisible();
  });

  test("touch tap on the GitHub icon opens the tooltip and tapping outside closes it", async ({
    page,
  }) => {
    await page.unroute("/api/github-status");
    await mockGitHubStatus(page, {
      ok: true,
      requestedAt: "2026-04-28T10:00:00.000Z",
      configured: true,
    });
    await page.reload();

    await page.getByRole("button", { name: "GitHub connection healthy" }).tap();
    await expect(page.getByText("GitHub")).toBeVisible();
    await expect(page.getByText(/Last request:/)).toBeVisible();

    await page.getByPlaceholder("Filter sessions...").tap();
    await expect(page.getByText("GitHub")).not.toBeVisible();
  });

  test("touch tap on the GitLab icon opens the tooltip and tapping outside closes it", async ({
    page,
  }) => {
    await page.unroute("/api/gitlab-status");
    await mockGitLabStatus(page, {
      ok: true,
      requestedAt: "2026-04-28T10:00:00.000Z",
      configured: true,
    });
    await page.reload();

    await page.getByRole("button", { name: "GitLab connection healthy" }).tap();
    await expect(page.getByText("GitLab")).toBeVisible();
    await expect(page.getByText(/Last request:/)).toBeVisible();

    await page.getByPlaceholder("Filter sessions...").tap();
    await expect(page.getByText("GitLab")).not.toBeVisible();
  });
});

// D7: Spawn modal
test.describe("D7: Spawn modal", () => {
  test("clicking Spawn Session button opens modal", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-test-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
  });

  test("modal has project select, agent select, branch input, plan checkbox", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-fields-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();

    // Project select (contains "Select project" option)
    await expect(page.getByRole("option", { name: /select project/i })).toBeAttached();
    // Agent select
    await expect(page.getByRole("combobox", { name: "Spawn agent" })).toBeVisible();
    await expect(page.getByRole("option", { name: "claude" })).toBeAttached();
    await expect(page.getByRole("option", { name: "codex" })).toBeAttached();
    await expect(page.getByRole("option", { name: "cursor" })).toBeAttached();
    // Branch input
    await expect(page.getByLabel("branch name")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Plan" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Self-destruct" })).toBeVisible();
  });

  test("plan toggle stays hint-free for codex", async ({ page }) => {
    await openSpawnModal(page);

    await expect(page.getByText(/codex does not enter a native plan mode/i)).toHaveCount(0);
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption("codex");
    await expect(page.getByText(/codex does not enter a native plan mode/i)).toHaveCount(0);
  });

  test("modal has Spawn button", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-btn-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("button", { name: /^spawn$/i })).toBeVisible();
  });

  test("modal restores a saved prompt from history", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "spur:input-history:spawn-prompt",
        JSON.stringify([
          {
            value: "Re-run the flaky deploy",
            savedAt: "2026-04-17T12:34:56.000Z",
          },
        ]),
      );
    });
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-history-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByText(/^History$/)).toHaveCount(0);
    await page.getByRole("button", { name: /^history$/i }).click();

    await expect(page.getByText("2026-04-17 12:34 UTC")).toBeVisible();
    await page.getByRole("button", { name: /re-run the flaky deploy/i }).click();
    await expect(page.getByPlaceholder("Prompt for the new session...")).toHaveValue(
      "Re-run the flaky deploy",
    );
  });

  test("slash button inserts a suggested command into the spawn prompt", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-slash-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
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
              id: "review",
              label: "/review",
              insertText: "/review",
              detail: "Review the current diff",
              source: "project",
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
    await expect(page.getByRole("button", { name: "Slash", exact: true })).toHaveText("/");
    await page.getByRole("button", { name: "Slash", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "/compactCompact the chat",
      "/reviewReview the current diff",
    ]);
    await expect(page.getByText("Favorites")).toHaveCount(0);
    await page.getByRole("button", { name: "Add favorite /review" }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "/reviewReview the current diff",
      "/compactCompact the chat",
    ]);
    await expect(page.getByText("Favorites")).toBeVisible();
    await expect(page.getByText("Commands")).toBeVisible();
    await page.getByRole("menuitem", { name: /\/compact/i }).click();

    await expect(page.getByPlaceholder("Prompt for the new session...")).toHaveValue("/compact");
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
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-backdrop-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();

    // Click the backdrop (fixed overlay behind the modal)
    await page.mouse.click(10, 10);
    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
  });

  test("Close button closes modal", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-close-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();

    // The Close button
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
  });

  test("Enter in textarea creates newline not submit", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-enter-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
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

  test("spawn prompt clear button resets the textarea", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-clear-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.goto("/");

    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    const textarea = page.getByPlaceholder("Prompt for the new session...");
    await textarea.fill("Prompt to clear");
    await page.getByRole("button", { name: "Clear spawn prompt" }).click();

    await expect(textarea).toHaveValue("");
    await expect(textarea).toBeFocused();
  });

  test("Cmd+Enter in textarea submits spawn request", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-ctrlenter-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );

    // Mock spawn endpoint
    await page.route("**/api/spawn", (route) => {
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(
          makeWorkingSession({
            id: "new-session-id",
            project: "my-project",
            prompt: "Test prompt for ctrl enter",
            status: "spawning",
            state: "working",
            runtimeAlive: false,
            workspaceExists: false,
            worktreePath: "/tmp/worktrees/new-session-id",
          }),
        ),
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
    const projectSelect = page.getByRole("combobox", { name: "Spawn project" });
    await projectSelect.selectOption("my-project");

    const textarea = page.locator("textarea").last();
    await textarea.fill("Test prompt for cmd enter");
    await textarea.press("Meta+Enter");

    // Modal should close after spawn
    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible({
      timeout: 5000,
    });
  });

  test("spawn modal shows the voice shortcut hint when voice is available", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-voice-hint-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );
    await page.route("**/api/runtime/voice", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");

    await expect(page.getByPlaceholder("Prompt for the new session... Voice ⌘ + .")).toBeVisible();
  });

  test("spawn ack failure keeps modal open and preserves prompt", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-fail-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );

    await page.route("**/api/spawn", (route) => {
      void route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Daemon down" }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.locator("select").nth(0).selectOption("my-project");

    const textarea = page.locator("textarea").last();
    await textarea.fill("Keep me");
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
    await expect(textarea).toHaveValue("Keep me");
    await expect(page.getByText(/Daemon down/i)).toBeVisible();
  });

  test("spawn prompt accepts image attachments and forwards them in the request body", async ({
    page,
  }) => {
    let requestBody: Record<string, unknown> | null = null;
    await mockSessions(
      page,
      [makeWorkingSession({ id: "spawn-image-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );

    await page.route("**/api/spawn", async (route) => {
      requestBody = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(
          makeSpawningSession({
            id: "spawn-image-ack-1",
            project: "my-project",
            prompt: "Prompt with image",
          }),
        ),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("button", { name: "Attach file" })).toBeVisible();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    const textarea = page.getByPlaceholder("Prompt for the new session...");
    await textarea.fill("Prompt with image");
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["PNG"], "spawn.png", { type: "image/png" }));
      return dt;
    });
    await textarea.dispatchEvent("drop", { dataTransfer });

    await expect(page.locator('img[alt="spawn.png"]')).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible({
      timeout: 5000,
    });
    expect(requestBody).toMatchObject({
      projectId: "my-project",
      prompt: "Prompt with image",
      attachments: [{ name: "spawn.png", data: expect.any(String) }],
    });
  });
});

// D7b: Silent branch preflight
test.describe("D7b: Silent branch preflight", () => {
  test("preflight called and branch input auto-populated", async ({ page }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "preflight-1", project: "my-project" })],
      [{ id: "my-project", name: "my-project" }],
    );

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
    const projectSelect = page.getByRole("combobox", { name: "Spawn project" });
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

// D7d: Branch name normalization
test.describe("D7d: Branch name normalization", () => {
  test("typing a name shows the normalized preview", async ({ page }) => {
    await openSpawnModal(page, [
      makeWorkingSession({ id: "branch-preview-1", project: "my-project" }),
    ]);

    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    await page.getByLabel("branch name").fill("Test 2");

    await expect(page.getByText("will create test-2")).toBeVisible();
  });

  test("existing local branch shows the attach hint", async ({ page }) => {
    await page.route("**/api/projects/my-project/branches/exists**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: true, remote: false, checkedOutAt: null }),
      });
    });
    await openSpawnModal(page, [
      makeWorkingSession({ id: "branch-attach-1", project: "my-project" }),
    ]);

    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    await page.getByLabel("branch name").fill("feature/existing");

    await expect(
      page.getByText("branch already exists — will attach instead of creating new"),
    ).toBeVisible({ timeout: 2000 });
  });

  test("checked-out branch shows a warning with the worktree path", async ({ page }) => {
    await page.route("**/api/projects/my-project/branches/exists**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          exists: true,
          remote: false,
          checkedOutAt: "/tmp/worktrees/feature-busy",
        }),
      });
    });
    await openSpawnModal(page, [
      makeWorkingSession({ id: "branch-busy-1", project: "my-project" }),
    ]);

    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    await page.getByLabel("branch name").fill("feature/busy");

    await expect(
      page.getByText(
        "already checked out in another worktree — spawn will fail; pick a different name",
      ),
    ).toBeVisible({ timeout: 2000 });
  });

  test("remote-only branch shows the track hint", async ({ page }) => {
    await page.route("**/api/projects/my-project/branches/exists**", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: false, remote: true, checkedOutAt: null }),
      });
    });
    await openSpawnModal(page, [
      makeWorkingSession({ id: "branch-remote-1", project: "my-project" }),
    ]);

    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    await page.getByLabel("branch name").fill("feature/remote");

    await expect(page.getByText("exists on origin — will track it")).toBeVisible({ timeout: 2000 });
  });

  test("garbage branch clears on blur and spawn fires without a branch", async ({ page }) => {
    let requestBody: Record<string, unknown> | null = null;
    const sessions = [makeWorkingSession({ id: "branch-garbage-1", project: "my-project" })];
    await page.route("**/api/spawn", async (route) => {
      requestBody = (route.request().postDataJSON() as Record<string, unknown>) ?? null;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(
          makeSpawningSession({ id: "branch-garbage-ack-1", project: "my-project" }),
        ),
      });
    });
    await openSpawnModal(page, sessions);

    await fillSpawnForm(page, { project: "my-project", prompt: "Spawn without branch" });
    await page.getByLabel("branch name").fill("!!!");
    await page.getByPlaceholder("Prompt for the new session...").click();
    await expect(page.getByLabel("branch name")).toHaveValue("");

    const spawnBtn = page.getByRole("button", { name: /^spawn$/i });
    await expect(spawnBtn).toBeEnabled();
    await spawnBtn.click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    expect(requestBody).not.toBeNull();
    expect(requestBody).not.toHaveProperty("branch");
  });

  test("blur normalizes the branch input in place", async ({ page }) => {
    await openSpawnModal(page, [
      makeWorkingSession({ id: "branch-blur-1", project: "my-project" }),
    ]);

    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
    await page.getByLabel("branch name").fill("feature/X Y Z");
    await page.getByPlaceholder("Prompt for the new session...").click();

    await expect(page.getByLabel("branch name")).toHaveValue("feature/x-y-z");
  });
});

test.describe("D7c: Background spawn lifecycle", () => {
  test("all-projects view keeps filter and URL unchanged while showing the placeholder immediately", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-ack-1",
      project: "other-project",
      prompt: "Background placeholder session",
      branch: "feature/background-placeholder",
      tmuxSession: "spawn-bg-ack-1",
      worktreePath: "/tmp/worktrees/spawn-bg-ack-1",
    });
    const sessions: SpurSessionView[] = [];
    const projects = [
      { id: "my-project", name: "my-project" },
      { id: "other-project", name: "other-project" },
    ];

    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions, projects);
    await fillSpawnForm(page, { project: "other-project", prompt: placeholder.prompt });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    await expect(page.getByRole("link", { name: placeholder.prompt })).toBeVisible();
    await expect(page.getByRole("button", { name: /Project filter:/ })).toContainText(
      "All Projects",
    );
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Open web terminal for ${placeholder.id}`, "i"),
      }),
    ).toBeDisabled();
  });

  test("matching project filter keeps the URL and still shows the placeholder", async ({
    page,
  }) => {
    const currentSession = makeWorkingSession({
      id: "spawn-filter-match-1",
      project: "my-project",
      prompt: "Current filtered session",
    });
    const placeholder = makeSpawningSession({
      id: "spawn-filter-match-ack-1",
      project: "my-project",
      prompt: "Matching project placeholder",
      branch: "feature/matching-filter",
      tmuxSession: "spawn-filter-match-ack-1",
      worktreePath: "/tmp/worktrees/spawn-filter-match-ack-1",
    });
    const sessions: SpurSessionView[] = [currentSession];

    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder, currentSession);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await mockSessions(page, () => sessions, [
      { id: "my-project", name: "my-project" },
      { id: "other-project", name: "other-project" },
    ]);
    await page.goto("/?project=my-project");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();

    await fillSpawnForm(page, { project: "my-project", prompt: placeholder.prompt });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    await expect(page.getByRole("link", { name: placeholder.prompt })).toBeVisible();
    await expect(page.getByRole("button", { name: /Project filter:/ })).toContainText("my-project");
    await expect(page).toHaveURL(/\/\?project=my-project$/);
  });

  test("mismatched project filter keeps the current list and hides the spawned placeholder", async ({
    page,
  }) => {
    const currentSession = makeWorkingSession({
      id: "spawn-filter-mismatch-1",
      project: "my-project",
      prompt: "Current filtered session",
    });
    const placeholder = makeSpawningSession({
      id: "spawn-filter-mismatch-ack-1",
      project: "other-project",
      prompt: "Hidden by current filter",
      branch: "feature/mismatched-filter",
      tmuxSession: "spawn-filter-mismatch-ack-1",
      worktreePath: "/tmp/worktrees/spawn-filter-mismatch-ack-1",
    });
    const sessions: SpurSessionView[] = [currentSession];

    await page.route("**/api/spawn", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await mockSessions(page, () => sessions, [
      { id: "my-project", name: "my-project" },
      { id: "other-project", name: "other-project" },
    ]);
    await page.goto("/?project=my-project");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();

    await fillSpawnForm(page, { project: "other-project", prompt: placeholder.prompt });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    await expect(page.getByText(currentSession.prompt)).toBeVisible();
    await expect(page.getByRole("link", { name: placeholder.prompt })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Project filter:/ })).toContainText("my-project");
    await expect(page).toHaveURL(/\/\?project=my-project$/);
  });

  test("successful spawn sends the full form payload, resets non-project fields, and remembers the last selected project", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-payload-1",
      project: "other-project",
      prompt: "Carry the selected options into the background shell",
      branch: "feature/spawn-payload",
      tmuxSession: "spawn-bg-payload-1",
      worktreePath: "/tmp/worktrees/spawn-bg-payload-1",
    });
    const projects = [
      { id: "my-project", name: "my-project" },
      { id: "other-project", name: "other-project" },
    ];
    const requests: unknown[] = [];
    const sessions: SpurSessionView[] = [];

    await page.route("**/api/spawn", async (route) => {
      requests.push(route.request().postDataJSON());
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions, projects);
    await fillSpawnForm(page, {
      project: "other-project",
      prompt: placeholder.prompt,
      branch: "feature/spawn-payload",
      workspaceMode: "worktree",
      baseBranch: "main",
      planMode: true,
      selfDestruct: true,
      selfDestructConditions: "After the summary is posted",
      steps: ["Audit the repository", "Implement the retry flow"],
    });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    expect(requests).toEqual([
      {
        projectId: "other-project",
        prompt: placeholder.prompt,
        agent: "claude",
        branch: "feature/spawn-payload",
        planMode: true,
        steps: ["Audit the repository", "Implement the retry flow"],
        overrides: {
          worktree: true,
          defaultBranch: "main",
        },
        selfDestruct: {
          enabled: true,
          conditions: "After the summary is posted",
        },
      },
    ]);

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByPlaceholder("Prompt for the new session...")).toHaveValue("");
    await expect(page.getByLabel("branch name")).toHaveValue("");
    await expect(page.getByRole("combobox", { name: "workspace mode" })).toHaveValue("default");
    await expect(page.getByRole("checkbox", { name: "Plan" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Self-destruct" })).not.toBeChecked();
    await expect(page.getByLabel("Self-destruct conditions")).toHaveCount(0);
    await expect(page.getByLabel(/step 1/i)).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Spawn project" })).toHaveValue(
      "other-project",
    );
  });

  test("double-clicking Spawn while the request is in flight still sends only one spawn request", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-single-shot-1",
      project: "my-project",
      prompt: "Single request only",
      branch: "feature/single-shot",
      tmuxSession: "spawn-bg-single-shot-1",
      worktreePath: "/tmp/worktrees/spawn-bg-single-shot-1",
    });
    const sessions: SpurSessionView[] = [];
    let spawnCalls = 0;
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    await page.route("**/api/spawn", async (route) => {
      spawnCalls += 1;
      await responseGate;
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, { prompt: placeholder.prompt });

    const spawnButton = page.getByRole("button", { name: /^spawn$/i });
    await spawnButton.dblclick();

    await expect.poll(() => spawnCalls).toBe(1);

    releaseResponse();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    await expect(page.getByRole("link", { name: placeholder.prompt })).toBeVisible();
  });

  test("spawn without a prompt skips preflight, closes early, and creates the session shell", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-no-prompt-1",
      project: "my-project",
      prompt: "",
      branch: "feature/no-prompt-shell",
      tmuxSession: "spawn-bg-no-prompt-1",
      worktreePath: "/tmp/worktrees/spawn-bg-no-prompt-1",
    });
    const sessions: SpurSessionView[] = [];
    let preflightCalls = 0;

    await page.route("**/api/preflight", async (route) => {
      preflightCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ branch: "feature/unexpected-preflight" }),
      });
    });
    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, {});
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "No Prompt Shell" })).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test("placeholder survives a reload and becomes attachable after the background poll observes success", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-poll-1",
      project: "my-project",
      prompt: "Poll me into running",
      branch: "feature/poll-me",
      tmuxSession: "spawn-bg-poll-1",
      worktreePath: "/tmp/worktrees/spawn-bg-poll-1",
    });
    const running = makeWorkingSession({
      ...placeholder,
      runtimeAlive: true,
      workspaceExists: true,
      status: "running",
      state: "working",
    });
    const sessions: SpurSessionView[] = [];

    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, { prompt: placeholder.prompt });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("link", { name: placeholder.prompt })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: placeholder.prompt })).toBeVisible();

    sessions.splice(0, sessions.length, running);
    await page.waitForTimeout(DASHBOARD_POLL_WAIT_MS);

    await expect(
      page.getByRole("button", { name: new RegExp(`Open web terminal for ${running.id}`, "i") }),
    ).not.toBeDisabled();
  });

  test("background retries do not create duplicate session cards when the same shell eventually succeeds", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-retry-1",
      project: "my-project",
      prompt: "Retry this shell without duplicates",
      branch: "feature/retry-shell",
      tmuxSession: "spawn-bg-retry-1",
      worktreePath: "/tmp/worktrees/spawn-bg-retry-1",
    });
    const running = makeWorkingSession({
      ...placeholder,
      runtimeAlive: true,
      workspaceExists: true,
      status: "running",
      state: "working",
    });
    const sessions: SpurSessionView[] = [];

    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, { prompt: placeholder.prompt });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    await expect(page.getByRole("link", { name: placeholder.prompt })).toHaveCount(1);
    sessions.splice(0, sessions.length, running);
    await page.waitForTimeout(DASHBOARD_POLL_WAIT_MS);

    await expect(page.getByRole("link", { name: placeholder.prompt })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: new RegExp(`Open web terminal for ${running.id}`, "i") }),
    ).not.toBeDisabled();
  });

  test("a fully failed background spawn leaves one errored session card and no duplicate shell", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-error-1",
      project: "my-project",
      prompt: "Fail this shell after retries",
      branch: "feature/fail-after-retries",
      tmuxSession: "spawn-bg-error-1",
      worktreePath: "/tmp/worktrees/spawn-bg-error-1",
    });
    const errored = {
      ...placeholder,
      status: "errored" as const,
      state: "error" as const,
      workspaceExists: true,
      error: "tmux boom after retries",
    };
    const sessions: SpurSessionView[] = [];

    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, { prompt: placeholder.prompt });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    sessions.splice(0, sessions.length, errored);
    await page.waitForTimeout(DASHBOARD_POLL_WAIT_MS);

    await expect(page.getByRole("link", { name: placeholder.prompt })).toHaveCount(1);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Restore session ${placeholder.id}`, "i"),
      }),
    ).not.toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Open web terminal for ${placeholder.id}`, "i"),
      }),
    ).toHaveCount(0);
  });

  test("an explicit occupied branch fails in place without creating a duplicate session card", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-branch-conflict-1",
      project: "my-project",
      prompt: "Use the occupied branch",
      branch: "feature/already-checked-out",
      tmuxSession: "spawn-bg-branch-conflict-1",
      worktreePath: "/tmp/worktrees/spawn-bg-branch-conflict-1",
    });
    const errored = {
      ...placeholder,
      status: "errored" as const,
      state: "error" as const,
      error: 'branch "feature/already-checked-out" is already checked out',
    };
    const sessions: SpurSessionView[] = [];

    await page.route("**/api/spawn", async (route) => {
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, {
      prompt: placeholder.prompt,
      workspaceMode: "worktree",
      baseBranch: "main",
      branch: placeholder.branch,
    });
    await page.getByRole("button", { name: /^spawn$/i }).click();

    sessions.splice(0, sessions.length, errored);
    await page.waitForTimeout(DASHBOARD_POLL_WAIT_MS);

    await expect(page.getByRole("link", { name: placeholder.prompt })).toHaveCount(1);
    await expect(page.locator(".data-row").filter({ hasText: placeholder.branch })).toHaveCount(1);
  });

  test("the user can retry manually after an ack failure without losing content or creating duplicate cards", async ({
    page,
  }) => {
    const placeholder = makeSpawningSession({
      id: "spawn-bg-manual-retry-1",
      project: "my-project",
      prompt: "Keep this content through a manual retry",
      branch: "feature/manual-retry",
      tmuxSession: "spawn-bg-manual-retry-1",
      worktreePath: "/tmp/worktrees/spawn-bg-manual-retry-1",
    });
    const sessions: SpurSessionView[] = [];
    let spawnCalls = 0;

    await page.route("**/api/spawn", async (route) => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "Daemon down" }),
        });
        return;
      }
      sessions.splice(0, sessions.length, placeholder);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(placeholder),
      });
    });

    await openSpawnModal(page, () => sessions);
    await fillSpawnForm(page, {
      prompt: placeholder.prompt,
      branch: placeholder.branch,
      workspaceMode: "shared",
      planMode: true,
    });

    const spawnButton = page.getByRole("button", { name: /^spawn$/i });
    const promptField = page.getByPlaceholder("Prompt for the new session...");

    await spawnButton.click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
    await expect(promptField).toHaveValue(placeholder.prompt);
    await expect(page.getByLabel("branch name")).toHaveValue(placeholder.branch);
    await expect(page.getByRole("combobox", { name: "workspace mode" })).toHaveValue("shared");
    await expect(page.getByRole("checkbox", { name: "Plan" })).toBeChecked();
    await expect(page.getByText(/daemon down/i)).toBeVisible();

    await spawnButton.click();

    await expect(page.getByRole("heading", { name: /spawn session/i })).not.toBeVisible();
    await expect(page.getByRole("link", { name: placeholder.prompt })).toHaveCount(1);
    expect(spawnCalls).toBe(2);
  });
});

// D7d: Sessions list cache on revisit
test.describe("D7d: Sessions list cache on revisit", () => {
  test("Dashboard sessions cache survives navigation", async ({ page }) => {
    const session = makeWorkingSession({
      id: "cache-survive-1",
      prompt: "Cached session row",
    });
    await mockSessions(page, [session]);
    await page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });

    await page.goto("/");
    await expect(page.getByText("Loading sessions...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("link", { name: session.prompt })).toBeVisible();

    // Delay any subsequent /api/sessions call so that, if the dashboard were to
    // refetch on revisit, the loader would be visible long enough for the
    // synchronous assertion below to catch it.
    await page.route("**/api/sessions*", async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.fallback();
    });

    await page.getByRole("link", { name: session.prompt }).first().click();
    await expect(page.getByRole("link", { name: /back/i })).toBeVisible();

    await page.getByRole("link", { name: /back/i }).click();

    await expect(page.getByText("Loading sessions...")).toHaveCount(0);
    await expect(page.getByRole("link", { name: session.prompt })).toBeVisible();
  });
});
