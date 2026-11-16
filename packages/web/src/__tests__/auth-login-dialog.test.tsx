import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthLoginDialog } from "@/components/AuthLoginDialog";
import type { AuthLogin } from "@/lib/types";

const CLAUDE = { id: "claude-new", provider: "claude", label: "work" } as const;
const CODEX = { id: "codex-new", provider: "codex", label: "team" } as const;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let routes: Record<string, (call: Call) => { status?: number; payload: unknown }>;
const onClose = vi.fn();
const onContinueInTerminal = vi.fn();

function pending(extra: Partial<AuthLogin> = {}, accountId = CLAUDE.id): AuthLogin {
  return { accountId, status: "pending", ...extra };
}

let client: QueryClient;

function render(account: typeof CLAUDE | typeof CODEX = CLAUDE) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(
    <AuthLoginDialog
      account={account}
      onClose={onClose}
      onContinueInTerminal={onContinueInTerminal}
    />,
    { wrapper: Wrapper },
  );
}

function route(
  method: string,
  path: string,
  handler: (call: Call) => { status?: number; payload: unknown },
) {
  routes[`${method} ${path}`] = handler;
}

function callsTo(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.url === path);
}

beforeEach(() => {
  calls = [];
  routes = {};
  onClose.mockReset();
  onContinueInTerminal.mockReset();
  // Cancel is accepted by default; refetches of the shared lists are not under test.
  route("POST", "/api/auth-accounts/claude-new/login-input", () => ({
    payload: { accountId: CLAUDE.id, status: "sign-in-required" },
  }));
  route("POST", "/api/auth-accounts/codex-new/login-input", () => ({
    payload: { accountId: CODEX.id, status: "sign-in-required" },
  }));
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

function terminalIcon(): HTMLElement {
  return screen.getByRole("button", { name: "Continue in terminal" });
}

async function startClaudeLink(
  login: AuthLogin = pending({ url: "https://claude.ai/oauth/authorize?x=1", stage: "authorize" }),
) {
  route("POST", "/api/auth-accounts/claude-new/login", () => ({ payload: login }));
  route("GET", "/api/auth-accounts/claude-new/login-status", () => ({ payload: login }));
  render(CLAUDE);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByTestId("auth-login-url");
}

describe("AuthLoginDialog picker", () => {
  it("offers two Claude methods and starts nothing until Continue", () => {
    render(CLAUDE);

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["oauth", "api_key"]);
    expect(radios[0]?.checked).toBe(true);
    expect(calls).toEqual([]);
  });

  it("offers three Codex methods with Device code preselected", () => {
    render(CODEX);

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["device", "browser", "api_key"]);
    expect(radios[0]?.checked).toBe(true);
    expect(screen.getByText("default")).toBeTruthy();
  });

  it("carries a header terminal icon with label and tooltip", () => {
    render(CLAUDE);

    expect(terminalIcon().getAttribute("title")).toBe("Continue in terminal");
  });

  it("returns focus to the opener when the dialog unmounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(CLAUDE);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Claude account/ }));
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("AuthLoginDialog link and paste", () => {
  it("shows the sign-in link, the dead-page hint and a disabled Submit", async () => {
    await startClaudeLink();

    expect(callsTo("POST", "/api/auth-accounts/claude-new/login")[0]?.body).toEqual({
      method: "oauth",
    });
    expect(screen.getByTestId("auth-login-url").getAttribute("href")).toBe(
      "https://claude.ai/oauth/authorize?x=1",
    );
    // The global `a` color rule would hide the label on the accent fill without the important utility.
    expect(screen.getByTestId("auth-login-url").className).toContain(
      "text-[var(--color-text-inverse)]!",
    );
    expect(screen.getByText(/Copy its address bar URL/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(terminalIcon()).toBeTruthy();
  });

  it("posts the pasted value and shows the verifying checklist, not success", async () => {
    await startClaudeLink();
    route("POST", "/api/auth-accounts/claude-new/login-input", () => ({
      payload: pending({ stage: "submitted" }),
    }));
    route("GET", "/api/auth-accounts/claude-new/login-status", () => ({
      payload: pending({ stage: "submitted" }),
    }));

    fireEvent.change(screen.getByLabelText("Returned URL or code"), {
      target: { value: "  abc#def  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Verifying sign-in…")).toBeTruthy();
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login-input")[0]?.body).toEqual({
      input: "abc#def",
    });
    expect(screen.getByTestId("auth-login-checklist")).toBeTruthy();
    expect(screen.queryByText(/Signed in · verified/)).toBeNull();
    expect(terminalIcon()).toBeTruthy();
  });

  it("words the code step as received while verifying", async () => {
    await startClaudeLink();
    route("POST", "/api/auth-accounts/claude-new/login-input", () => ({
      payload: pending({ stage: "verifying" }),
    }));
    route("GET", "/api/auth-accounts/claude-new/login-status", () => ({
      payload: pending({ stage: "verifying" }),
    }));

    fireEvent.change(screen.getByLabelText("Returned URL or code"), {
      target: { value: "abc#def" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Code received")).toBeTruthy();
    expect(screen.queryByText("Code accepted")).toBeNull();
  });

  it("starts Codex browser sign-in with the browser method", async () => {
    route("POST", "/api/auth-accounts/codex-new/login", () => ({
      payload: pending(
        { url: "https://auth.example.test/authorize", stage: "authorize" },
        CODEX.id,
      ),
    }));
    render(CODEX);

    fireEvent.click(screen.getByRole("radio", { name: /Browser/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("auth-login-url")).toBeTruthy();
    expect(callsTo("POST", "/api/auth-accounts/codex-new/login")[0]?.body).toEqual({
      method: "browser",
    });
    expect(screen.getByLabelText("Returned URL or code")).toBeTruthy();
  });
});

describe("AuthLoginDialog device code", () => {
  it("shows the code, Copy, the link and the polling note", async () => {
    route("POST", "/api/auth-accounts/codex-new/login", () => ({
      payload: pending(
        { url: "https://auth.example.test/codex/device", userCode: "IXP1-UC8L0" },
        CODEX.id,
      ),
    }));
    render(CODEX);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByTestId("auth-login-user-code")).textContent).toBe("IXP1-UC8L0");
    expect(callsTo("POST", "/api/auth-accounts/codex-new/login")[0]?.body).toEqual({
      method: "device",
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByTestId("auth-login-url").getAttribute("href")).toBe(
      "https://auth.example.test/codex/device",
    );
    expect(screen.getByText(/checks every 3s/)).toBeTruthy();
    expect(terminalIcon()).toBeTruthy();
  });
});

describe("AuthLoginDialog API key", () => {
  async function openKeyForm() {
    render(CLAUDE);
    fireEvent.click(screen.getByRole("radio", { name: /API key/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Label (required)");
  }

  it("keeps Save disabled until label and key are both set, with a masked key field", async () => {
    await openKeyForm();
    const label = screen.getByLabelText("Label (required)") as HTMLInputElement;
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

    expect(key.type).toBe("password");
    expect(label.value).toBe("work");
    expect(terminalIcon()).toBeTruthy();
    fireEvent.change(label, { target: { value: " " } });
    fireEvent.change(key, { target: { value: "sk-ant-key-12345" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(label, { target: { value: "ci" } });
    fireEvent.change(key, { target: { value: "" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(key, { target: { value: "sk-ant-key-12345" } });
    expect(save.disabled).toBe(false);
  });

  it("saves, then reports a rejected key with the key field cleared", async () => {
    route("POST", "/api/auth-accounts/claude-new/api-key", () => ({
      payload: { accountId: CLAUDE.id, status: "failed", errorCode: "key_rejected" },
    }));
    await openKeyForm();
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "ci-key" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-key-12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("API key rejected");
    expect(callsTo("POST", "/api/auth-accounts/claude-new/api-key")[0]?.body).toEqual({
      label: "ci-key",
      apiKey: "sk-ant-key-12345",
    });
    // The key never rests in the mutation cache or in cached query data.
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain("sk-ant-key-12345");
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state),
      ),
    ).not.toContain("sk-ant-key-12345");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(((await screen.findByLabelText("API key")) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Label (required)") as HTMLInputElement).value).toBe("ci-key");
  });
});

describe("AuthLoginDialog verification", () => {
  it("shows Verifying while the daemon tests the credential, then Signed in · verified", async () => {
    let status: AuthLogin = pending({ stage: "verifying" });
    route("POST", "/api/auth-accounts/claude-new/api-key", () => ({ payload: status }));
    route("GET", "/api/auth-accounts/claude-new/login-status", () => ({ payload: status }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("radio", { name: /API key/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: "sk-ant-key-12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Verifying sign-in…")).toBeTruthy();
    expect(screen.getByText("Key received")).toBeTruthy();
    expect(screen.queryByText("Key accepted")).toBeNull();
    expect(screen.queryByText(/Signed in · verified/)).toBeNull();
    status = { accountId: CLAUDE.id, status: "ready" };

    expect(await screen.findByText(/Signed in · verified/, {}, { timeout: 6_000 })).toBeTruthy();
  }, 10_000);

  it("shows verified with Done and no terminal icon, then closes on Done", async () => {
    route("POST", "/api/auth-accounts/claude-new/login", () => ({
      payload: { accountId: CLAUDE.id, status: "ready" },
    }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/Signed in · verified/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue in terminal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes itself 3 seconds after verified", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route("POST", "/api/auth-accounts/claude-new/login", () => ({
        payload: { accountId: CLAUDE.id, status: "ready" },
      }));
      render(CLAUDE);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByText(/Signed in · verified/);
      expect(onClose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AuthLoginDialog errors", () => {
  it.each([
    ["input_rejected", "Sign-in code rejected"],
    ["expired", "Sign-in expired"],
    ["key_rejected", "API key rejected"],
    ["not_confirmed", "Sign-in not confirmed"],
    ["identity", "Account not identified"],
    ["failed", "Sign-in failed"],
  ] as const)(
    "%s shows an alert with Continue in terminal and Try again",
    async (errorCode, title) => {
      route("POST", "/api/auth-accounts/claude-new/login", () => ({
        payload: { accountId: CLAUDE.id, status: "failed", errorCode },
      }));
      render(CLAUDE);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      expect((await screen.findByRole("alert")).textContent).toContain(title);
      // Header icon plus the primary footer button.
      expect(screen.getAllByRole("button", { name: "Continue in terminal" })).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    },
  );

  it("tells a blocked provider apart from a rejected code, with status only", async () => {
    route("POST", "/api/auth-accounts/claude-new/login", () => ({
      payload: {
        accountId: CLAUDE.id,
        status: "failed",
        errorCode: "provider_blocked",
        error: "Provider blocked the sign-in request (HTTP 403)",
      },
    }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in blocked");
    expect(alert.textContent).toContain(
      "Provider blocked the sign-in request (HTTP 403). Continue in terminal.",
    );
    expect(alert.textContent).not.toContain("code rejected");
    expect(screen.getAllByRole("button", { name: "Continue in terminal" })).toHaveLength(2);
  });

  it("shows a code the provider rejected", async () => {
    route("POST", "/api/auth-accounts/claude-new/login", () => ({
      payload: {
        accountId: CLAUDE.id,
        status: "failed",
        errorCode: "code_rejected",
        error: "Provider rejected the sign-in code (HTTP 400)",
      },
    }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in code rejected");
    expect(alert.textContent).toContain("Provider rejected the sign-in code (HTTP 400)");
  });

  it("says a device code expired", async () => {
    route("POST", "/api/auth-accounts/codex-new/login", () => ({
      payload: { accountId: CODEX.id, status: "failed", errorCode: "expired" },
    }));
    render(CODEX);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Device code expired");
  });

  it("shows a daemon start failure as an error and offers a retry", async () => {
    let attempts = 0;
    route("POST", "/api/auth-accounts/claude-new/login", () => {
      attempts += 1;
      return attempts === 1
        ? { status: 502, payload: { error: "daemon down" } }
        : { payload: pending({ url: "https://claude.ai/x", stage: "authorize" }) };
    });
    route("GET", "/api/auth-accounts/claude-new/login-status", () => ({
      payload: pending({ url: "https://claude.ai/x", stage: "authorize" }),
    }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toContain("daemon down");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("auth-login-url")).toBeTruthy();
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login")).toHaveLength(2);
  });

  it("restarts the same method on Try again", async () => {
    let attempts = 0;
    route("POST", "/api/auth-accounts/codex-new/login", () => {
      attempts += 1;
      return {
        payload:
          attempts === 1
            ? { accountId: CODEX.id, status: "failed", errorCode: "expired" }
            : pending({ userCode: "NEW-CODE" }, CODEX.id),
      };
    });
    route("GET", "/api/auth-accounts/codex-new/login-status", () => ({
      payload: pending({ userCode: "NEW-CODE" }, CODEX.id),
    }));
    render(CODEX);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect((await screen.findByTestId("auth-login-user-code")).textContent).toBe("NEW-CODE");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsTo("POST", "/api/auth-accounts/codex-new/login").map((call) => call.body)).toEqual([
      { method: "device" },
      { method: "device" },
    ]);
  });
});

describe("AuthLoginDialog terminal handoff and dismissal", () => {
  it("cancels the attempt, then continues in terminal, from the picker", async () => {
    render(CLAUDE);

    fireEvent.click(terminalIcon());

    await waitFor(() => expect(onContinueInTerminal).toHaveBeenCalledTimes(1));
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login-input")[0]?.body).toEqual({
      cancel: true,
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels before handing over from the link step", async () => {
    await startClaudeLink();

    fireEvent.click(terminalIcon());

    await waitFor(() => expect(onContinueInTerminal).toHaveBeenCalledTimes(1));
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login-input")[0]?.body).toEqual({
      cancel: true,
    });
  });

  it("hands over from the error step through the primary button", async () => {
    route("POST", "/api/auth-accounts/claude-new/login", () => ({
      payload: { accountId: CLAUDE.id, status: "failed", errorCode: "not_confirmed" },
    }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");

    const buttons = screen.getAllByRole("button", { name: "Continue in terminal" });
    fireEvent.click(buttons[1] as HTMLElement);

    await waitFor(() => expect(onContinueInTerminal).toHaveBeenCalledTimes(1));
  });

  it("still opens the terminal when the cancel request fails", async () => {
    route("POST", "/api/auth-accounts/claude-new/login-input", () => ({
      status: 502,
      payload: { error: "cancel failed" },
    }));
    render(CLAUDE);

    fireEvent.click(terminalIcon());

    await waitFor(() => expect(onContinueInTerminal).toHaveBeenCalledTimes(1));
  });

  it("closes without cancelling when no attempt was started here", async () => {
    render(CLAUDE);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close sign-in" }));

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([]);
  });

  it("closes during an attempt even when the cancel request fails", async () => {
    await startClaudeLink();
    route("POST", "/api/auth-accounts/claude-new/login-input", () => ({
      status: 502,
      payload: { error: "cancel failed" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Close sign-in" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login-input")[0]?.body).toEqual({
      cancel: true,
    });
  });

  it("cancels and closes on Escape", async () => {
    await startClaudeLink();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login-input")[0]?.body).toEqual({
      cancel: true,
    });
  });

  it("returns to the picker on Back after cancelling", async () => {
    await startClaudeLink();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("radiogroup", { name: "Sign-in method" })).toBeTruthy();
    expect(callsTo("POST", "/api/auth-accounts/claude-new/login-input")[0]?.body).toEqual({
      cancel: true,
    });
  });

  it("announces status through role=status", async () => {
    route("POST", "/api/auth-accounts/claude-new/login", () => ({
      payload: pending({ stage: "verifying" }),
    }));
    render(CLAUDE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("status", { name: "" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Verifying sign-in…"),
    );
  });
});
