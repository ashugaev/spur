import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession } from "./fixtures.js";

const ARTIFACTS_DIR = process.env.SPUR_SESSION_ARTIFACTS_DIR ?? "screenshots";

mkdirSync(ARTIFACTS_DIR, { recursive: true });

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  return page.route(`**/api/sessions/${session.id}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: join(ARTIFACTS_DIR, name), fullPage: true });
}

function handoffPanel(page: Page) {
  return page.getByRole("heading", { name: "Handoff" }).locator("..").locator("..");
}

test("handoff UI states", async ({ page }) => {
  const session = makeWorkingSession({
    id: "handoff-capture-1",
    agent: "codex",
    model: "gpt-5.3-codex",
    slots: {
      title: "Auth refactor",
      links: [],
      tags: ["feature"],
    },
  });
  await mockSessionDetail(page, session);
  await page.goto(`/sessions/${session.id}`);

  const handoffButton = page.getByRole("button", { name: /^handoff$/i });
  await expect(handoffButton).toBeVisible();
  await shot(page, "handoff-01-detail-button.png");

  await handoffButton.click();
  await expect(page.getByRole("combobox", { name: "Handoff agent" })).toBeVisible();
  await handoffPanel(page).screenshot({
    path: join(ARTIFACTS_DIR, "handoff-02-modal-default.png"),
  });

  await page.getByRole("combobox", { name: "Handoff agent" }).selectOption("cursor");
  await page.getByRole("textbox", { name: "Handoff notes" }).fill("Continue from codex");
  await handoffPanel(page).screenshot({ path: join(ARTIFACTS_DIR, "handoff-03-modal-filled.png") });
});

test("handoff modal with linked PR", async ({ page }) => {
  const session = makeWorkingSession({
    id: "handoff-capture-pr",
    agent: "claude",
    slots: {
      title: "Fix login flow",
      links: [{ label: "pr", url: "https://github.com/example/spur/pull/493" }],
      tags: [],
    },
  });
  await mockSessionDetail(page, session);
  await page.goto(`/sessions/${session.id}`);

  await page.getByRole("button", { name: /^handoff$/i }).click();
  await expect(page.getByRole("note")).toContainText("links a PR");
  await handoffPanel(page).screenshot({
    path: join(ARTIFACTS_DIR, "handoff-04-modal-pr-note.png"),
  });
});
