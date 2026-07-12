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

const CATALOG = [
  { name: "feature", description: "New user-facing capability", color: "#3fb950" },
  { name: "bug", description: "Fixing a defect or regression", color: "#FF4D4D" },
  { name: "chore", description: "Maintenance, tooling, or cleanup", color: "#8b8b8f" },
  { name: "docs", description: "Documentation only", color: "#a371f7" },
  { name: "refactor", description: "Code structure change", color: "#58a6ff" },
  { name: "focus", description: "Current attention", color: "#f0b72f" },
  { name: "review", description: "Reviewing a PR", color: "#db61a2" },
];

const DETAIL_SESSION = makeWorkingSession({
  id: "spur-auth",
  slots: { title: "Auth refactor", links: [], tags: ["feature", "bug", "focus"] },
});

const SESSIONS = [
  DETAIL_SESSION,
  makeWorkingSession({
    id: "spur-overflow",
    slots: {
      title: "Many tags overflow",
      links: [],
      tags: ["feature", "bug", "chore", "docs", "refactor", "review"],
    },
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

const EMPTY = JSON.stringify({ available: false, daemonAlive: true });

async function stubCommon(page: Page) {
  await page.route(/\/api\/tags(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tags: CATALOG }),
    });
  });
  for (const path of [
    "/api/runtime/resources",
    "/api/runtime/voice",
    "/api/github-status",
    "/api/gitlab-status",
  ]) {
    await page.route(path, (route) => {
      void route.fulfill({ status: 200, contentType: "application/json", body: EMPTY });
    });
  }
}

async function stubDashboard(page: Page) {
  await stubCommon(page);
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
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: join(ARTIFACTS_DIR, name), fullPage: true });
}

test("dashboard tag dots + popover", async ({ page }) => {
  await stubDashboard(page);
  await page.goto("/");
  await page.getByText("Many tags overflow").waitFor();

  // 1. Collapsed rows: overlapping colored dots per session, +N overflow.
  await shot(page, "tag-dots-01-dashboard.png");

  // 2. Open the popover on the overflow session (3rd tagged row) to show full
  //    names + add/remove controls.
  await page.getByLabel("Manage tags").nth(2).click();
  await page.getByRole("menu", { name: "Tag options" }).waitFor();
  await shot(page, "tag-dots-02-popover.png");
});

test("agent detail tag chips", async ({ page }) => {
  await stubCommon(page);
  await page.route(/\/api\/sessions\/spur-auth(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DETAIL_SESSION),
    });
  });
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
  await page.goto("/sessions/spur-auth");
  await page.getByText("Auth refactor").first().waitFor();
  await shot(page, "tag-chips-03-detail.png");
});
