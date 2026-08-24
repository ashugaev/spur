import { test, expect, type Page } from "playwright/test";
import {
  makeCompletedSession,
  makeWorkingSession,
  mockAgentModels,
  mockSessions,
  mockSpawnDefaults,
  type ProjectInfo,
} from "./fixtures.js";

const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

const MODELS_BY_AGENT: Record<string, { id: string; label: string; isDefault?: boolean }[]> = {
  claude: [
    { id: "claude-opus", label: "Claude Opus", isDefault: true },
    { id: "claude-sonnet", label: "Claude Sonnet" },
    { id: "claude-haiku", label: "Claude Haiku" },
  ],
  codex: [
    { id: "gpt-5", label: "GPT-5", isDefault: true },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
  ],
  cursor: [{ id: "cursor-fast", label: "Cursor Fast", isDefault: true }],
};

async function mockModels(page: Page): Promise<void> {
  await mockAgentModels(page, MODELS_BY_AGENT);
}

async function openSpawnModal(page: Page): Promise<void> {
  await mockSessions(
    page,
    [makeWorkingSession({ id: "model-picker-1", project: "my-project" })],
    DEFAULT_PROJECTS,
  );
  await mockModels(page);
  // No project.defaultModels configured — rung 3 falls through, so the
  // control preselects the catalog's first entry (rung 4).
  await mockSpawnDefaults(page);
  await page.goto("/");
  await page.getByRole("button", { name: /spawn session/i }).click();
  await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
}

// D7c: Spawn modal model picker
test.describe("D7c: Spawn modal model picker", () => {
  test("model picker renders next to the agent select and preselects the catalog's first entry", async ({
    page,
  }) => {
    await openSpawnModal(page);

    await expect(page.getByRole("combobox", { name: "Spawn agent" })).toBeVisible();
    const modelButton = page.getByRole("button", { name: "Spawn model" });
    await expect(modelButton).toBeVisible();
    await expect(modelButton).toHaveText(/Claude Opus/);
  });

  test("switching agent changes the model list", async ({ page }) => {
    await openSpawnModal(page);

    await page.getByRole("button", { name: "Spawn model" }).click();
    await expect(page.getByRole("menuitem", { name: /Claude Opus/ })).toBeVisible();

    // Close the menu, switch agent, reopen — the codex list replaces claude's.
    await page.getByRole("button", { name: "Spawn model" }).click();
    await expect(page.getByRole("menu", { name: "Model options" })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption("codex");
    await page.getByRole("button", { name: "Spawn model" }).click();
    await expect(page.getByRole("menuitem", { name: /GPT-5 Mini/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Claude Opus/ })).toHaveCount(0);
  });

  test("typing in the search filters the list", async ({ page }) => {
    await openSpawnModal(page);

    await page.getByRole("button", { name: "Spawn model" }).click();
    await expect(page.getByRole("menuitem", { name: /Claude Sonnet/ })).toBeVisible();

    await page.getByRole("textbox", { name: "Search models" }).fill("haiku");
    await expect(page.getByRole("menuitem", { name: /Claude Haiku/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Claude Sonnet/ })).toHaveCount(0);
  });

  test("selecting a model reflects in the control", async ({ page }) => {
    await openSpawnModal(page);

    await page.getByRole("button", { name: "Spawn model" }).click();
    await page.getByRole("menuitem", { name: /Claude Sonnet/ }).click();

    await expect(page.getByRole("button", { name: "Spawn model" })).toHaveText(/Claude Sonnet/);
  });

  test("starring a model pins it to the top and persists across reload", async ({ page }) => {
    await openSpawnModal(page);

    await page.getByRole("button", { name: "Spawn model" }).click();
    await page.getByRole("button", { name: "Add favorite Claude Haiku" }).click();

    // Favorite jumps to the first model row.
    const firstModel = page
      .getByRole("menu", { name: "Model options" })
      .getByRole("menuitem")
      .nth(0);
    await expect(firstModel).toContainText("Claude Haiku");

    // Persisted to local storage under the shared favorites key.
    const stored = await page.evaluate(() => window.localStorage.getItem("spur:model-favorites"));
    expect(stored ?? "").toContain("claude:claude-haiku");

    // Keep this scenario about favorite persistence. The spawn draft has its
    // own persistence coverage and can otherwise race the reload debounce by
    // restoring the model that was selected before Haiku was favorited.
    await page.addInitScript(() => window.localStorage.removeItem("spur:spawn-draft"));

    // Reload and reopen — the favorite stays pinned to the top and is what
    // an unresolved control preselects (rung 2).
    await page.reload();
    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("button", { name: "Spawn model" })).toHaveText(/Claude Haiku/);
    await page.getByRole("button", { name: "Spawn model" }).click();
    const firstModelAfterReload = page
      .getByRole("menu", { name: "Model options" })
      .getByRole("menuitem")
      .nth(0);
    await expect(firstModelAfterReload).toContainText("Claude Haiku");
  });

  test("respawn modal shares the agent + model picker layout", async ({ page }) => {
    const session = makeCompletedSession({
      id: "model-picker-respawn",
      project: "my-project",
      prompt: "Retry with a new model",
    });
    await page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });
    await mockModels(page);
    await mockSpawnDefaults(page);
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /edit & respawn/i }).click();
    await expect(page.getByRole("combobox", { name: "Respawn agent" })).toBeVisible();
    const modelButton = page.getByRole("button", { name: "Respawn model" });
    await expect(modelButton).toBeVisible();
    await expect(modelButton).toHaveText(/Claude Opus/);
  });
});
