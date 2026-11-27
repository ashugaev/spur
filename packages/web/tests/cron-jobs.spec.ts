import { test, expect, type Page, mockSessions, type ProjectInfo } from "./fixtures.js";
import type {
  CronJobEditDraft,
  CronJobEditUpdate,
  CronJobsResponse,
  CronStorageView,
} from "../src/lib/types";

const PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

const CRON: CronJobsResponse = {
  eventsSince: "2026-10-20T00:00:00.000Z",
  projects: [
    {
      projectId: "my-project",
      projectName: "my-project",
      owner: {
        state: "loaded",
        path: "/repo/my-project/spur.yaml",
        revision: "abc",
        changed: true,
      },
      sources: [
        {
          sourceId: "nightly",
          schedule: "0 3 * * *",
          runOnStart: false,
          disk: "changed",
          recentTicks: ["2026-10-27T03:00:00.000Z"],
          triggers: [
            {
              triggerId: "audit",
              event: "cron:tick",
              disk: "same",
              action: {
                kind: "spawn",
                blocks: [
                  {
                    prompt: "Audit errored sessions",
                    agent: "claude",
                    model: "opus",
                    reasoningEffort: "high",
                    mode: null,
                  },
                ],
              },
              recentActions: [
                {
                  at: "2026-10-27T03:00:02.000Z",
                  event: "trigger.spawn.completed",
                  sessionId: "my-project-412",
                  message: null,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function mockCron(
  page: Page,
  response: { status: number; body: unknown } = { status: 200, body: CRON },
): Promise<string[]> {
  const urls: string[] = [];
  // The content-width version label can shift the footer cluster under the
  // pointer left on the clock, hover-opening the agent accounts popover.
  await page.route("**/api/auth-accounts", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accounts: [], pools: {} }),
    });
  });
  await page.route("**/api/cron**", async (route) => {
    urls.push(route.request().url());
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
  await mockStorage(page, EMPTY_STORAGE);
  return urls;
}

const EMPTY_STORAGE: CronStorageView = {
  note: "",
  noteUpdatedAt: null,
  files: [],
  totalBytes: 0,
  updatedAt: null,
  truncated: false,
};

const FILLED_STORAGE: CronStorageView = {
  note: "Last run: 14 issues triaged",
  noteUpdatedAt: "2026-10-27T03:05:00.000Z",
  files: [
    {
      id: "triage.md",
      name: "triage.md",
      size: 4198,
      mimeType: "text/markdown",
      kind: "text",
      origin: "intentional",
      createdAt: "2026-10-27T03:05:00.000Z",
      updatedAt: "2026-10-27T03:05:00.000Z",
    },
  ],
  totalBytes: 4198,
  updatedAt: "2026-10-27T03:05:00.000Z",
  truncated: false,
};

// Registered after the cron list route, so it wins for storage URLs. Keeps note writes
// and clears in memory; returns the request methods seen.
async function mockStorage(page: Page, initial: CronStorageView): Promise<string[]> {
  let view = structuredClone(initial);
  const methods: string[] = [];
  await page.route("**/api/cron/storage/**", async (route) => {
    const method = route.request().method();
    methods.push(method);
    if (method === "PATCH") {
      const { note } = route.request().postDataJSON() as { note: string };
      view = { ...view, note, noteUpdatedAt: new Date().toISOString() };
    } else if (method === "DELETE") {
      view = structuredClone(EMPTY_STORAGE);
    }
    await route.fulfill({ json: view });
  });
  return methods;
}

async function openStorage(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Cron jobs" }).click();
  await page.getByRole("button", { name: /audit/ }).click();
  return page
    .getByRole("dialog", { name: "Cron" })
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Storage" }),
    });
}

test.describe("Cron jobs modal", () => {
  test("footer clock opens the cron list, expands a row and closes on Escape", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    await page.getByRole("button", { name: "Cron jobs" }).click();
    const dialog = page.getByRole("dialog", { name: "Cron" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("audit")).toBeVisible();
    await expect(dialog.getByText("spur.yaml changed on disk, not loaded")).toBeVisible();
    await expect(dialog.getByText("Last tick")).toBeVisible();

    await dialog.getByText("audit").click();
    await expect(dialog.getByText("Settings")).toBeVisible();
    await expect(dialog.getByText("Recent runs")).toBeVisible();
    await expect(dialog.getByText("Cron tick")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("toggles a row with Enter and Space on its button", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Cron jobs" }).click();
    const toggle = page.getByRole("button", { name: /audit/ });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("inherits the dashboard project filter", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    const urls = await mockCron(page);
    await page.goto("/?project=my-project");
    await page.getByRole("button", { name: "Cron jobs" }).click();
    await expect(page.getByRole("dialog", { name: "Cron" }).getByText("audit")).toBeVisible();
    expect(new URL(urls[0] ?? "http://x").searchParams.get("project")).toBe("my-project");
  });

  test("shows the error state when the daemon request fails", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page, { status: 502, body: { error: "down" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Cron jobs" }).click();
    await expect(page.getByText("Could not load cron jobs")).toBeVisible();
  });

  test("stacks rows on two lines on mobile", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "Cron jobs" }).click();
    const dialog = page.getByRole("dialog", { name: "Cron" });
    await expect(dialog.getByText("audit")).toBeVisible();
    await expect(dialog.getByText(/^0 3 \* \* \* · /)).toBeVisible();
    await expect(dialog.getByText("Last tick")).toBeHidden();
  });

  test("does not request cron jobs until the modal opens", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    const urls = await mockCron(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Cron jobs" })).toBeVisible();
    expect(urls).toEqual([]);
  });
});

const EDIT_DRAFT: CronJobEditDraft = {
  projectId: "my-project",
  sourceId: "nightly",
  triggerId: "audit",
  ownerPath: "/repo/my-project/spur.yaml",
  revision: "a".repeat(64),
  schedule: "0 5 * * *",
  sourceTriggerIds: ["audit", "sibling"],
  blocks: [
    { prompt: "Disk prompt", agent: "claude", model: "custom-unlisted", reasoningEffort: "high" },
    { prompt: "Second disk prompt", agent: null, model: null, reasoningEffort: null },
  ],
};

async function openEditor(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Cron jobs" }).click();
  await page.getByRole("button", { name: /audit/ }).click();
  await page.getByRole("button", { name: "Edit YAML" }).click();
  await expect(page.getByLabel("Block 1 prompt")).toBeVisible();
}

test.describe("Cron YAML editor", () => {
  test("saves disk drafts, preserves defaults and reopens saved values", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    let draft = structuredClone(EDIT_DRAFT);
    await page.route("**/api/cron/edit?**", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as CronJobEditUpdate;
        expect(body.blocks[1]?.agent).toBeNull();
        expect(body.blocks[0]?.model).toBe("custom-unlisted");
        draft = { ...draft, ...body, revision: "b".repeat(64) };
        await route.fulfill({ json: { ...draft, saved: true, activation: "applied" } });
      } else await route.fulfill({ json: draft });
    });
    await openEditor(page);
    await expect(page.getByLabel("Schedule")).toHaveValue("0 5 * * *");
    await expect(page.getByText(/schedule affects: audit, sibling/)).toBeVisible();
    await page.getByLabel("Block 2 prompt").fill("Saved second prompt");
    await page.getByRole("button", { name: "Save YAML" }).click();
    await expect(page.getByText("Saved and applied.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Saved and applied" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Saved and applied" })).toBeInViewport({
      ratio: 1,
    });
    await page.getByRole("button", { name: "Back to cron jobs" }).click();
    await expect(page.getByText("Audit errored sessions")).toBeVisible();
    await page.getByRole("button", { name: "Edit YAML" }).click();
    await expect(page.getByLabel("Block 2 prompt")).toHaveValue("Saved second prompt");
  });

  test("shows the reload failure and keeps draft values", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    await page.route("**/api/cron/edit?**", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as CronJobEditUpdate;
        await route.fulfill({
          json: {
            ...EDIT_DRAFT,
            ...body,
            revision: "b".repeat(64),
            saved: true,
            activation: "failed",
          },
        });
      } else await route.fulfill({ json: EDIT_DRAFT });
    });
    await openEditor(page);
    await page.getByLabel("Block 2 prompt").fill("Kept prompt");
    await page.getByRole("button", { name: "Save YAML" }).click();
    await expect(
      page.getByText("Saved to YAML. Not applied: reload failed. Restart the daemon to apply."),
    ).toBeVisible();
    await expect(page.getByLabel("Block 2 prompt")).toHaveValue("Kept prompt");
  });

  test("preserves conflicted text and requires discard before reloading", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    let reads = 0;
    await page.route("**/api/cron/edit?**", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 409,
          json: { error: "Config file changed. Reload before saving.", code: "config_changed" },
        });
      } else {
        reads += 1;
        await route.fulfill({
          json: reads === 1 ? EDIT_DRAFT : { ...EDIT_DRAFT, schedule: "0 7 * * *" },
        });
      }
    });
    await openEditor(page);
    await page.getByLabel("Block 1 prompt").fill("Keep conflicted text");
    await page.getByRole("button", { name: "Save YAML" }).click();
    const alert = page.getByRole("dialog").getByRole("alert");
    await expect(alert).toContainText("Config file changed");
    await expect(alert).toBeFocused();
    await expect(page.getByRole("button", { name: "Reload YAML" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Save YAML" })).toBeDisabled();
    await expect(page.getByLabel("Block 1 prompt")).toHaveValue("Keep conflicted text");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Reload YAML" }).click();
    await expect(page.getByLabel("Block 1 prompt")).toHaveValue("Keep conflicted text");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload YAML" }).click();
    await expect(page.getByLabel("Schedule")).toHaveValue("0 7 * * *");
    await expect(page.getByLabel("Block 1 prompt")).toHaveValue("Disk prompt");
  });

  test("keeps mobile validation readable and guards keyboard dismissal", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/cron/edit?**", async (route) => {
      await route.fulfill(
        route.request().method() === "PATCH"
          ? { status: 422, json: { error: "Invalid cron schedule.", field: "schedule" } }
          : { json: EDIT_DRAFT },
      );
    });
    await openEditor(page);
    await page.getByLabel("Schedule").fill("invalid cron");
    await page.getByRole("button", { name: "Save YAML" }).click();
    const alert = page.getByRole("dialog").getByRole("alert");
    await expect(alert).toContainText("Invalid cron schedule.");
    await expect(alert).toBeFocused();
    await expect(alert).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel("Schedule")).toHaveAttribute("aria-invalid", "true");
    const overflow = await page
      .getByRole("dialog")
      .locator("form")
      .evaluate((form) => form.scrollWidth > form.clientWidth);
    expect(overflow).toBe(false);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Schedule")).toHaveValue("invalid cron");
    page.once("dialog", (dialog) => dialog.accept());
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Edit YAML" })).toBeFocused();
  });
});

