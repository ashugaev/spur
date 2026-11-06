import { test, expect, type Page, mockSessions, type ProjectInfo } from "./fixtures.js";
import type { QuotaSourceResult, UsageReport } from "../src/lib/types";

const PROJECTS: ProjectInfo[] = [{ id: "my-project", name: "my-project" }];

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const TOTALS = { inputTokens: 412_000, outputTokens: 186_000, totalTokens: 20_200_000 };

const OK_SOURCE: QuotaSourceResult = {
  provider: "claude",
  source: "acc-default",
  label: "default",
  fetchedAt: iso(-12_000),
  status: "ok",
  plan: "max",
  windows: [
    { label: "5h", usedPercent: 96, remainingPercent: 4, resetsAt: iso(38 * 60_000) },
    { label: "weekly", usedPercent: 31, remainingPercent: 69, resetsAt: null },
  ],
};

const ERROR_SOURCES: QuotaSourceResult[] = [
  {
    provider: "claude",
    source: "acc-work",
    label: "work",
    fetchedAt: iso(-12_000),
    status: "error",
    error: "unauthorized",
    message: "saved login rejected",
    httpStatus: 401,
  },
  {
    provider: "codex",
    source: "codex",
    label: "default",
    fetchedAt: iso(-12_000),
    status: "error",
    error: "rate_limited",
    message: "usage endpoint rate limited",
    httpStatus: 429,
  },
];

const REPORT: UsageReport = {
  generatedAt: iso(-12_000),
  quotas: [OK_SOURCE, ...ERROR_SOURCES],
  tokens: [
    {
      window: "today",
      since: iso(-3_600_000),
      byProvider: [
        {
          provider: "claude",
          sessionCount: 9,
          totals: { ...TOTALS, cacheReadInputTokens: 18_400_000 },
          byModel: [{ model: null, sessionCount: 9, totals: TOTALS }],
        },
      ],
    },
    { window: "7d", since: iso(-7 * 86_400_000), byProvider: [] },
    { window: "30d", since: iso(-30 * 86_400_000), byProvider: [] },
  ],
};

interface MockResponse {
  status: number;
  body: unknown;
}

// Returns the URLs of /api/usage requests that completed. Requests aborted by
// the dev-mode StrictMode double effect fire requestfailed, not requestfinished.
async function mockUsage(page: Page, respond: () => MockResponse): Promise<string[]> {
  const finished: string[] = [];
  page.on("requestfinished", (request) => {
    if (new URL(request.url()).pathname === "/api/usage") finished.push(request.url());
  });
  await page.route("**/api/claude-accounts", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accounts: [] }),
    });
  });
  await page.route("**/api/usage", async (route) => {
    const next = respond();
    await route.fulfill({
      status: next.status,
      contentType: "application/json",
      body: JSON.stringify(next.body),
    });
  });
  return finished;
}

const ok = (body: unknown = REPORT): MockResponse => ({ status: 200, body });

test.describe("Usage modal", () => {
  test("footer Usage opens the modal, loads only on open, closes on Escape", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    const finished = await mockUsage(page, () => ok());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Usage" })).toBeVisible();
    expect(finished).toHaveLength(0);

    await page.getByRole("button", { name: "Usage" }).click();
    const dialog = page.getByRole("dialog", { name: "Usage" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("96% used")).toBeVisible();
    await expect(dialog.getByRole("table")).toBeVisible();
    await expect.poll(() => finished.length).toBe(1);
    await expect(dialog.getByRole("table")).toBeVisible();
    expect(finished).toHaveLength(1);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("keyboard open traps Tab inside the dialog and restores focus on close", async ({
    page,
  }) => {
    await mockSessions(page, [], PROJECTS);
    await mockUsage(page, () => ok());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "Usage" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Usage" });
    await expect(dialog.getByRole("table")).toBeVisible();

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("renders error sources with chips and no meter", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockUsage(page, () => ok({ ...REPORT, quotas: ERROR_SOURCES }));
    await page.goto("/");
    await page.getByRole("button", { name: "Usage" }).click();
    const dialog = page.getByRole("dialog", { name: "Usage" });
    await expect(dialog.getByText("unauthorized")).toBeVisible();
    await expect(dialog.getByText("rate limited", { exact: true })).toBeVisible();
    await expect(dialog.getByText("HTTP 401")).toBeVisible();
    await expect(dialog.getByRole("meter")).toHaveCount(0);
  });

  test("shows empty windows", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockUsage(page, () => ok({ ...REPORT, quotas: [{ ...OK_SOURCE, windows: [] }] }));
    await page.goto("/");
    await page.getByRole("button", { name: "Usage" }).click();
    const dialog = page.getByRole("dialog", { name: "Usage" });
    await expect(dialog.getByText("no windows reported")).toBeVisible();
    await dialog.getByRole("button", { name: "7D" }).click();
    await expect(dialog.getByText("No sessions in this window")).toBeVisible();
  });

  test("shows the failure state and recovers on Retry", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    let recovered = false;
    await mockUsage(page, () => (recovered ? ok() : { status: 502, body: { error: "down" } }));
    await page.goto("/");
    await page.getByRole("button", { name: "Usage" }).click();
    await expect(page.getByText("Could not load usage")).toBeVisible();
    recovered = true;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("96% used")).toBeVisible();
  });

  test("hides optional token columns and stays inside the viewport on mobile", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockUsage(page, () => ok());
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "Usage" }).click();
    const dialog = page.getByRole("dialog", { name: "Usage" });
    await expect(dialog.getByRole("columnheader", { name: "Total" })).toBeVisible();
    await expect(dialog.getByRole("columnheader", { name: "Cache read" })).toBeHidden();
    const box = await dialog.locator("> div").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
