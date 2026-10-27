import { test, expect, type Page, mockSessions, type ProjectInfo } from "./fixtures.js";
import type { CronJobsResponse } from "../src/lib/types";

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
