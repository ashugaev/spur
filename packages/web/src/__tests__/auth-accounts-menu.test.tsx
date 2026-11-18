import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAccountSelect } from "@/components/AuthAccountSelect";
import { AuthAccountsMenu } from "@/components/AuthAccountsMenu";
import { SwitchAuthDialog } from "@/components/SwitchAuthDialog";
import { formatClockTime } from "@/lib/format";
import type {
  AuthAccountSummary,
  AuthAccountsResponse,
  AuthLogin,
  SpurSessionAuth,
} from "@/lib/types";

const COOLDOWN_UNTIL = "2026-01-01T14:05:00.000Z";
const UNTIL = formatClockTime(COOLDOWN_UNTIL);
const FETCHED_AT = "2026-01-01T12:00:00.000Z";

const base = {
  createdAt: "2026-01-01T00:00:00.000Z",
  authenticated: true,
  status: "ready",
  limited: false,
  credential: "oauth",
} as const;

const WORK: AuthAccountSummary = {
  ...base,
  id: "claude-work",
  provider: "claude",
  identity: { email: "alek@x.com", organizationName: "Intelas" },
  displayName: "alek@x.com",
  quota: {
    leftPercent: 62,
    resetsAt: null,
    windows: [{ label: "5h", usedPercent: 38, remainingPercent: 62, resetsAt: COOLDOWN_UNTIL }],
    fetchedAt: FETCHED_AT,
  },
};
const HOME: AuthAccountSummary = {
  ...base,
  id: "claude-home",
  provider: "claude",
  identity: { email: "home@x.com", organizationName: "Personal" },
  displayName: "home@x.com",
  limited: true,
  cooldownUntil: COOLDOWN_UNTIL,
};
const KEY: AuthAccountSummary = {
  ...base,
  id: "claude-key",
  provider: "claude",
  credential: "api_key",
  identity: { keyHint: "7Q2c" },
  displayName: "API key ····7Q2c",
};
const FRESH: AuthAccountSummary = {
  ...base,
  id: "codex-new",
  provider: "codex",
  authenticated: false,
  status: "sign_in_required",
  displayName: "New Codex account",
};
const PRO: AuthAccountSummary = {
  ...base,
  id: "codex-pro",
  provider: "codex",
  identity: { email: "codex@x.com", plan: "Pro" },
  displayName: "codex@x.com",
};

const ACCOUNTS: AuthAccountsResponse = {
  accounts: [WORK, HOME, KEY, FRESH, PRO],
  pools: {
    claude: { defaultAccountId: "claude-work", defaultGeneration: 1, autoRotate: true },
    codex: { defaultAccountId: "codex-pro", defaultGeneration: 0, autoRotate: false },
  },
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let routes: Record<string, (call: Call) => { status?: number; payload: unknown }>;
// Holds every response until resolved; null answers immediately.
let gate: Promise<void> | null;

function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper });
}

