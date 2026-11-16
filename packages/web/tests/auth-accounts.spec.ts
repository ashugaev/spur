import {
  test,
  expect,
  type Page,
  makeWorkingSession,
  mockSessions,
  mockTagCatalog,
} from "./fixtures.js";
import type { AuthAccountSummary, AuthAccountsResponse } from "../src/lib/types";

const PROJECTS = [{ id: "my-project", name: "my-project" }];

function account(overrides: Partial<AuthAccountSummary> & { id: string }): AuthAccountSummary {
  return {
    provider: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    authenticated: true,
    status: "ready",
    limited: false,
    ...overrides,
  };
}

const ACCOUNTS: AuthAccountsResponse = {
  accounts: [
    account({ id: "claude-work", label: "Work" }),
    account({
      id: "claude-home",
      label: "Home",
      limited: true,
      cooldownUntil: "2026-01-01T14:05:00.000Z",
    }),
    account({
      id: "codex-new",
      provider: "codex",
      label: "Fresh",
      authenticated: false,
      status: "sign_in_required",
    }),
  ],
  pools: { claude: { defaultAccountId: "claude-work", defaultGeneration: 0, autoRotate: true } },
};

async function mockAccounts(
  page: Page,
  reply: () => { status: number; body: unknown } = () => ({ status: 200, body: ACCOUNTS }),
) {
  await page.route("/api/auth-accounts", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const { status, body } = reply();
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "Manage agent accounts" }).click();
}

test.describe("Agent accounts menu", () => {
  test("shows a loading row until accounts arrive", async ({ page }) => {
    await mockSessions(page, []);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("/api/auth-accounts", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ACCOUNTS),
      });
    });
    await page.goto("/");
    await openMenu(page);

    await expect(page.getByTestId("auth-accounts-loading")).toBeVisible();
    await expect(page.getByTestId("auth-section-claude")).toHaveCount(0);
    release();
    await expect(page.getByTestId("auth-section-claude")).toBeVisible();
    await expect(page.getByTestId("auth-accounts-loading")).toHaveCount(0);
  });

  test("hides sections on a load failure and recovers on Retry", async ({ page }) => {
    await mockSessions(page, []);
    let failing = true;
    await mockAccounts(page, () =>
      failing ? { status: 502, body: { error: "daemon down" } } : { status: 200, body: ACCOUNTS },
    );
    await page.goto("/");
    await openMenu(page);

    const popover = page.getByTestId("auth-accounts-popover");
    await expect(popover.getByRole("alert")).toHaveText("daemon down");
    await expect(popover.getByTestId("auth-section-claude")).toHaveCount(0);
    failing = false;
    await popover.getByRole("button", { name: "Retry" }).click();
    await expect(popover.getByTestId("auth-section-claude")).toBeVisible();
  });

  test("badges a limited account with its cooldown end", async ({ page }) => {
    await mockSessions(page, []);
    await mockAccounts(page);
    await page.goto("/");
    await openMenu(page);

    const home = page.getByTestId("auth-account-claude-home");
    await expect(home.getByText(/^limited · until \d{2}:\d{2}$/)).toBeVisible();
    await expect(page.getByTestId("auth-account-claude-work").getByText(/limited/)).toHaveCount(0);
  });

  test("removes an account only after confirmation", async ({ page }) => {
    await mockSessions(page, []);
    await mockAccounts(page);
    const deletes: string[] = [];
    await page.route("/api/auth-accounts/claude-home", async (route) => {
      deletes.push(route.request().method());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ removed: "claude-home" }),
      });
    });
    await page.goto("/");
    await openMenu(page);

    const home = page.getByTestId("auth-account-claude-home");
    await home.getByRole("button", { name: "Remove claude account Home" }).click();
    await home.getByRole("button", { name: "Keep" }).click();
    expect(deletes).toEqual([]);

    await home.getByRole("button", { name: "Remove claude account Home" }).click();
    await home.getByRole("button", { name: "Confirm remove claude account Home" }).click();
    await expect.poll(() => deletes).toEqual(["DELETE"]);
  });

  test("cancelling sign-in returns the row to sign in required", async ({ page }) => {
    await mockSessions(page, []);
    let codexStatus: AuthAccountSummary["status"] = "sign_in_required";
    await mockAccounts(page, () => ({
      status: 200,
      body: {
        ...ACCOUNTS,
        accounts: ACCOUNTS.accounts.map((entry) =>
          entry.id === "codex-new" ? { ...entry, status: codexStatus } : entry,
        ),
      },
    }));
    await page.route("/api/auth-accounts/codex-new/login", async (route) => {
      codexStatus = "pending";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accountId: "codex-new", status: "pending" }),
      });
    });
    await page.route("/api/auth-accounts/codex-new/login-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accountId: "codex-new", status: codexStatus }),
      });
    });
    const inputs: unknown[] = [];
    await page.route("/api/auth-accounts/codex-new/login-input", async (route) => {
      inputs.push(route.request().postDataJSON());
      codexStatus = "sign_in_required";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accountId: "codex-new", status: "sign-in-required" }),
      });
    });
    await page.goto("/");
    await openMenu(page);

    const row = page.getByTestId("auth-account-codex-new");
    await row.getByRole("button", { name: "Sign in codex account Fresh" }).click();
    const dialog = page.getByRole("dialog", { name: /Sign in codex/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(row).toContainText("signing in");
    await page.keyboard.press("Escape");

    await expect(dialog).toBeHidden();
    expect(inputs).toEqual([{ cancel: true }]);
    // Well under the 30s accounts cache window: the cancel itself refetches.
    await expect(row).toContainText("sign in required", { timeout: 5_000 });
    await expect(row).not.toContainText("signing in");
  });

  test("stays inside a 320px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await mockSessions(page, []);
    await mockAccounts(page);
    await page.goto("/");
    await openMenu(page);

    const popover = page.getByTestId("auth-accounts-popover");
    await expect(popover.getByTestId("auth-section-claude")).toBeVisible();
    await expect
      .poll(async () => {
        const bounds = await popover.boundingBox();
        const viewportWidth = page.viewportSize()?.width ?? 0;
        return bounds ? bounds.x >= 0 && bounds.x + bounds.width <= viewportWidth : false;
      })
      .toBe(true);
  });
});

