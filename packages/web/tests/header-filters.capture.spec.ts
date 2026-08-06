import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type Page } from "playwright/test";
import {
  gotoMocked,
  makeErroredSession,
  makeNeedsInputSession,
  makeSessionWithPR,
  makeStoppedSession,
  makeWorkingSession,
  mockPrStatusBatch,
} from "./fixtures.js";

const ARTIFACTS_DIR = process.env.SPUR_SESSION_ARTIFACTS_DIR ?? "screenshots";

mkdirSync(ARTIFACTS_DIR, { recursive: true });

const PROJECT = {
  id: "sp",
  name: "Spur",
  configured: true,
  prefix: "spur",
  path: "/tmp/spur",
};

const SESSIONS = [
  makeWorkingSession({
    id: "hf-working-1",
    project: "sp",
    agent: "claude",
    slots: { title: "Working session", links: [], tags: ["feature"] },
  }),
  makeNeedsInputSession({
    id: "hf-needs-input-1",
    project: "sp",
    agent: "codex",
    slots: { title: "Needs input session", links: [], tags: [] },
  }),
  makeErroredSession({
    id: "hf-error-1",
    project: "sp",
    agent: "claude",
    slots: { title: "Errored session", links: [], tags: ["bug"] },
  }),
  makeSessionWithPR({
    id: "hf-pr-ready-1",
    project: "sp",
    agent: "claude",
    slots: {
      title: "PR-ready session",
      links: [{ label: "github-pr", url: "https://github.com/spur/spur/pull/701" }],
      tags: [],
    },
  }),
  makeSessionWithPR({
    id: "hf-pr-not-ready-1",
    project: "sp",
    agent: "codex",
    slots: {
      title: "PR not-ready session",
      links: [{ label: "github-pr", url: "https://github.com/spur/spur/pull/702" }],
      tags: [],
    },
  }),
  ...Array.from({ length: 12 }, (_, index) =>
    makeStoppedSession({
      id: `hf-stopped-${index + 1}`,
      project: "sp",
      agent: "claude",
      slots: { title: `Stopped session ${index + 1}`, links: [], tags: [] },
    }),
  ),
];

const PR_STATUS_BY_URL: Record<string, Record<string, unknown>> = {
  "https://github.com/spur/spur/pull/701": {
    state: "open",
    reviewDecision: null,
    ciStatus: null,
    canMerge: true,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
  },
  "https://github.com/spur/spur/pull/702": {
    state: "open",
    reviewDecision: "changes_requested",
    ciStatus: null,
    canMerge: true,
    mergeConflict: false,
    totalThreads: 1,
    unresolvedThreads: 0,
  },
};

const TAG_CATALOG = [
  { name: "feature", description: "New user-facing capability", color: "#3fb950" },
  { name: "bug", description: "Fixing a defect or regression", color: "#FF4D4D" },
];

async function mockDashboard(page: Page) {
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: SESSIONS,
        projects: [PROJECT],
        daemonAlive: true,
      }),
    });
  });
  await page.route("/api/tags", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tags: TAG_CATALOG }),
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
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(empty),
      });
    });
  }
  await mockPrStatusBatch(page, PR_STATUS_BY_URL);
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: join(ARTIFACTS_DIR, name), fullPage: false });
}

test.describe("header + filters capture — mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile header states", async ({ page }) => {
    test.slow();
    await mockDashboard(page);
    await gotoMocked(page, "/", SESSIONS, [PROJECT]);

    // 1. Idle header: one row, Filters trigger with no badge, FAB visible.
    await shot(page, "header-01-mobile-idle.png");

    // 2. Filters modal open, nothing selected yet.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("dialog", { name: "Filters" }).waitFor();
    await shot(page, "header-02-mobile-filters-open.png");

    // 7. Modal open, PR Ready selected on its own — same chip shape as a
    //    status option, with the count of ready sessions.
    await page.getByRole("button", { name: /^Ready to merge:/ }).click();
    await shot(page, "header-07-mobile-prready-on.png");

    // 3. Filters active: select a status lane, a tag, and PR-ready — badge
    //    shows a count, trigger gets an accent border, FAB stays reachable.
    await page.getByRole("button", { name: /^Errors:/ }).click();
    await page.getByRole("button", { name: /^bug:/ }).click();
    await page.getByRole("button", { name: "done", exact: true }).click();
    await shot(page, "header-03-mobile-filters-active.png");

    // 4. Scrolled to the bottom of the list: header stays sticky, FAB stays fixed.
    await page.getByRole("button", { name: "Reset all filters" }).click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(page, "header-04-mobile-scrolled-fab.png");

    // 9. Search field keyboard-focused: the field container shows an accent
    //    border in place of the removed `outline-none` default ring.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByLabel("Filter sessions").focus();
    await shot(page, "header-09-mobile-search-focus.png");
  });
});

test.describe("header + filters capture — desktop (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("desktop header states", async ({ page }) => {
    test.slow();
    await mockDashboard(page);
    await gotoMocked(page, "/", SESSIONS, [PROJECT]);

    // 5. Idle header: one row, project name + "Filters" label + spawn button all visible.
    await shot(page, "header-05-desktop-idle.png");

    // 6. Filters modal open at desktop width.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("dialog", { name: "Filters" }).waitFor();
    await shot(page, "header-06-desktop-filters-open.png");

    // 8. PR Ready toggled on and the modal closed: the trigger shows an
    //    active badge and the list narrows to the one ready session.
    await page.getByRole("button", { name: /^Ready to merge:/ }).click();
    await page.getByRole("button", { name: "done", exact: true }).click();
    await shot(page, "header-08-desktop-prready-active.png");
  });
});
