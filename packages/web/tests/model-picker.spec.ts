import { test, expect, type Page } from "playwright/test";
import {
  makeCompletedSession,
  makeWorkingSession,
  mockSessions,
  type ProjectInfo,
} from "./fixtures.js";

const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

const MODELS_BY_AGENT: Record<string, { id: string; label: string }[]> = {
  claude: [
    { id: "claude-opus", label: "Claude Opus" },
    { id: "claude-sonnet", label: "Claude Sonnet" },
    { id: "claude-haiku", label: "Claude Haiku" },
  ],
  codex: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
  ],
  cursor: [{ id: "cursor-fast", label: "Cursor Fast" }],
};

async function mockModels(page: Page): Promise<void> {
  await page.route(/\/api\/models\?agent=.*/, (route) => {
    const url = new URL(route.request().url());
    const agent = url.searchParams.get("agent") ?? "claude";
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: MODELS_BY_AGENT[agent] ?? [] }),
    });
  });
}

async function openSpawnModal(page: Page): Promise<void> {
  await mockSessions(
    page,
    [makeWorkingSession({ id: "model-picker-1", project: "my-project" })],
    DEFAULT_PROJECTS,
  );
  await mockModels(page);
  await page.goto("/");
  await page.getByRole("button", { name: /spawn session/i }).click();
  await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
}

// D7c: Spawn modal model picker
test.describe("D7c: Spawn modal model picker", () => {
  test("model picker renders next to the agent select and auto-selects the first model with no history", async ({
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

    // Reload and reopen — the favorite stays pinned to the top.
    await page.reload();
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("button", { name: "Spawn model" }).click();
    const firstModelAfterReload = page
      .getByRole("menu", { name: "Model options" })
      .getByRole("menuitem")
      .nth(0);
    await expect(firstModelAfterReload).toContainText("Claude Haiku");
  });

  test("restores a persisted last agent + model from localStorage across a reload", async ({
    page,
  }) => {
    await mockSessions(
      page,
      [makeWorkingSession({ id: "model-picker-persisted", project: "my-project" })],
      DEFAULT_PROJECTS,
    );
    await mockModels(page);
    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.setItem(
        "spur:last-agent-model",
        JSON.stringify({ lastAgent: "codex", modelByAgent: { codex: "gpt-5-mini" } }),
      );
    });
    await page.reload();

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("heading", { name: /spawn session/i })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Spawn agent" })).toHaveValue("codex");
    await expect(page.getByRole("button", { name: "Spawn model" })).toHaveText(/GPT-5 Mini/);
  });

  test("favoriting a model preselects it on the next spawn modal open", async ({ page }) => {
    await openSpawnModal(page);

    await page.getByRole("button", { name: "Spawn model" }).click();
    await page.getByRole("button", { name: "Add favorite Claude Haiku" }).click();
    await page.getByRole("button", { name: "✕" }).click();

    await page.getByRole("button", { name: /spawn session/i }).click();
    await expect(page.getByRole("button", { name: "Spawn model" })).toHaveText(/Claude Haiku/);
  });

  test("never shows a Default menu item once models have loaded", async ({ page }) => {
    await openSpawnModal(page);

    const modelButton = page.getByRole("button", { name: "Spawn model" });
    await expect(modelButton).toHaveText(/Claude Opus/);
    await modelButton.click();
    await expect(page.getByRole("menuitem", { name: /Claude Opus/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Default" })).toHaveCount(0);
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
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: /edit & respawn/i }).click();
    await expect(page.getByRole("combobox", { name: "Respawn agent" })).toBeVisible();
    const modelButton = page.getByRole("button", { name: "Respawn model" });
    await expect(modelButton).toBeVisible();
    await expect(modelButton).toHaveText(/Default/);
  });
});