beforeEach(() => {
  calls = [];
  gate = null;
  routes = { "GET /api/auth-accounts": () => ({ payload: ACCOUNTS }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const call = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (gate) await gate;
      const handler = routes[`${method} ${url}`];
      const { status = 200, payload } = handler
        ? handler(call)
        : { status: 404, payload: { error: "unmocked" } };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Focus leaves the popover for the page body, as a click outside does. */
const leaveForBody = () =>
  fireEvent.focusOut(screen.getByTestId("auth-accounts-popover"), {
    relatedTarget: document.body,
  });

async function openMenu() {
  render(<AuthAccountsMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Manage agent accounts" }));
  return within(await screen.findByTestId("auth-section-claude"));
}

describe("AuthAccountsMenu", () => {
  it("names each account by identity with quota percent, and no status words", async () => {
    const claude = await openMenu();
    const codex = within(screen.getByTestId("auth-section-codex"));

    const work = within(screen.getByTestId("auth-account-claude-work"));
    expect(work.getByText("alek@x.com").getAttribute("title")).toBe("alek@x.com");
    expect(work.getByText("Intelas").getAttribute("title")).toBe("Intelas");
    expect(work.getByText("62% left").parentElement?.getAttribute("title")).toBe(
      `5h 62% left · resets ${UNTIL}`,
    );
    const home = within(screen.getByTestId("auth-account-claude-home"));
    expect(home.getByText("0% left")).toBeTruthy();
    expect(home.getByText(`resets ${UNTIL}`)).toBeTruthy();
    const key = within(screen.getByTestId("auth-account-claude-key"));
    expect(key.getByText("API key ····7Q2c")).toBeTruthy();
    expect(key.getByText("Anthropic API")).toBeTruthy();
    expect(key.queryByText(/%/)).toBeNull();
    const fresh = within(screen.getByTestId("auth-account-codex-new"));
    expect(fresh.getByText("New Codex account").className).toContain("text-secondary");
    expect(fresh.queryByText(/%/)).toBeNull();

    const text = screen.getByTestId("auth-accounts-popover").textContent ?? "";
    expect(text).not.toMatch(/\bready\b|\bdefault\b|sign in required|signing in/i);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(claude.getByText("Claude")).toBeTruthy();
    expect((claude.getByLabelText("Auto-rotate Claude accounts") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((codex.getByLabelText("Auto-rotate Codex accounts") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("marks the in-use account with a check and offers Switch on the others", async () => {
    await openMenu();

    const work = within(screen.getByTestId("auth-account-claude-work"));
    expect(work.getByRole("img", { name: "In use" })).toBeTruthy();
    expect(work.queryByRole("button", { name: /Switch/ })).toBeNull();
    const home = within(screen.getByTestId("auth-account-claude-home"));
    expect(home.queryByRole("img", { name: "In use" })).toBeNull();
    expect(home.getByRole("button", { name: "Switch Claude to home@x.com" })).toBeTruthy();
  });

  it("shows Sign in only for accounts that are not ready", async () => {
    await openMenu();

    expect(screen.getAllByRole("button", { name: /^Sign in / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sign in New Codex account" })).toBeTruthy();
  });

  it("switches the provider default and toggles auto-rotate through the pool route", async () => {
    routes["PATCH /api/auth-pools/claude"] = () => ({ payload: { pool: {} } });
    const claude = await openMenu();

    fireEvent.click(await claude.findByRole("button", { name: "Switch Claude to home@x.com" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/auth-pools/claude",
        method: "PATCH",
        body: { defaultAccountId: "claude-home" },
      }),
    );

    await waitFor(() =>
      expect(
        (claude.getByLabelText("Auto-rotate Claude accounts") as HTMLInputElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(claude.getByLabelText("Auto-rotate Claude accounts"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/auth-pools/claude",
        method: "PATCH",
        body: { autoRotate: false },
      }),
    );
  });

  it("shows a loading row while accounts load, not an empty pool", async () => {
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<AuthAccountsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Manage agent accounts" }));

    expect(await screen.findByTestId("auth-accounts-loading")).toBeTruthy();
    expect(screen.queryByText("No Claude accounts.")).toBeNull();
    expect(screen.queryByTestId("auth-section-claude")).toBeNull();
    release();
    expect(await screen.findByTestId("auth-section-claude")).toBeTruthy();
  });

  it("hides sections on a load failure and retries", async () => {
    let failing = true;
    routes["GET /api/auth-accounts"] = () =>
      failing ? { status: 502, payload: { error: "daemon down" } } : { payload: ACCOUNTS };
    render(<AuthAccountsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Manage agent accounts" }));

    expect((await screen.findByRole("alert")).textContent).toBe("daemon down");
    expect(screen.queryByTestId("auth-section-claude")).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("auth-section-claude")).toBeTruthy();
  });

  it("removes an account only after a confirmation that names it", async () => {
    routes["DELETE /api/auth-accounts/claude-home"] = () => ({
      payload: { removed: "claude-home" },
    });
    const claude = await openMenu();

    fireEvent.click(await claude.findByRole("button", { name: "Remove home@x.com" }));
    expect(claude.getByText("Remove home@x.com?")).toBeTruthy();
    expect(claude.getByText("Its sign-in is deleted from Spur.")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(claude.getByRole("button", { name: "Cancel" }));
    expect(claude.queryByText("Remove home@x.com?")).toBeNull();
    expect(claude.getByRole("button", { name: "Remove home@x.com" })).toBeTruthy();

    fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
    fireEvent.click(claude.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/auth-accounts/claude-home",
        method: "DELETE",
        body: undefined,
      }),
    );
  });

  it("moves focus into the confirm row and back to the trash button, keeping the popover open", async () => {
    const claude = await openMenu();
    const popover = screen.getByTestId("auth-accounts-popover");
    const trash = claude.getByRole("button", { name: "Remove home@x.com" });
    trash.focus();

    fireEvent.click(trash);
    // The browser blurs the unmounted trash button with no related target.
    fireEvent.focusOut(popover, { relatedTarget: null });

    const cancel = claude.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    expect(screen.queryByTestId("auth-accounts-popover")).toBeTruthy();

    fireEvent.click(cancel);
    fireEvent.focusOut(popover, { relatedTarget: null });

    expect(screen.queryByTestId("auth-accounts-popover")).toBeTruthy();
    expect(document.activeElement).toBe(claude.getByRole("button", { name: "Remove home@x.com" }));
  });

  describe("after a removal", () => {
    let removed: string[];
    beforeEach(() => {
      removed = [];
      routes["GET /api/auth-accounts"] = () => ({
        payload: {
          ...ACCOUNTS,
          accounts: ACCOUNTS.accounts.filter((entry) => !removed.includes(entry.id)),
        },
      });
      for (const id of ["claude-home", "claude-key"]) {
        routes[`DELETE /api/auth-accounts/${id}`] = () => {
          removed.push(id);
          return { payload: { removed: id } };
        };
      }
    });

    it("moves focus to the next row's trash button and keeps the popover open", async () => {
      const claude = await openMenu();
      const popover = screen.getByTestId("auth-accounts-popover");
      claude.getByRole("button", { name: "Remove home@x.com" }).focus();
      fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
      fireEvent.click(claude.getByRole("button", { name: "Remove" }));
      fireEvent.focusOut(popover, { relatedTarget: null });

      await waitFor(() => expect(screen.queryByTestId("auth-account-claude-home")).toBeNull());
      expect(document.activeElement).toBe(
        claude.getByRole("button", { name: "Remove API key ····7Q2c" }),
      );
      expect(screen.queryByTestId("auth-accounts-popover")).toBeTruthy();
    });

    it("releases the blur guard after trash then Cancel", async () => {
      const claude = await openMenu();
      claude.getByRole("button", { name: "Remove home@x.com" }).focus();
      fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
      fireEvent.click(claude.getByRole("button", { name: "Cancel" }));
      await settle(20);

      leaveForBody();

      await waitFor(() => expect(screen.queryByTestId("auth-accounts-popover")).toBeNull());
    });

    it("releases the blur guard after a successful remove and its refetch", async () => {
      const claude = await openMenu();
      fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
      await settle(20);
      fireEvent.click(claude.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByTestId("auth-account-claude-home")).toBeNull());
      await settle(150);

      leaveForBody();

      await waitFor(() => expect(screen.queryByTestId("auth-accounts-popover")).toBeNull());
    });

    it("releases the guard as soon as focus has moved, not only after the backstop delay", async () => {
      const claude = await openMenu();
      fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
      await settle(20);
      fireEvent.click(claude.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByTestId("auth-account-claude-home")).toBeNull());

      leaveForBody();

      await waitFor(() => expect(screen.queryByTestId("auth-accounts-popover")).toBeNull());
    });

    it("releases the blur guard when the refetch after a remove fails", async () => {
      const claude = await openMenu();
      routes["GET /api/auth-accounts"] = () => ({ status: 502, payload: { error: "down" } });
      fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
      await settle(20);
      fireEvent.click(claude.getByRole("button", { name: "Remove" }));
      await waitFor(() =>
        expect(
          calls.filter((call) => call.method === "GET" && call.url === "/api/auth-accounts"),
        ).toHaveLength(2),
      );
      await settle(150);

      leaveForBody();

      await waitFor(() => expect(screen.queryByTestId("auth-accounts-popover")).toBeNull());
    });

    it("moves focus to the Add button when the last row is removed", async () => {
      const claude = await openMenu();
      fireEvent.click(claude.getByRole("button", { name: "Remove API key ····7Q2c" }));
      fireEvent.click(claude.getByRole("button", { name: "Remove" }));

      await waitFor(() => expect(screen.queryByTestId("auth-account-claude-key")).toBeNull());
      expect(document.activeElement).toBe(
        claude.getByRole("button", { name: "+ Add Claude account" }),
      );
    });
  });

  it("still closes the popover when focus leaves it for elsewhere", async () => {
    await openMenu();
    await new Promise((resolve) => setTimeout(resolve, 10));

    fireEvent.focusOut(screen.getByTestId("auth-accounts-popover"), {
      relatedTarget: document.body,
    });

    await waitFor(() => expect(screen.queryByTestId("auth-accounts-popover")).toBeNull());
  });

  it("returns focus to the same row's trash button after a 409 on remove", async () => {
    routes["DELETE /api/auth-accounts/claude-home"] = () => ({
      status: 409,
      payload: { error: "Cannot remove account claude-home: in use by a running session" },
    });
    const claude = await openMenu();
    claude.getByRole("button", { name: "Remove home@x.com" }).focus();
    fireEvent.click(claude.getByRole("button", { name: "Remove home@x.com" }));
    await settle(20);
    fireEvent.click(claude.getByRole("button", { name: "Remove" }));

    expect(await claude.findByText(/in use by a running session/)).toBeTruthy();

    expect(document.activeElement).toBe(claude.getByRole("button", { name: "Remove home@x.com" }));
    // The guard is released too: a real outside blur still closes the popover.
    await settle(20);
    leaveForBody();
    await waitFor(() => expect(screen.queryByTestId("auth-accounts-popover")).toBeNull());
  });

  describe("setting the default with running sessions", () => {
    const running = (id: string, mode: "auto" | "pinned", effectiveAccountId: string) => ({
      id,
      status: "running",
      runtimeAlive: true,
      auth: { provider: "claude", mode, effectiveAccountId },
    });
    const sessions = [
      running("a-1", "auto", "claude-work"),
      running("a-2", "auto", "claude-work"),
      running("a-3", "auto", "claude-home"),
      running("p-1", "pinned", "claude-key"),
      { ...running("a-4", "auto", "claude-work"), status: "stopped", runtimeAlive: false },
      { ...running("c-1", "auto", "codex-pro"), auth: { provider: "codex", mode: "auto" } },
    ];

    beforeEach(() => {
      routes["GET /api/sessions"] = () => ({ payload: { sessions } });
      routes["PATCH /api/auth-pools/claude"] = () => ({ payload: { pool: {}, moved: 0 } });
    });

    const openDialog = async () => {
      const claude = await openMenu();
      fireEvent.click(await claude.findByRole("button", { name: "Switch Claude to home@x.com" }));
      return within(await screen.findByRole("dialog", { name: "Set Claude default" }));
    };
    const patches = () => calls.filter((call) => call.method === "PATCH");

    it("asks for the scope, preselects only new sessions and counts active and pinned", async () => {
      const dialog = await openDialog();

      expect(dialog.getByText("Replaces alek@x.com.")).toBeTruthy();
      expect(dialog.getByText("home@x.com")).toBeTruthy();
      expect(
        (dialog.getByRole("radio", { name: /Only new sessions/ }) as HTMLInputElement).checked,
      ).toBe(true);
      expect(dialog.getByText("2 active")).toBeTruthy();
      expect(dialog.getByText("1 pinned session keeps its account.")).toBeTruthy();
      expect(patches()).toEqual([]);
    });

    it("sends applyToActive false for Only new sessions", async () => {
      const dialog = await openDialog();
      fireEvent.click(dialog.getByRole("button", { name: "Set default" }));

      await waitFor(() =>
        expect(patches()).toEqual([
          {
            url: "/api/auth-pools/claude",
            method: "PATCH",
            body: { defaultAccountId: "claude-home", applyToActive: false },
          },
        ]),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("sends applyToActive true for Also switch active sessions", async () => {
      const dialog = await openDialog();
      fireEvent.click(dialog.getByRole("radio", { name: /Also switch active sessions/ }));
      fireEvent.click(dialog.getByRole("button", { name: "Set default" }));

      await waitFor(() =>
        expect(patches()[0]?.body).toEqual({
          defaultAccountId: "claude-home",
          applyToActive: true,
        }),
      );
    });

    it("sends nothing when cancelled", async () => {
      const dialog = await openDialog();
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(patches()).toEqual([]);
    });

    it("applies at once when no running Auto session would move", async () => {
      routes["GET /api/sessions"] = () => ({ payload: { sessions: [sessions[3], sessions[4]] } });
      const claude = await openMenu();
      fireEvent.click(await claude.findByRole("button", { name: "Switch Claude to home@x.com" }));

      await waitFor(() =>
        expect(patches()).toEqual([
          {
            url: "/api/auth-pools/claude",
            method: "PATCH",
            body: { defaultAccountId: "claude-home" },
          },
        ]),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("shows the daemon conflict, then clears it when the next action starts", async () => {
    routes["DELETE /api/auth-accounts/claude-home"] = () => ({
      status: 409,
      payload: { error: "Cannot remove account claude-home: in use by a running session" },
    });
    routes["PATCH /api/auth-pools/claude"] = () => ({ payload: { pool: {} } });
    const claude = await openMenu();

    fireEvent.click(await claude.findByRole("button", { name: "Remove home@x.com" }));
    fireEvent.click(claude.getByRole("button", { name: "Remove" }));
    expect(await claude.findByText(/in use by a running session/)).toBeTruthy();

    await waitFor(() =>
      expect(
        (claude.getByRole("button", { name: "Switch Claude to home@x.com" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(claude.getByRole("button", { name: "Switch Claude to home@x.com" }));

    await waitFor(() => expect(claude.queryByText(/in use by a running session/)).toBeNull());
  });

  describe("adding an account", () => {
    const device: AuthLogin = {
      accountId: "codex-2",
      status: "pending",
      url: "https://auth.example.test/device",
      userCode: "ABCD-1234",
    };
    let loginStatus: () => { status?: number; payload: unknown };

    beforeEach(() => {
      routes["POST /api/auth-accounts"] = () => ({
        status: 201,
        payload: { account: { id: "codex-2", provider: "codex", createdAt: FETCHED_AT } },
      });
      routes["POST /api/auth-accounts/codex-2/login"] = () => ({ payload: device });
      routes["POST /api/auth-accounts/codex-2/login-input"] = () => ({
        payload: { accountId: "codex-2", status: "sign-in-required" },
      });
      routes["DELETE /api/auth-accounts/codex-2"] = () => ({ payload: { removed: "codex-2" } });
      loginStatus = () => ({ payload: { accountId: "codex-2", status: "sign-in-required" } });
      routes["GET /api/auth-accounts/codex-2/login-status"] = () => loginStatus();
    });

    async function addCodex() {
      await openMenu();
      fireEvent.click(screen.getByRole("button", { name: "+ Add Codex account" }));
      return within(await screen.findByRole("dialog", { name: "Add Codex account" }));
    }
    const deleted = () => calls.some((call) => call.method === "DELETE");

    it("posts only the provider, opens the picker without starting sign-in, then shows the device code", async () => {
      loginStatus = () => ({ payload: device });
      const dialog = await addCodex();

      expect(calls).toContainEqual({
        url: "/api/auth-accounts",
        method: "POST",
        body: { provider: "codex" },
      });
      expect(dialog.getByRole("radiogroup", { name: "Sign-in method" })).toBeTruthy();
      expect(calls.some((call) => call.url.endsWith("/login"))).toBe(false);

      fireEvent.click(dialog.getByRole("button", { name: "Continue" }));

      expect((await dialog.findByTestId("auth-login-user-code")).textContent).toBe("ABCD-1234");
      expect(calls).toContainEqual({
        url: "/api/auth-accounts/codex-2/login",
        method: "POST",
        body: { method: "device" },
      });
    });

    it("deletes the new account when the dialog closes while signed out", async () => {
      const dialog = await addCodex();
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(calls).toContainEqual({
          url: "/api/auth-accounts/codex-2",
          method: "DELETE",
          body: undefined,
        }),
      );
    });

    it("keeps the account when it reached ready", async () => {
      loginStatus = () => ({ payload: { accountId: "codex-2", status: "ready" } });
      const dialog = await addCodex();
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(calls.some((call) => call.url.endsWith("/login-status"))).toBe(true),
      );
      expect(deleted()).toBe(false);
    });

    it.each([
      ["a 500", () => ({ status: 500, payload: { error: "boom" } })],
      ["an unparsable answer", () => ({ payload: { nothing: true } })],
    ])("keeps the account when the status read fails with %s", async (_name, answer) => {
      loginStatus = answer;
      const dialog = await addCodex();
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(calls.some((call) => call.url.endsWith("/login-status"))).toBe(true),
      );
      expect(deleted()).toBe(false);
    });

    it("cancels a verifying sign-in first, then deletes the account", async () => {
      routes["POST /api/auth-accounts/codex-2/login"] = () => ({
        payload: { ...device, stage: "authorize" },
      });
      routes["POST /api/auth-accounts/codex-2/login-input"] = (call) => ({
        payload: {
          accountId: "codex-2",
          status: (call.body as { cancel?: boolean }).cancel ? "sign-in-required" : "pending",
          stage: "verifying",
        },
      });
      let verifying = true;
      loginStatus = () => ({
        payload: verifying
          ? { accountId: "codex-2", status: "pending", stage: "verifying" }
          : { accountId: "codex-2", status: "sign-in-required" },
      });
      const dialog = await addCodex();
      fireEvent.click(dialog.getByRole("radio", { name: /Browser/ }));
      fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
      fireEvent.change(await dialog.findByLabelText("Returned URL or code"), {
        target: { value: "http://localhost:1455/auth/callback?code=x&state=y" },
      });
      fireEvent.click(dialog.getByRole("button", { name: "Submit" }));
      await dialog.findByText("Verifying sign-in…");

      routes["POST /api/auth-accounts/codex-2/login-input"] = () => {
        verifying = false;
        return { payload: { accountId: "codex-2", status: "sign-in-required" } };
      };
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(deleted()).toBe(true));
      const order = calls.map((call) => `${call.method} ${call.url}`);
      const cancel = order.lastIndexOf("POST /api/auth-accounts/codex-2/login-input");
      const remove = order.indexOf("DELETE /api/auth-accounts/codex-2");
      expect(order.slice(cancel + 1, remove)).toContain(
        "GET /api/auth-accounts/codex-2/login-status",
      );
    });
  });

  it("opens the picker on Sign in without posting /login", async () => {
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in New Codex account" }));

    const dialog = within(
      await screen.findByRole("dialog", { name: "Sign in Codex · New Codex account" }),
    );
    expect(dialog.getAllByRole("radio")).toHaveLength(3);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("submits a pasted URL, then shows verified with the signed-in identity", async () => {
    let status: AuthLogin["status"] = "pending";
    routes["POST /api/auth-accounts/codex-new/login"] = () => ({
      payload: {
        accountId: "codex-new",
        status: "pending",
        stage: "authorize",
        url: "https://auth.example.test/authorize",
      },
    });
    routes["POST /api/auth-accounts/codex-new/login-input"] = () => {
      status = "ready";
      return { payload: { accountId: "codex-new", status } };
    };
    routes["GET /api/auth-accounts/codex-new/login-status"] = () => ({
      payload: { accountId: "codex-new", status },
    });
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in New Codex account" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Sign in Codex/ }));
    fireEvent.click(dialog.getByRole("radio", { name: /Browser/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    fireEvent.change(await dialog.findByLabelText("Returned URL or code"), {
      target: { value: " http://localhost:1455/auth/callback?code=x&state=y " },
    });
    routes["GET /api/auth-accounts"] = () => ({
      payload: {
        ...ACCOUNTS,
        accounts: ACCOUNTS.accounts.map((entry) =>
          entry.id === "codex-new"
            ? { ...entry, identity: { email: "new@x.com", plan: "Plus" }, status: "ready" }
            : entry,
        ),
      },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Submit" }));

    expect(await dialog.findByText("Signed in as new@x.com · Plus")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toContainEqual({
      url: "/api/auth-accounts/codex-new/login-input",
      method: "POST",
      body: { input: "http://localhost:1455/auth/callback?code=x&state=y" },
    });
  });

  it("cancels a started sign-in through login-input", async () => {
    routes["POST /api/auth-accounts/codex-new/login"] = () => ({
      payload: { accountId: "codex-new", status: "pending", userCode: "ABCD-1234" },
    });
    routes["GET /api/auth-accounts/codex-new/login-status"] = () => ({
      payload: { accountId: "codex-new", status: "pending", userCode: "ABCD-1234" },
    });
    routes["POST /api/auth-accounts/codex-new/login-input"] = () => ({
      payload: { accountId: "codex-new", status: "sign-in-required" },
    });
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in New Codex account" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Sign in Codex/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    await dialog.findByTestId("auth-login-user-code");
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toContainEqual({
      url: "/api/auth-accounts/codex-new/login-input",
      method: "POST",
      body: { cancel: true },
    });
    // An existing account is never deleted by closing its sign-in.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("focuses the selected method and closes the picker on Escape without cancelling", async () => {
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in New Codex account" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Sign in Codex/ }));
    expect(document.activeElement).toBe(dialog.getByRole("radio", { name: /Device code/ }));
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((call) => call.url.endsWith("/login-input"))).toBe(false);
  });

  it("reports a failed sign-in and restarts it on Try again", async () => {
    let started = 0;
    routes["POST /api/auth-accounts/codex-new/login"] = () => {
      started += 1;
      return {
        payload:
          started === 1
            ? { accountId: "codex-new", status: "failed" }
            : { accountId: "codex-new", status: "pending", userCode: "NEW-CODE" },
      };
    };
    routes["GET /api/auth-accounts/codex-new/login-status"] = () => ({
      payload: { accountId: "codex-new", status: "pending", userCode: "NEW-CODE" },
    });
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in New Codex account" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Sign in Codex/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    expect((await dialog.findByTestId("auth-login-error")).textContent).toContain("Sign-in failed");
    fireEvent.click(dialog.getByRole("button", { name: "Try again" }));

    expect((await dialog.findByTestId("auth-login-user-code")).textContent).toBe("NEW-CODE");
    expect(dialog.queryByTestId("auth-login-error")).toBeNull();
  });
});

describe("AuthAccountSelect", () => {
  async function loadedSelect(): Promise<HTMLSelectElement> {
    await screen.findByRole("option", { name: /^Account · Auto/ });
    return screen.getByLabelText("Spawn account") as HTMLSelectElement;
  }

  it("offers Auto (now ...) and identified accounts only, with signed-out ones disabled", async () => {
    render(<AuthAccountSelect agent="claude" onChange={vi.fn()} value={null} />);

    const select = await loadedSelect();
    expect(Array.from(select.options).map((option) => [option.text, option.disabled])).toEqual([
      ["Account · Auto (now alek@x.com)", false],
      ["Account · alek@x.com", false],
      ["Account · home@x.com", false],
      ["Account · API key ····7Q2c", false],
    ]);
    expect(screen.queryByText(/New Claude account/)).toBeNull();
  });

  it("hides a signed-out account that has no identity and disables an identified one", async () => {
    routes["GET /api/auth-accounts"] = () => ({
      payload: {
        ...ACCOUNTS,
        accounts: [{ ...PRO, status: "sign_in_required", authenticated: false }, FRESH],
      },
    });
    render(<AuthAccountSelect agent="codex" onChange={vi.fn()} value={null} />);

    const select = await loadedSelect();
    expect(Array.from(select.options).map((option) => [option.text, option.disabled])).toEqual([
      ["Account · Auto", false],
      ["Account · codex@x.com — signed out", true],
    ]);
  });

  it("shows a disabled placeholder while loading and after a load failure", async () => {
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    routes["GET /api/auth-accounts"] = () => ({ status: 502, payload: { error: "down" } });
    render(<AuthAccountSelect agent="claude" onChange={vi.fn()} value={null} />);

    const loading = screen.getByLabelText("Spawn account") as HTMLSelectElement;
    expect(loading.disabled).toBe(true);
    expect(loading.getAttribute("aria-busy")).toBe("true");
    release();

    await waitFor(() =>
      expect((screen.getByLabelText("Spawn account") as HTMLSelectElement).options[0]?.text).toBe(
        "Account · unavailable",
      ),
    );
    expect((screen.getByLabelText("Spawn account") as HTMLSelectElement).disabled).toBe(true);
  });

  it("maps a pick to the account id and Auto to null", async () => {
    const onChange = vi.fn();
    render(<AuthAccountSelect agent="claude" onChange={onChange} value="claude-work" />);

    const select = await loadedSelect();
    fireEvent.change(select, { target: { value: "claude-home" } });
    fireEvent.change(select, { target: { value: "" } });

    expect(onChange.mock.calls).toEqual([["claude-home"], [null]]);
  });

  it("renders nothing when no account of the agent has an identity", async () => {
    routes["GET /api/auth-accounts"] = () => ({
      payload: { accounts: [FRESH], pools: {} },
    });
    const { container } = render(
      <AuthAccountSelect agent="codex" onChange={vi.fn()} value={null} />,
    );
    await waitFor(() => expect(container.querySelector("select")).toBeNull());
    expect(calls.length).toBe(1);
  });

  it("never queries accounts for an unmanaged agent", () => {
    const { container } = render(
      <AuthAccountSelect agent="cursor" onChange={vi.fn()} value={null} />,
    );
    expect(container.querySelector("select")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("SwitchAuthDialog", () => {
  const auth: SpurSessionAuth = {
    sessionId: "s-1",
    provider: "claude",
    mode: "pinned",
    accountId: "claude-work",
    effectiveAccountId: "claude-work",
    generation: 1,
  };
  const dialog = (props: Partial<Parameters<typeof SwitchAuthDialog>[0]> = {}) => (
    <SwitchAuthDialog
      auth={auth}
      errorMessage={null}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      status="idle"
      {...props}
    />
  );

  it("shows loading text until accounts arrive", async () => {
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(dialog());

    expect(screen.getByRole("status", { name: "Loading accounts" })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByTestId("switch-auth-loading")).toBeNull());
  });

  it("cancels on Escape unless a switch is pending", () => {
    const onCancel = vi.fn();
    const { rerender } = render(dialog({ onCancel, status: "pending" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();

    rerender(dialog({ onCancel, status: "idle" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("is a radiogroup with Auto, one row per identified account and the current one checked", async () => {
    render(dialog());

    const group = await screen.findByRole("radiogroup", { name: "Switch Claude account" });
    await waitFor(() => expect(within(group).getAllByRole("radio")).toHaveLength(4));
    const rows = within(group);
    expect(rows.getByRole("radio", { name: /Auto/ })).toBeTruthy();
    expect(rows.getByText("now alek@x.com")).toBeTruthy();
    expect(screen.getByText("Applies from this session's next request.")).toBeTruthy();
    expect(rows.getAllByText("62% left")).toHaveLength(2);
    expect(rows.getByText("0% left")).toBeTruthy();
    expect(rows.getByRole("img", { name: "current" }).getAttribute("title")).toBe(
      "This session runs on it now",
    );
    expect(screen.getByText("Interrupt the request in flight")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("disables a signed-out account and keeps Switch off until the selection changes", async () => {
    routes["GET /api/auth-accounts"] = () => ({
      payload: {
        ...ACCOUNTS,
        accounts: [WORK, { ...HOME, status: "sign_in_required", authenticated: false }],
      },
    });
    const onConfirm = vi.fn();
    render(dialog({ onConfirm }));

    const home = (await screen.findByRole("radio", { name: /home@x.com/ })) as HTMLInputElement;
    expect(home.disabled).toBe(true);
    expect(screen.getByText("signed out")).toBeTruthy();
    // Only the radio dims; the row text stays at full contrast.
    expect(home.className).toContain("disabled:opacity-50");
    expect(home.closest("label")?.className).not.toMatch(/opacity/);
    expect((screen.getByRole("button", { name: "Switch" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    expect(onConfirm).toHaveBeenCalledWith(null, false);
  });

  it("always lists the pinned account, even without an identity, checked and disabled when signed out", async () => {
    routes["GET /api/auth-accounts"] = () => ({
      payload: {
        ...ACCOUNTS,
        accounts: [WORK, { ...FRESH, provider: "claude", id: "claude-new" }],
      },
    });
    render(
      dialog({ auth: { ...auth, accountId: "claude-new", effectiveAccountId: "claude-new" } }),
    );

    const row = (await screen.findByRole("radio", {
      name: /New Claude account/,
    })) as HTMLInputElement;
    expect(row.checked).toBe(true);
    expect(row.disabled).toBe(true);
    expect(screen.getByText("signed out")).toBeTruthy();
  });

  it("pins an Auto session to another account and passes the interrupt choice as force", async () => {
    const onConfirm = vi.fn();
    render(
      dialog({
        auth: { ...auth, mode: "auto", accountId: null },
        onConfirm,
      }),
    );

    fireEvent.click(await screen.findByRole("radio", { name: /home@x.com/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Interrupt the request in flight" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    expect(onConfirm).toHaveBeenCalledWith("claude-home", true);
  });
});
