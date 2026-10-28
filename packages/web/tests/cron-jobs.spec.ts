import { test, expect, type Page, mockSessions, type ProjectInfo } from "./fixtures.js";
import type { CronJobEditDraft, CronJobEditUpdate, CronJobsResponse } from "../src/lib/types";

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
  // pointer left on the clock, hover-opening the Claude accounts popover.
  await page.route("**/api/claude-accounts", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accounts: [] }),
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
  return urls;
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
  test("saves disk drafts, preserves defaults and reopens saved values while runtime stays unchanged", async ({
    page,
  }) => {
    await mockSessions(page, [], PROJECTS);
    await mockCron(page);
    let draft = structuredClone(EDIT_DRAFT);
    await page.route("**/api/cron/edit?**", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as CronJobEditUpdate;
        expect(body.blocks[1]?.agent).toBeNull();
        expect(body.blocks[0]?.model).toBe("custom-unlisted");
        draft = { ...draft, ...body, revision: "b".repeat(64) };
        await route.fulfill({ json: { ...draft, saved: true, activation: "pending" } });
      } else await route.fulfill({ json: draft });
    });
    await openEditor(page);
    await expect(page.getByLabel("Schedule")).toHaveValue("0 5 * * *");
    await expect(page.getByText(/schedule affects: audit, sibling/)).toBeVisible();
    await page.getByLabel("Block 2 prompt").fill("Saved second prompt");
    await page.getByRole("button", { name: "Save YAML" }).click();
    await expect(page.getByText("Saved to YAML. Pending activation.")).toBeVisible();
    await page.getByRole("button", { name: "Back to cron jobs" }).click();
    await expect(page.getByText("Audit errored sessions")).toBeVisible();
    await page.getByRole("button", { name: "Edit YAML" }).click();
    await expect(page.getByLabel("Block 2 prompt")).toHaveValue("Saved second prompt");
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
    await expect(page.getByRole("alert")).toContainText("Config file changed");
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
    await expect(page.getByRole("alert")).toContainText("Invalid cron schedule.");
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