test.describe("Cron job storage", () => {
  test("starts collapsed with file count, toggles and saves the note", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    const methods = await mockStorage(page, FILLED_STORAGE);
    const storage = await openStorage(page);
    await expect(storage.getByText("1 file · 4.1 KB")).toBeVisible();
    await expect(storage.getByRole("cell", { name: "triage.md" })).toBeVisible();
    const toggle = storage.getByRole("button", { name: "Note" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(storage.getByLabel("Storage note")).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const note = storage.getByLabel("Storage note");
    await expect(note).toHaveValue("Last run: 14 issues triaged");
    await expect(storage.getByRole("button", { name: "Save" })).toBeDisabled();
    await note.fill("Next run: recheck #12");
    await expect(storage.getByText("Unsaved changes")).toBeVisible();
    await storage.getByRole("button", { name: "Save" }).click();
    await expect(storage.getByText("Updated just now")).toBeVisible();
    await expect(storage.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(methods).toContain("PATCH");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("renders empty storage with Add note and no trash", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    const storage = await openStorage(page);
    await expect(storage.getByText("Empty")).toBeVisible();
    await expect(storage.getByRole("button", { name: "Clear storage" })).toHaveCount(0);
    await expect(storage.getByRole("table")).toHaveCount(0);
    await storage.getByRole("button", { name: "Add note" }).click();
    await expect(storage.getByLabel("Storage note")).toHaveValue("");
    await expect(storage.getByText("Later runs read this note")).toBeVisible();
  });

  test("clear asks inline; Cancel restores and Delete empties storage", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    const methods = await mockStorage(page, FILLED_STORAGE);
    const storage = await openStorage(page);
    await storage.getByRole("button", { name: "Clear storage" }).click();
    await expect(storage.getByText("Delete note and 1 file?")).toBeVisible();
    await storage.getByRole("button", { name: "Cancel" }).click();
    await expect(storage.getByText("Delete note and 1 file?")).toBeHidden();
    await expect(storage.getByText("1 file · 4.1 KB")).toBeVisible();
    expect(methods).not.toContain("DELETE");

    await storage.getByRole("button", { name: "Clear storage" }).click();
    await storage.getByRole("button", { name: "Delete" }).click();
    await expect(storage.getByText("Empty")).toBeVisible();
    await expect(storage.getByRole("button", { name: "Add note" })).toBeVisible();
    await expect(storage.getByRole("button", { name: "Clear storage" })).toHaveCount(0);
    expect(methods).toContain("DELETE");
  });
});