test.describe("Spawn auth picker", () => {
  test("sends the picked account and offers limited accounts", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockAccounts(page);
    await page.route("**/api/preflight", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ branch: "feature/auth-pick" }),
      });
    });
    let spawnBody: Record<string, unknown> | null = null;
    await page.route("**/api/spawn", (route) => {
      spawnBody = route.request().postDataJSON() as Record<string, unknown>;
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(makeWorkingSession({ id: "auth-pick-1", project: "my-project" })),
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");

    const picker = page.getByRole("combobox", { name: "Spawn auth" });
    await expect(
      picker.getByRole("option", { name: /^Auth · Home \(limited until/ }),
    ).toBeEnabled();
    await picker.selectOption("claude-home");

    const textarea = page.locator("textarea").last();
    await textarea.fill("Pick an account");
    await textarea.press("Meta+Enter");

    await expect.poll(() => spawnBody?.authAccountId).toBe("claude-home");
  });

  test("hides the picker for an agent without managed accounts", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockAccounts(page, () => ({
      status: 200,
      body: { accounts: [], pools: {} },
    }));
    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");

    await expect(page.getByRole("combobox", { name: "Spawn auth" })).toHaveCount(0);
  });
});

test.describe("Session switch auth", () => {
  test("switches a pinned session back to Auto", async ({ page }) => {
    const session = makeWorkingSession({
      id: "auth-switch-1",
      auth: {
        sessionId: "auth-switch-1",
        provider: "claude",
        mode: "pinned",
        accountId: "claude-work",
        effectiveAccountId: "claude-work",
        generation: 1,
      },
    });
    await mockTagCatalog(page);
    await page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });
    await mockAccounts(page);
    let switchBody: unknown = null;
    await page.route(`**/api/sessions/${session.id}/switch-auth`, (route) => {
      switchBody = route.request().postDataJSON();
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    });
    await page.goto(`/sessions/${session.id}`);

    await page.getByRole("button", { name: "Switch auth" }).click();
    const dialog = page.getByRole("dialog", { name: /Switch claude account/ });
    await expect(dialog.getByTestId("switch-auth-current")).toContainText("Now: Work (pinned)");
    await dialog.getByTestId("switch-auth-account").selectOption("");
    await dialog.getByRole("button", { name: "Switch" }).click();

    await expect.poll(() => switchBody).toEqual({ accountId: null });
    await expect(dialog).toBeHidden();
  });
});
