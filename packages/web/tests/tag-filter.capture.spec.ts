import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type Page } from "playwright/test";
import { makeWorkingSession } from "./fixtures.js";

const ARTIFACTS_DIR = process.env.SPUR_SESSION_ARTIFACTS_DIR ?? "screenshots";

mkdirSync(ARTIFACTS_DIR, { recursive: true });

const PROJECT = {
  id: "sp",
  name: "Spur",
  configured: true,
  prefix: "spur",
  path: "/tmp/spur",
};

// Catalog has five tags, but only feature/bug/chore are applied to a session.
// docs and refactor must therefore be absent from the filter.
const CATALOG = [
  { name: "feature", description: "New user-facing capability", color: "#3fb950" },
  { name: "bug", description: "Fixing a defect or regression", color: "#FF4D4D" },
  { name: "chore", description: "Maintenance, tooling, or cleanup", color: "#8b8b8f" },
  { name: "docs", description: "Documentation only", color: "#a371f7" },
  { name: "refactor", description: "Code structure change", color: "#58a6ff" },
];

const SESSIONS = [
  makeWorkingSession({
    id: "spur-auth",
    slots: { title: "Auth refactor", links: [], tags: ["feature", "chore"] },
  }),
  makeWorkingSession({
    id: "spur-login",
    slots: { title: "Fix login bug", links: [], tags: ["bug"] },
  }),
  makeWorkingSession({
    id: "spur-readme",
    slots: { title: "Tidy readme", links: [], tags: [] },
  }),
];

async function mockDashboard(page: Page) {
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: SESSIONS,
        projects: [PROJECT],
        tags: CATALOG,
        daemonAlive: true,
      }),
    });
  });
  const empty: Record<string, unknown> = { available: false, daemonAlive: true };
  for (const path of [
    "/api/runtime/resources",
    "/api/runtime/voice",
    "/api/github-status",
    "/api/gitlab-status",
  ]) {
    await page.route(path, (route) => {
      void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(empty) });
    });
  }
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: join(ARTIFACTS_DIR, name), fullPage: true });
}

test("tag filter states", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/");
  const trigger = page.getByLabel("Filter by tag");
  await trigger.waitFor();

  // 1. Closed, nothing selected: filter icon + "Tags", no color dot.
  await shot(page, "tag-filter-01-closed-default.png");

  // 2. Open menu: only applied tags (feature/bug/chore) render as styled chips,
  //    no dots; docs/refactor are absent.
  await trigger.click();
  await page.getByRole("button", { name: "feature" }).waitFor();
  await shot(page, "tag-filter-02-open.png");

  // 3. Selected state (dropdown closed): tag shows as plain text, no chip/dot.
  await page.getByRole("button", { name: "feature" }).click();
  await trigger.waitFor();
  await shot(page, "tag-filter-03-selected.png");
});
