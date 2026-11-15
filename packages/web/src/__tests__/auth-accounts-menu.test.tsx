import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAccountSelect } from "@/components/AuthAccountSelect";
import { AuthAccountsMenu } from "@/components/AuthAccountsMenu";
import { SwitchAuthDialog } from "@/components/SwitchAuthDialog";
import type { AuthAccountsResponse, AuthLogin, SpurSessionAuth } from "@/lib/types";

const ACCOUNTS: AuthAccountsResponse = {
  accounts: [
    {
      id: "claude-work",
      provider: "claude",
      label: "Work",
      createdAt: "2026-01-01T00:00:00.000Z",
      authenticated: true,
      status: "ready",
    },
    {
      id: "claude-home",
      provider: "claude",
      label: "Home",
      createdAt: "2026-01-01T00:00:00.000Z",
      authenticated: true,
      status: "ready",
    },
    {
      id: "codex-new",
      provider: "codex",
      label: "Fresh",
      createdAt: "2026-01-01T00:00:00.000Z",
      authenticated: false,
      status: "sign_in_required",
    },
  ],
  pools: {
    claude: { defaultAccountId: "claude-work", defaultGeneration: 1, autoRotate: true },
  },
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let routes: Record<string, (call: Call) => { status?: number; payload: unknown }>;

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
  routes = { "GET /api/auth-accounts": () => ({ payload: ACCOUNTS }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const call = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
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

async function openMenu() {
  render(<AuthAccountsMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Manage agent accounts" }));
  return within(await screen.findByTestId("auth-section-claude"));
}

describe("AuthAccountsMenu", () => {
  it("lists Claude and Codex accounts with status, default, and rotation state", async () => {
    const claude = await openMenu();
    const codex = within(screen.getByTestId("auth-section-codex"));

    expect(await claude.findByText("2 ready")).toBeTruthy();
    expect(
      within(screen.getByTestId("auth-account-claude-work")).getByText("default"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("auth-account-claude-home")).queryByText("default"),
    ).toBeNull();
    expect((claude.getByLabelText("Auto-rotate claude accounts") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(codex.getByText("0 ready")).toBeTruthy();
    expect(codex.getByText("sign in required")).toBeTruthy();
    expect((codex.getByLabelText("Auto-rotate codex accounts") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("sets the provider default and toggles auto-rotate through the pool route", async () => {
    routes["PATCH /api/auth-pools/claude"] = () => ({ payload: { pool: {} } });
    const claude = await openMenu();

    const makeDefault = await claude.findByRole("button", {
      name: "Make claude account Home default",
    });
    expect(
      (
        claude.getByRole("button", {
          name: "Make claude account Work default",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(makeDefault);
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/auth-pools/claude",
        method: "PATCH",
        body: { defaultAccountId: "claude-home" },
      }),
    );

    await waitFor(() =>
      expect(
        (claude.getByLabelText("Auto-rotate claude accounts") as HTMLInputElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(claude.getByLabelText("Auto-rotate claude accounts"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/auth-pools/claude",
        method: "PATCH",
        body: { autoRotate: false },
      }),
    );
  });

  it("removes an account and shows the daemon conflict", async () => {
    routes["DELETE /api/auth-accounts/claude-home"] = () => ({
      status: 409,
      payload: { error: "Cannot remove account claude-home: in use by a running session" },
    });
    const claude = await openMenu();

    fireEvent.click(await claude.findByRole("button", { name: "Remove claude account Home" }));

    expect(await claude.findByText(/in use by a running session/)).toBeTruthy();
  });

  it("adds a Codex account, starts sign-in, and shows the URL and device code", async () => {
    const login: AuthLogin = {
      accountId: "codex-2",
      status: "pending",
      url: "https://auth.example.test/device",
      userCode: "ABCD-1234",
    };
    routes["POST /api/auth-accounts"] = () => ({
      status: 201,
      payload: { account: { ...ACCOUNTS.accounts[2], id: "codex-2", label: "Team" } },
    });
    routes["POST /api/auth-accounts/codex-2/login"] = () => ({ payload: login });
    routes["GET /api/auth-accounts/codex-2/login-status"] = () => ({ payload: login });
    await openMenu();
    const codex = within(screen.getByTestId("auth-section-codex"));

    fireEvent.change(codex.getByLabelText("New codex account label"), {
      target: { value: "  Team " },
    });
    fireEvent.click(codex.getByRole("button", { name: "Add codex account" }));

    const dialog = within(await screen.findByRole("dialog", { name: /Sign in codex/ }));
    expect(calls).toContainEqual({
      url: "/api/auth-accounts",
      method: "POST",
      body: { provider: "codex", label: "Team" },
    });
    expect(dialog.getByTestId("auth-login-url").getAttribute("href")).toBe(
      "https://auth.example.test/device",
    );
    expect(dialog.getByTestId("auth-login-user-code").textContent).toBe("ABCD-1234");
  });

  it("submits a pasted code, then closes once sign-in is ready", async () => {
    let status: AuthLogin["status"] = "pending";
    routes["POST /api/auth-accounts/codex-new/login"] = () => ({
      payload: { accountId: "codex-new", status: "pending", prompt: "Paste the code" },
    });
    routes["POST /api/auth-accounts/codex-new/login-input"] = () => {
      status = "ready";
      return { payload: { accountId: "codex-new", status } };
    };
    routes["GET /api/auth-accounts/codex-new/login-status"] = () => ({
      payload: { accountId: "codex-new", status },
    });
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in codex account Fresh" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Sign in codex/ }));
    expect(dialog.getByText("Paste the code")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("Authorization code"), {
      target: { value: " code-xyz " },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toContainEqual({
      url: "/api/auth-accounts/codex-new/login-input",
      method: "POST",
      body: { input: "code-xyz" },
    });
  });

  it("cancels sign-in through login-input", async () => {
    routes["POST /api/auth-accounts/codex-new/login"] = () => ({
      payload: { accountId: "codex-new", status: "pending" },
    });
    routes["GET /api/auth-accounts/codex-new/login-status"] = () => ({
      payload: { accountId: "codex-new", status: "pending" },
    });
    routes["POST /api/auth-accounts/codex-new/login-input"] = () => ({
      payload: { accountId: "codex-new", status: "sign-in-required" },
    });
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in codex account Fresh" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Sign in codex/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toContainEqual({
      url: "/api/auth-accounts/codex-new/login-input",
      method: "POST",
      body: { cancel: true },
    });
  });
});

describe("AuthAccountSelect", () => {
  it("offers Auto plus provider accounts and disables accounts that need sign-in", async () => {
    const onChange = vi.fn();
    render(<AuthAccountSelect agent="codex" onChange={onChange} value={null} />);

    const select = (await screen.findByLabelText("Spawn auth")) as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => [option.text, option.disabled]);
    expect(options).toEqual([
      ["Auth · Auto", false],
      ["Auth · Fresh (sign in required)", true],
    ]);
  });

  it("maps a pick to the account id and Auto to null", async () => {
    const onChange = vi.fn();
    render(<AuthAccountSelect agent="claude" onChange={onChange} value="claude-work" />);

    const select = await screen.findByLabelText("Spawn auth");
    fireEvent.change(select, { target: { value: "claude-home" } });
    fireEvent.change(select, { target: { value: "" } });

    expect(onChange.mock.calls).toEqual([["claude-home"], [null]]);
  });

  it("renders nothing for an agent without managed accounts", async () => {
    routes["GET /api/auth-accounts"] = () => ({
      payload: { accounts: ACCOUNTS.accounts.filter((a) => a.provider === "claude"), pools: {} },
    });
    const { container } = render(
      <AuthAccountSelect agent="codex" onChange={vi.fn()} value={null} />,
    );
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.querySelector("select")).toBeNull();
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

  it("shows the effective account and switches a pinned session back to Auto", async () => {
    const onConfirm = vi.fn();
    render(
      <SwitchAuthDialog
        auth={auth}
        errorMessage={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        status="idle"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("switch-auth-current").textContent).toMatch(/Now: Work \(pinned\)/),
    );
    const switchButton = screen.getByRole("button", { name: "Switch" }) as HTMLButtonElement;
    expect(switchButton.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("switch-auth-account"), { target: { value: "" } });
    fireEvent.click(switchButton);

    expect(onConfirm).toHaveBeenCalledWith(null, false);
  });

  it("pins an Auto session to a ready account of its own provider", async () => {
    const onConfirm = vi.fn();
    render(
      <SwitchAuthDialog
        auth={{ ...auth, mode: "auto", accountId: null }}
        errorMessage={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        status="idle"
      />,
    );

    const select = (await screen.findByTestId("switch-auth-account")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      "Auto",
      "Work",
      "Home",
    ]);
    fireEvent.change(select, { target: { value: "claude-home" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    expect(onConfirm).toHaveBeenCalledWith("claude-home", false);
  });
});
