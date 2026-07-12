import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "playwright/test";
import {
  makeCompletedSession,
  makeWorkingSession,
  mockSessions,
  type ProjectInfo,
} from "./fixtures.js";

const ARTIFACTS_DIR = process.env.SPUR_SESSION_ARTIFACTS_DIR ?? "screenshots";
const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];
const SHEPHERD_PROJECTS: ProjectInfo[] = [
  {
    id: "spur-shepherd",
    name: "Shepherd",
    kind: "shepherd",
    prefix: "shp",
    path: "/tmp/spur-data/shepherd",
  },
];

mkdirSync(ARTIFACTS_DIR, { recursive: true });

async function mockModels(page: Page): Promise<void> {
  await page.route(/\/api\/models\?agent=.*/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [{ id: "claude-opus", label: "Claude Opus" }],
      }),
    });
  });
}

async function mockSlashCommands(page: Page): Promise<void> {
  await page.route("**/slash-commands?*", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ commands: [], skills: [], agents: [] }),
    });
  });
}

function modalShot(page: Page, heading: RegExp | string, name: string) {
  return page
    .getByRole("heading", { name: heading })
    .locator("xpath=ancestor::div[contains(@class,'shadow')][1]")
    .screenshot({ path: join(ARTIFACTS_DIR, name) });
}

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  return page.route(`**/api/sessions/${session.id}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

test.describe("spawn modal capture", () => {
  test("desktop spawn, shepherd, respawn, and desk modals", async ({ page }) => {
    await mockModels(page);
    await mockSlashCommands(page);
    await mockSessions(
      page,
      [makeWorkingSession({ id: "capture-spawn-1", project: "my-project" })],
      DEFAULT_PROJECTS,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
    await modalShot(page, /spawn session/i, "spawn-modal-01-desktop-spawn.png");

    await page.getByRole("button", { name: "✕" }).click();
    await mockSessions(page, [], SHEPHERD_PROJECTS);
    await page.reload();
    await page.getByRole("button", { name: "Spawn Shepherd" }).click();
    await expect(page.getByRole("combobox", { name: "Spawn project" })).toHaveValue(
      "spur-shepherd",
    );
    await modalShot(page, /spawn session/i, "spawn-modal-02-shepherd-spawn.png");

    const respawnSession = makeCompletedSession({
      id: "capture-respawn-1",
      project: "my-project",
      prompt: "Retry with screenshot",
    });
    await mockSessionDetail(page, respawnSession);
    await page.goto(`/sessions/${respawnSession.id}`);
    await page.getByRole("button", { name: /edit & respawn/i }).click();
    await expect(page.getByRole("combobox", { name: "Respawn agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Respawn model" })).toBeVisible();
    await modalShot(page, "Edit & Respawn", "spawn-modal-03-respawn-layout.png");
    await expect(page.getByRole("button", { name: "Slash" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^respawn$/i })).toContainText("⌘ + ⏎");
    await modalShot(page, "Edit & Respawn", "spawn-modal-04-respawn-footer.png");

    const deskSession = makeWorkingSession({
      id: "capture-desk-1",
      project: "my-project",
      worktree: true,
    });
    await mockSessionDetail(page, deskSession);
    await page.goto(`/sessions/${deskSession.id}`);
    await page.getByRole("button", { name: /^desk agent$/i }).click();
    const deskModal = page
      .getByRole("heading", { name: "Desk agent" })
      .locator("xpath=ancestor::div[contains(@class,'shadow')][1]");
    await expect(deskModal.getByRole("button", { name: "Slash" })).toBeVisible();
    await expect(deskModal.getByRole("button", { name: /^spawn$/i })).toContainText("⌘ + ⏎");
    await deskModal.screenshot({
      path: join(ARTIFACTS_DIR, "spawn-modal-05-desk-agent-footer.png"),
    });
  });

  test("mobile spawn modal stays in viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockModels(page);
    await mockSlashCommands(page);
    await mockSessions(
      page,
      [makeWorkingSession({ id: "capture-spawn-mobile", project: "my-project" })],
      DEFAULT_PROJECTS,
    );
    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
    const modal = page
      .getByRole("heading", { name: /spawn session/i })
      .locator("xpath=ancestor::div[contains(@class,'shadow')][1]");
    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
    }
    await modal.screenshot({ path: join(ARTIFACTS_DIR, "spawn-modal-06-mobile-spawn.png") });
  });
});
