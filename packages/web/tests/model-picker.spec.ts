import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession, mockSessions, type ProjectInfo } from "./fixtures.js";

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
  test("model picker renders next to the agent select and defaults to Default", async ({
    page,
  }) => {
    await openSpawnModal(page);

    await expect(page.getByRole("combobox", { name: "Spawn agent" })).toBeVisible();
    const modelButton = page.getByRole("button", { name: "Spawn model" });
    await expect(modelButton).toBeVisible();
    await expect(modelButton).toHaveText(/Default/);
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

    // Favorite jumps to the first model row (after the Default entry).
    const firstModel = page
      .getByRole("menu", { name: "Model options" })
      .getByRole("menuitem")
      .nth(1);
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
      .nth(1);
    await expect(firstModelAfterReload).toContainText("Claude Haiku");
  });
});
