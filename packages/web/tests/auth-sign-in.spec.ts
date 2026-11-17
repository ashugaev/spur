import { test, expect, type Locator, type Page, mockSessions } from "./fixtures.js";
import type { AuthAlert, AuthLogin, TerminalLogin } from "../src/lib/types";

const MANAGED_ALERT: AuthAlert = {
  id: "managed:claude-work",
  kind: "managed",
  provider: "claude",
  accountId: "claude-work",
  label: "alek@x.com",
  since: "2026-01-01T00:00:00.000Z",
  sessionsWaiting: 2,
};
const HOST_ALERT: AuthAlert = {
  id: "host:codex",
  kind: "host",
  provider: "codex",
  label: "Codex host",
  since: "2026-01-01T00:00:00.000Z",
};
const TERMINAL_ID = "auth-login-claude-work";
const LINK: AuthLogin = {
  accountId: "claude-work",
  status: "pending",
  stage: "authorize",
  url: "https://claude.ai/oauth/authorize?code=true",
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function terminalLogin(
  status: TerminalLogin["status"],
  reason?: TerminalLogin["reason"],
): TerminalLogin {
  return {
    id: TERMINAL_ID,
    target: { accountId: "claude-work", provider: "claude" },
    tmuxSession: TERMINAL_ID,
    status,
    ...(reason ? { reason } : {}),
    command: "claude auth login",
  };
}

async function mockAlerts(page: Page, alerts: AuthAlert[]) {
  await page.route("/api/auth-alerts", (route) => route.fulfill(json({ alerts })));
}

/** In-UI sign-in routes for the managed Claude account; input replies come from `onInput`. */
async function mockClaudeLogin(page: Page, onInput: (body: unknown) => AuthLogin) {
  const inputs: unknown[] = [];
  let current: AuthLogin = LINK;
  await page.route("/api/auth-accounts/claude-work/login", (route) => {
    current = LINK;
    return route.fulfill(json(current));
  });
  await page.route("/api/auth-accounts/claude-work/login-status", (route) =>
    route.fulfill(json(current)),
  );
  await page.route("/api/auth-accounts/claude-work/login-input", (route) => {
    const body = route.request().postDataJSON() as unknown;
    inputs.push(body);
    current =
      "cancel" in (body as object) ? { ...LINK, status: "sign-in-required" } : onInput(body);
    return route.fulfill(json(current));
  });
  return inputs;
}

async function openManagedDialog(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in alek@x.com" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in Claude · alek@x.com" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function toLinkStep(dialog: Locator) {
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByTestId("auth-login-url")).toBeVisible();
}

test.describe("Sign-in alerts and dialogs", () => {
  test.beforeEach(async ({ page }) => {
    await mockSessions(page, []);
  });

  test("S1 shows a row per alert; Sign in opens the dialog or the terminal; the icon opens the terminal", async ({
    page,
  }) => {
    await mockAlerts(page, [MANAGED_ALERT, HOST_ALERT]);
    // Escape on the picker still cancels server-side.
    await page.route("/api/auth-accounts/claude-work/login-input", (route) =>
      route.fulfill(json({ accountId: "claude-work", status: "sign-in-required" })),
    );
    const terminalPosts: unknown[] = [];
    await page.route("/api/auth-terminal-logins", (route) => {
      terminalPosts.push(route.request().postDataJSON());
      return route.fulfill(json(terminalLogin("running")));
    });
    await page.route(`/api/auth-terminal-logins/${TERMINAL_ID}`, (route) =>
      route.fulfill(
        route.request().method() === "DELETE"
          ? json({ stopped: TERMINAL_ID })
          : json(terminalLogin("running")),
      ),
    );
    await page.goto("/");

    const managed = page.getByTestId("auth-alert-managed:claude-work");
    const host = page.getByTestId("auth-alert-host:codex");
    await expect(managed).toContainText("managed account · 2 sessions waiting");
    await expect(host).toContainText("host credentials");

    await managed.getByRole("button", { name: "Sign in alek@x.com" }).click();
    await expect(page.getByRole("radiogroup", { name: "Sign-in method" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await host.getByRole("button", { name: "Sign in Codex host" }).click();
    await expect(page.getByRole("dialog", { name: "Codex host" })).toBeVisible();
    expect(terminalPosts).toEqual([{ host: "codex" }]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await managed.getByRole("button", { name: "Continue in terminal" }).click();
    await expect(page.getByRole("dialog", { name: "alek@x.com" })).toBeVisible();
    // The command bar shows the command the daemon reports.
    await expect(page.getByTestId("auth-terminal-command")).toHaveText("claude auth login");
    expect(terminalPosts.at(-1)).toEqual({ accountId: "claude-work" });
  });

  test("S3 S6 pasted URL is verified before success shows", async ({ page }) => {
    await mockAlerts(page, [MANAGED_ALERT]);
    const inputs = await mockClaudeLogin(page, () => ({
      accountId: "claude-work",
      status: "pending",
      stage: "verifying",
    }));
    const dialog = await openManagedDialog(page);
    await toLinkStep(dialog);

    await expect(dialog.getByText(/Copy its address bar URL/)).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Submit" });
    await expect(submit).toBeDisabled();
    await dialog
      .getByLabel("Returned URL or code")
      .fill("http://localhost:54545/callback?code=abc&state=def");
    await submit.click();

    await expect(dialog.getByText("Verifying sign-in…")).toBeVisible();
    await expect(dialog.getByText("Signed in")).toHaveCount(0);
    expect(inputs).toEqual([{ input: "http://localhost:54545/callback?code=abc&state=def" }]);
    // Next poll (3s) reports ready.
    await page.route("/api/auth-accounts/claude-work/login-status", (route) =>
      route.fulfill(json({ accountId: "claude-work", status: "ready" })),
    );
    await expect(dialog.getByText("Signed in")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("button", { name: "Continue in terminal" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("S7 a failed verification shows Continue in terminal and Try again, never success", async ({
    page,
  }) => {
    await mockAlerts(page, [MANAGED_ALERT]);
    await mockClaudeLogin(page, () => ({
      accountId: "claude-work",
      status: "failed",
      errorCode: "not_confirmed",
    }));
    const dialog = await openManagedDialog(page);
    await toLinkStep(dialog);

    await dialog.getByLabel("Returned URL or code").fill("code#state");
    await dialog.getByRole("button", { name: "Submit" }).click();

    await expect(dialog.getByRole("alert")).toContainText("Sign-in not confirmed");
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Continue in terminal" })).toHaveCount(2);
    await expect(dialog.getByText("Signed in")).toHaveCount(0);
  });

  test("S7b a duplicate account reads Account already added, never success", async ({ page }) => {
    await mockAlerts(page, [MANAGED_ALERT]);
    await mockClaudeLogin(page, () => ({
      accountId: "claude-work",
      status: "failed",
      errorCode: "duplicate",
    }));
    const dialog = await openManagedDialog(page);
    await toLinkStep(dialog);

    await dialog.getByLabel("Returned URL or code").fill("code#state");
    await dialog.getByRole("button", { name: "Submit" }).click();

    await expect(dialog.getByRole("alert")).toContainText("Account already added");
    await expect(dialog.getByText("Signed in")).toHaveCount(0);
  });

  test("S8 the header icon cancels the attempt, then opens the terminal for the same account", async ({
    page,
  }) => {
    await mockAlerts(page, [MANAGED_ALERT]);
    const order: string[] = [];
    await mockClaudeLogin(page, () => LINK);
    await page.route("/api/auth-accounts/claude-work/login-input", (route) => {
      order.push("cancel");
      return route.fulfill(json({ ...LINK, status: "sign-in-required" }));
    });
    await page.route("/api/auth-terminal-logins", (route) => {
      order.push(`terminal ${JSON.stringify(route.request().postDataJSON())}`);
      return route.fulfill(json(terminalLogin("running")));
    });
    await page.route(`/api/auth-terminal-logins/${TERMINAL_ID}`, (route) =>
      route.fulfill(json(terminalLogin("running"))),
    );
    const dialog = await openManagedDialog(page);
    await toLinkStep(dialog);

    await dialog.getByRole("button", { name: "Continue in terminal" }).click();

    await expect(page.getByRole("dialog", { name: "alek@x.com" })).toBeVisible();
    await expect.poll(() => order).toEqual(["cancel", 'terminal {"accountId":"claude-work"}']);
  });

  test("S10 a terminal that exits without verification shows neutral Not signed in", async ({
    page,
  }) => {
    await mockAlerts(page, [MANAGED_ALERT]);
    await page.route("/api/auth-terminal-logins", (route) =>
      route.fulfill(json(terminalLogin("not_signed_in", "exited"))),
    );
    await page.route(`/api/auth-terminal-logins/${TERMINAL_ID}`, (route) =>
      route.fulfill(
        route.request().method() === "DELETE"
          ? json({ stopped: TERMINAL_ID })
          : json(terminalLogin("not_signed_in", "exited")),
      ),
    );
    await page.goto("/");

    await page
      .getByTestId("auth-alert-managed:claude-work")
      .getByRole("button", { name: "Continue in terminal" })
      .click();

    const dialog = page.getByRole("dialog", { name: "alek@x.com" });
    await expect(dialog.getByText("Not signed in")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Restart terminal" })).toBeVisible();
    await expect(dialog.getByText(/Signed in/)).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  test("S10 a terminal reaching ready shows Signed in · verified", async ({ page }) => {
    await mockAlerts(page, [MANAGED_ALERT]);
    await page.route("/api/auth-terminal-logins", (route) =>
      route.fulfill(json(terminalLogin("ready"))),
    );
    await page.goto("/");

    await page
      .getByTestId("auth-alert-managed:claude-work")
      .getByRole("button", { name: "Continue in terminal" })
      .click();

    await expect(page.getByText(/Signed in as alek@x.com/)).toBeVisible();
  });
});

test.describe("Sign-in at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("S11 the banner and the device step do not overflow", async ({ page }) => {
    await mockSessions(page, []);
    await mockAlerts(page, [
      MANAGED_ALERT,
      HOST_ALERT,
      {
        id: "managed:codex-team",
        kind: "managed",
        provider: "codex",
        accountId: "codex-team",
        label: "team",
        since: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const device: AuthLogin = {
      accountId: "codex-team",
      status: "pending",
      url: "https://auth.openai.com/codex/device",
      userCode: "IXP1-UC8L0",
    };
    await page.route("/api/auth-accounts/codex-team/login", (route) => route.fulfill(json(device)));
    await page.route("/api/auth-accounts/codex-team/login-status", (route) =>
      route.fulfill(json(device)),
    );
    const noOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await page.goto("/");

    await expect(page.getByTestId("auth-alert-managed:claude-work")).toBeVisible();
    expect(await noOverflow()).toBe(true);

    await page.getByRole("button", { name: "Sign in team" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign in Codex · team" });
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByTestId("auth-login-user-code")).toHaveText("IXP1-UC8L0");
    await expect(dialog.getByRole("button", { name: "Continue in terminal" })).toBeVisible();
    expect(await noOverflow()).toBe(true);
    const bounds = await dialog.locator("> div").boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390).toBe(true);
  });
});
