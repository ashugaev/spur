import {
  test,
  expect,
  makeSessionWithPR,
  mockSessions,
  mockPrStatusBatch,
  type Page,
} from "./fixtures.js";
import type { PrCheck, PrInfo } from "../src/lib/pr-status-shape.js";

const prUrl = "https://github.com/test/repo/pull/42";

const fiveChecks: PrCheck[] = [
  { name: "lint", state: "passed" },
  { name: "typecheck", state: "passed" },
  { name: "e2e", state: "pending" },
  { name: "test", state: "failed" },
  { name: "Spur Approval Gate", state: "failed" },
];

function infoWith(checks: PrCheck[], overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    state: "open",
    reviewDecision: null,
    ciStatus: "failure",
    canMerge: false,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
    reviewers: {
      approved: ["spur-code-review"],
      changesRequested: ["spur-ui-tester"],
      pending: [{ name: "core-reviewers", team: true }],
    },
    reviewRequirement: "none",
    checks,
    ...overrides,
  };
}

async function mockPr(page: Page, info: PrInfo) {
  const session = makeSessionWithPR({ id: "hover-cards" });
  await mockSessions(page, [session]);
  await mockPrStatusBatch(page, { [prUrl]: { ...info } });
  await page.route(/\/api\/pr-status\?/, (route) => route.fulfill({ json: info }));
  await page.route(`**/api/sessions/${encodeURIComponent(session.id)}`, (route) =>
    route.fulfill({ json: session }),
  );
  return session;
}

test.describe("PR hover cards", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("CI card lists checks failed, pending, passed with no totals", async ({ page }) => {
    await mockPr(page, infoWith(fiveChecks));
    await page.goto("/");
    const badge = page.locator(`a[href='${prUrl}']`).first();
    await badge.getByRole("group").first().hover();
    const rows = page.locator("[data-pr-card] [data-pr-card-row]");
    await expect(rows).toHaveText(["test", "Spur Approval Gate", "e2e", "lint", "typecheck"]);
    await expect(page.locator("[data-pr-card-more]")).toHaveCount(0);
  });

  test("CI card caps at 8 rows and shows +N more", async ({ page }) => {
    const checks: PrCheck[] = Array.from({ length: 13 }, (_, i) => ({
      name: `check-${String(i).padStart(2, "0")}`,
      state: "passed",
    }));
    await mockPr(page, infoWith(checks));
    await page.goto("/");
    await page.locator(`a[href='${prUrl}']`).first().getByRole("group").first().hover();
    await expect(page.locator("[data-pr-card] [data-pr-card-row]")).toHaveCount(8);
    await expect(page.locator("[data-pr-card-more]")).toHaveText("+5 more");
  });

  for (const [label, locate] of [
    ["CI", (page: Page) => page.locator(`a[href='${prUrl}']`).first().getByRole("group").first()],
    [
      "reviewer",
      (page: Page) => page.locator(`a[href='${prUrl}']`).first().locator("[data-pr-reviewers]"),
    ],
  ] as const) {
    test(`${label} card stays open while the pointer travels from icon to card`, async ({
      page,
    }) => {
      await mockPr(page, infoWith(fiveChecks));
      await page.goto("/");
      const trigger = locate(page);
      await trigger.hover();
      const card = page.locator("[data-pr-card]");
      await expect(card).toBeVisible();
      const from = (await trigger.boundingBox())!;
      const to = (await card.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await expect(card).toBeVisible();
      await page.waitForTimeout(300);
      await expect(card).toBeVisible();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 200, { steps: 4 });
      await expect(card).toHaveCount(0);
    });
  }

  test("session header: clicking the badge opens the PR, clicking inside the card does not", async ({
    page,
    context,
  }) => {
    const session = await mockPr(page, infoWith(fiveChecks));
    await page.goto(`/sessions/${session.id}`);
    const badge = page.locator(`a[href='${prUrl}']`).first();
    await badge.locator("[data-pr-reviewers]").hover();
    const card = page.locator("[data-pr-card]");
    await expect(card.locator("[data-pr-card-row]")).toHaveText([
      "@spur-ui-tester",
      "core-reviewersteam",
      "@spur-code-review",
    ]);
    let opened = 0;
    context.on("page", () => {
      opened += 1;
    });
    await card.click();
    await page.waitForTimeout(300);
    expect(opened).toBe(0);
    const popup = context.waitForEvent("page");
    await badge.click();
    expect((await popup).url()).toContain("github.com/test/repo/pull/42");
  });

  test("no reviewer icon without reviews, requests or required review", async ({ page }) => {
    await mockPr(page, infoWith(fiveChecks, { reviewers: { approved: [], changesRequested: [] } }));
    await page.goto("/");
    await expect(page.locator(`a[href='${prUrl}']`).first()).toBeVisible();
    await expect(page.locator("[data-pr-reviewers]")).toHaveCount(0);
  });
});

test.describe("PR hover cards on touch", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });

  test("tap pins the CI card without navigating; tap outside closes it", async ({
    page,
    context,
  }) => {
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query === "(hover: none) and (pointer: coarse)"
          ? ({ ...original(query), matches: true } as MediaQueryList)
          : original(query);
    });
    const session = await mockPr(page, infoWith(fiveChecks));
    await page.goto(`/sessions/${session.id}`);
    const url = page.url();
    let opened = 0;
    context.on("page", () => {
      opened += 1;
    });
    await page.locator(`a[href='${prUrl}']`).first().getByRole("group").first().tap();
    await expect(page.locator("[data-pr-card]")).toBeVisible();
    expect(page.url()).toBe(url);
    expect(opened).toBe(0);
    // Tap inside the card keeps it pinned and never navigates.
    await page.locator("[data-pr-card]").tap();
    await page.waitForTimeout(300);
    await expect(page.locator("[data-pr-card]")).toBeVisible();
    expect(page.url()).toBe(url);
    expect(opened).toBe(0);
    await page.locator("body").tap({ position: { x: 5, y: 400 } });
    await expect(page.locator("[data-pr-card]")).toHaveCount(0);
  });
});
