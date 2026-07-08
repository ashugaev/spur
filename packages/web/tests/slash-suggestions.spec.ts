import { test, expect, type Page } from "playwright/test";
import { mockSessions, type ProjectInfo } from "./fixtures.js";

const DEFAULT_PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

async function openSpawnSlashMenu(page: Page): Promise<void> {
  await mockSessions(page, [], DEFAULT_PROJECTS);
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
            detail: "Summarize the chat",
            source: "built-in",
            kind: "command",
          },
          {
            id: "review",
            label: "/review",
            insertText: "/review",
            detail: "Run the review flow",
            source: "built-in",
            kind: "command",
          },
        ],
        skills: [
          {
            id: "planner",
            label: "$planner",
            insertText: "$planner",
            detail: "Plan the work",
            source: "user",
            kind: "skill",
          },
        ],
        agents: [],
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /spawn session/i }).click();
  await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
  await page.getByRole("button", { name: "Slash", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Slash suggestions" })).toBeVisible();
}

// D7f: Slash suggestions search
test.describe("D7f: Slash suggestions search", () => {
  test("renders a search input that filters and restores the list", async ({ page }) => {
    await openSpawnSlashMenu(page);
    const menu = page.getByRole("menu", { name: "Slash suggestions" });

    const search = menu.getByRole("textbox", { name: "Search commands" });
    await expect(search).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(3);

    // Typing narrows to matches over label/detail/id.
    await search.fill("planner");
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: /\$planner/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /\/compact/ })).toHaveCount(0);

    // Clearing restores the full list.
    await search.fill("");
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
  });

  test("keeps favorites pinned to the top within the filtered results", async ({ page }) => {
    await openSpawnSlashMenu(page);
    const menu = page.getByRole("menu", { name: "Slash suggestions" });

    // Favorite /review so it moves into the Favorites group.
    await menu.getByRole("button", { name: "Add favorite /review" }).click();
    await expect(menu.getByText("Favorites")).toBeVisible();

    // Filtering to "review" still shows /review under Favorites, first.
    await menu.getByRole("textbox", { name: "Search commands" }).fill("review");
    await expect(menu.getByText("Favorites")).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toContainText("/review");
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
  });
});
