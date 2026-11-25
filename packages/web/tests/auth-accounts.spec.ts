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

function account(
  overrides: Partial<AuthAccountSummary> & { id: string; displayName: string },
): AuthAccountSummary {
  return {
    provider: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    authenticated: true,
    status: "ready",
    limited: false,
    credential: "oauth",
    ...overrides,
  };
}

const ACCOUNTS: AuthAccountsResponse = {
  accounts: [
    account({
      id: "claude-work",
      displayName: "alek@x.com",
      identity: { email: "alek@x.com", organizationName: "Intelas" },
      quota: {
        leftPercent: 62,
        resetsAt: null,
        windows: [
          { label: "5h", usedPercent: 38, remainingPercent: 62, resetsAt: "2026-01-01T18:40:00Z" },
        ],
        fetchedAt: "2026-01-01T12:00:00.000Z",
      },
    }),
    account({
      id: "claude-home",
      displayName: "home@x.com",
      identity: { email: "home@x.com", organizationName: "Personal" },
      limited: true,
      cooldownUntil: "2026-01-01T14:05:00.000Z",
    }),
    account({
      id: "claude-key",
      displayName: "API key ····7Q2c",
      credential: "api_key",
      identity: { keyHint: "7Q2c" },
    }),
    account({
      id: "codex-new",
      provider: "codex",
      displayName: "New Codex account",
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

  test("shows identity and quota per account without status words", async ({ page }) => {
    await mockSessions(page, []);
    await mockAccounts(page);
    await page.goto("/");
    await openMenu(page);

    const work = page.getByTestId("auth-account-claude-work");
    await expect(work.getByText("alek@x.com")).toBeVisible();
    await expect(work.getByText("Intelas")).toBeVisible();
    await expect(work.getByText("62% left")).toBeVisible();
    await expect(work.getByRole("img", { name: "In use" })).toBeVisible();
    const home = page.getByTestId("auth-account-claude-home");
    await expect(home.getByText("0% left")).toBeVisible();
    await expect(home.getByText(/^resets \d{2}:\d{2}$/)).toBeVisible();
    const key = page.getByTestId("auth-account-claude-key");
    await expect(key.getByText("API key ····7Q2c")).toBeVisible();
    await expect(key.getByText("%")).toHaveCount(0);
    await expect(page.getByTestId("auth-accounts-popover")).not.toContainText(/\bready\b|default/i);
    await expect(page.getByTestId("auth-accounts-popover").getByRole("textbox")).toHaveCount(0);
  });

  test("switches the provider default with the SWITCH button", async ({ page }) => {
    await mockSessions(page, []);
    await mockAccounts(page);
    let poolBody: unknown = null;
    await page.route("/api/auth-pools/claude", async (route) => {
      poolBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ pool: {} }),
      });
    });
    await page.goto("/");
    await openMenu(page);

    await page.getByRole("button", { name: "Switch Claude to home@x.com" }).click();

    await expect.poll(() => poolBody).toEqual({ defaultAccountId: "claude-home" });
  });

  test("keeps the default dialog after leaving an unpinned hover menu", async ({ page }) => {
    await mockSessions(page, [
      makeWorkingSession({
        id: "auth-default-hover",
        auth: {
          sessionId: "auth-default-hover",
          provider: "claude",
          mode: "auto",
          accountId: null,
          effectiveAccountId: "claude-work",
          generation: 1,
        },
      }),
    ]);
    await mockAccounts(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Manage agent accounts" }).hover();
    await page.getByRole("button", { name: "Switch Claude to home@x.com" }).click();

    const dialog = page.getByRole("dialog", { name: "Set Claude default" });
    await dialog.getByRole("radio", { name: /Also switch active sessions/ }).hover();
    await expect(page.getByTestId("auth-accounts-popover")).toBeHidden();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /Also switch active sessions/ }).check();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test.describe("touch default confirmation", () => {
    test.use({ hasTouch: true });

    test("keeps scope and pending confirmation after the footer dismisses", async ({ page }) => {
      await page.addInitScript(() => {
        const matchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const result = matchMedia(query);
          if (query === "(hover: none) and (pointer: coarse)") {
            Object.defineProperty(result, "matches", { value: true });
          }
          return result;
        };
      });
      await mockSessions(page, [
        makeWorkingSession({
          id: "auth-default-touch",
          auth: {
            sessionId: "auth-default-touch",
            provider: "claude",
            mode: "auto",
            accountId: null,
            effectiveAccountId: "claude-work",
            generation: 1,
          },
        }),
      ]);
      await mockAccounts(page);
      const updates: unknown[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("/api/auth-pools/claude", async (route) => {
        updates.push(route.request().postDataJSON());
        await gate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ pool: {}, moved: 1 }),
        });
      });
      try {
        await page.goto("/");
        await page.getByRole("button", { name: "Manage agent accounts" }).tap();
        await page.getByRole("button", { name: "Switch Claude to home@x.com" }).tap();
        const dialog = page.getByRole("dialog", { name: "Set Claude default" });
        const active = dialog.getByRole("radio", { name: /Also switch active sessions/ });
        await active.tap();
        await expect(active).toBeChecked();
        await expect(page.getByTestId("auth-accounts-popover")).toBeHidden();
        await dialog.getByRole("button", { name: "Set default", exact: true }).tap();

        await expect.poll(() => updates).toEqual([
          { defaultAccountId: "claude-home", applyToActive: true },
        ]);
        await expect(dialog.getByRole("button", { name: "Setting default" })).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        release();
        await expect(dialog).toBeHidden();
      } finally {
        release();
      }
    });
  });

  test("adding an account and closing its dialog deletes the new account", async ({ page }) => {
    await mockSessions(page, []);
    await mockAccounts(page);
    await page.route("/api/auth-accounts", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          account: { id: "claude-added", provider: "claude", createdAt: "2026-01-01T12:00:00Z" },
        }),
      });
    });
    await page.route("/api/auth-accounts/claude-added/login-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accountId: "claude-added", status: "sign-in-required" }),
      });
    });
    const deletes: string[] = [];
    await page.route("/api/auth-accounts/claude-added", async (route) => {
      deletes.push(route.request().method());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ removed: "claude-added" }),
      });
    });
    await page.goto("/");
    await openMenu(page);

    await page.getByRole("button", { name: "+ Add Claude account" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Claude account" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect.poll(() => deletes).toEqual(["DELETE"]);
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
    await home.getByRole("button", { name: "Remove home@x.com" }).click();
    await expect(home.getByText("Remove home@x.com?")).toBeVisible();
    await home.getByRole("button", { name: "Cancel" }).click();
    expect(deletes).toEqual([]);

    await home.getByRole("button", { name: "Remove home@x.com" }).click();
    await home.getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => deletes).toEqual(["DELETE"]);
  });

  test("cancelling sign-in leaves the signed-out row with its Sign in button", async ({ page }) => {
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
    await row.getByRole("button", { name: "Sign in New Codex account" }).click();
    const dialog = page.getByRole("dialog", { name: /Sign in Codex/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByText("Waiting for the device code…")).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(dialog).toBeHidden();
    expect(inputs).toEqual([{ cancel: true }]);
    // Well under the 30s accounts cache window: the cancel itself refetches.
    await expect(row.getByRole("button", { name: "Sign in New Codex account" })).toBeVisible({
      timeout: 5_000,
    });
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

test.describe("Spawn account picker", () => {
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

    const picker = page.getByRole("combobox", { name: "Spawn account" });
    await expect(
      picker.getByRole("option", { name: "Account · Auto (now alek@x.com)" }),
    ).toBeAttached();
    await expect(picker.getByRole("option", { name: "Account · home@x.com" })).toBeEnabled();
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

    await expect(page.getByRole("combobox", { name: "Spawn account" })).toHaveCount(0);
  });

  test("never offers an account without an identity", async ({ page }) => {
    await mockSessions(page, [], PROJECTS);
    await mockAccounts(page, () => ({
      status: 200,
      body: {
        accounts: [
          account({
            id: "codex-new",
            provider: "codex",
            displayName: "New Codex account",
            authenticated: false,
            status: "sign_in_required",
          }),
        ],
        pools: {},
      },
    }));
    await page.goto("/");
    await page.getByRole("button", { name: /spawn session/i }).click();
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");

    await expect(page.getByRole("combobox", { name: "Spawn account" })).toHaveCount(0);
    await expect(page.getByText("New Codex account")).toHaveCount(0);
  });
});

test.describe("Session switch account", () => {
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

    await page.getByRole("button", { name: "Switch account" }).click();
    const dialog = page.getByRole("dialog", { name: "Switch Claude account" });
    const group = dialog.getByRole("radiogroup", { name: "Switch Claude account" });
    await expect(group.getByRole("img", { name: "current" })).toBeVisible();
    await expect(group.getByRole("radio", { name: /home@x.com/ })).toBeEnabled();
    await group.getByRole("radio", { name: /Auto/ }).check();
    await dialog.getByRole("button", { name: "Switch", exact: true }).click();

    await expect.poll(() => switchBody).toEqual({ accountId: null });
    await expect(dialog).toBeHidden();
  });
});
