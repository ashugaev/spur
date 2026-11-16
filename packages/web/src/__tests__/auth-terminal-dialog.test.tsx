import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTerminalDialog } from "@/components/AuthTerminalDialog";
import type { SignInAccount } from "@/components/AuthLoginDialog";
import type { TerminalLogin } from "@/lib/types";

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({
    sessionId,
    agentInputEnabled,
    hideHeader,
  }: {
    sessionId: string;
    agentInputEnabled?: boolean;
    hideHeader?: boolean;
  }) => (
    <div
      data-hide-header={String(hideHeader)}
      data-input={String(agentInputEnabled)}
      data-testid="direct-terminal"
    >
      {sessionId}
    </div>
  ),
}));

const ID = "auth-login-claude-work";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
// Holds every POST response until resolved; null answers immediately.
let postGate: Promise<void> | null;
let responses: Record<string, () => { status?: number; payload: unknown }>;
const onClose = vi.fn();

function terminal(
  status: TerminalLogin["status"],
  reason?: TerminalLogin["reason"],
): TerminalLogin {
  return {
    id: ID,
    target: { accountId: "claude-work", provider: "claude" },
    tmuxSession: ID,
    status,
    ...(reason ? { reason } : {}),
  };
}

const ACCOUNT: SignInAccount = {
  id: "claude-work",
  provider: "claude",
  displayName: "alek@x.com",
  identity: { email: "alek@x.com", organizationName: "Intelas" },
};

function render(
  target: { accountId: string } | { host: "claude" | "codex" } = { accountId: "claude-work" },
  strict = false,
  account: SignInAccount | undefined = "host" in target ? undefined : ACCOUNT,
) {
  // Strict runs use the app's own query defaults: the stranding bug only showed with them.
  const client = new QueryClient({
    defaultOptions: {
      queries: strict
        ? { staleTime: 5_000, gcTime: 300_000, retry: 1, refetchOnWindowFocus: false }
        : { retry: false, refetchOnWindowFocus: false },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(
    <AuthTerminalDialog
      {...(account ? { account } : {})}
      provider="claude"
      target={target}
      onClose={onClose}
    />,
    { wrapper: strict ? StrictWrapper(Wrapper) : Wrapper },
  );
}

function StrictWrapper(Inner: ({ children }: { children: ReactNode }) => ReactNode) {
  return function Strict({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <Inner>{children}</Inner>
      </StrictMode>
    );
  };
}

function reply(key: string, status: TerminalLogin["status"], reason?: TerminalLogin["reason"]) {
  responses[key] = () => ({ payload: terminal(status, reason) });
}

beforeEach(() => {
  calls = [];
  responses = {};
  postGate = null;
  onClose.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST" && postGate) await postGate;
      const handler = responses[`${method} ${url}`];
      const { status = 200, payload } = handler
        ? handler()
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

describe("AuthTerminalDialog", () => {
  it("starts the account terminal and waits without any success text", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    render();

    expect((await screen.findByTestId("direct-terminal")).textContent).toBe(ID);
    expect(screen.getByTestId("direct-terminal").getAttribute("data-input")).toBe("false");
    expect(calls.find((call) => call.method === "POST")).toEqual({
      url: "/api/auth-terminal-logins",
      method: "POST",
      body: { accountId: "claude-work" },
    });
    expect(screen.getByTestId("auth-terminal-status").textContent).toContain(
      "Waiting for sign-in…",
    );
    expect(screen.queryByText(/Signed in/)).toBeNull();
    // Kicker, identity line and hint; no command bar from the daemon yet and no old "/login" text.
    const dialog = screen.getByRole("dialog", { name: "alek@x.com · Intelas" });
    expect(dialog.textContent).toContain("Sign in · Claude · terminal");
    expect(screen.getByText(/Finish sign-in in the terminal/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("claude /login");
    // No terminal icon inside the terminal dialog.
    expect(screen.queryByRole("button", { name: "Continue in terminal" })).toBeNull();
  });

  // jsdom does not reproduce the browser stranding (the old mutation start passes this too);
  // this guards the replayed mount effect against a second POST and a missing status poll.
  it("posts once, reaches the waiting state and polls the status under StrictMode", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    reply(`GET /api/auth-terminal-logins/${ID}`, "running");
    render({ accountId: "claude-work" }, true);

    expect(await screen.findByTestId("direct-terminal")).toBeTruthy();
    expect(screen.getByTestId("auth-terminal-status").textContent).toContain(
      "Waiting for sign-in…",
    );
    await waitFor(
      () =>
        expect(calls.some((call) => call.method === "GET" && call.url.endsWith(`/${ID}`))).toBe(
          true,
        ),
      { timeout: 5_000 },
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  }, 10_000);

  it("stops a terminal whose start resolves after the dialog was closed", async () => {
    let release: () => void = () => undefined;
    postGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reply("POST /api/auth-terminal-logins", "running");
    responses[`DELETE /api/auth-terminal-logins/${ID}`] = () => ({ payload: { stopped: ID } });
    render();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    release();

    await waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith(ID))).toBe(true),
    );
  });

  it("stops the terminal a restart creates when Close lands while it is in flight", async () => {
    reply("POST /api/auth-terminal-logins", "not_signed_in", "exited");
    responses[`DELETE /api/auth-terminal-logins/${ID}`] = () => ({ payload: { stopped: ID } });
    render();
    const restart = await screen.findByRole("button", { name: "Restart terminal" });
    let release: () => void = () => undefined;
    postGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reply("POST /api/auth-terminal-logins", "running");
    fireEvent.click(restart);

    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const deletesBefore = calls.filter((call) => call.method === "DELETE").length;
    release();

    await waitFor(() =>
      expect(calls.filter((call) => call.method === "DELETE").length).toBe(deletesBefore + 1),
    );
  });

  it("hides the embedded terminal's own header", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    render();

    expect((await screen.findByTestId("direct-terminal")).getAttribute("data-hide-header")).toBe(
      "true",
    );
  });

  it("starts a host terminal for the provider", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    render({ host: "codex" });

    await screen.findByTestId("direct-terminal");
    expect(calls[0]?.body).toEqual({ host: "codex" });
  });

  it("shows verified only once the poll reports ready, then drops the terminal", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    reply(`GET /api/auth-terminal-logins/${ID}`, "ready");
    render();
    await screen.findByTestId("direct-terminal");

    expect(
      await screen.findByText("Signed in as alek@x.com · Intelas", {}, { timeout: 6_000 }),
    ).toBeTruthy();
    expect(screen.queryByTestId("direct-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
  }, 10_000);

  it("shows the primary line alone when the account has no secondary, and the host name for host", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    const { unmount } = render({ accountId: "claude-work" }, false, {
      ...ACCOUNT,
      identity: { email: "solo@x.com" },
    });
    expect(await screen.findByRole("dialog", { name: "solo@x.com" })).toBeTruthy();
    unmount();

    render({ host: "claude" });
    expect(await screen.findByRole("dialog", { name: "Claude host" })).toBeTruthy();
  });

  it("shows verifying without the terminal once the daemon tests the credential", async () => {
    reply("POST /api/auth-terminal-logins", "verifying");
    render();

    expect(await screen.findByText("Verifying sign-in…")).toBeTruthy();
    expect(screen.queryByTestId("direct-terminal")).toBeNull();
    expect(screen.queryByText(/Signed in ·/)).toBeNull();
  });

  it("shows neutral Not signed in with Restart terminal after an exit", async () => {
    reply("POST /api/auth-terminal-logins", "not_signed_in", "exited");
    render();

    expect(await screen.findByText("Not signed in")).toBeTruthy();
    expect(screen.getByText(/Terminal exited/)).toBeTruthy();
    expect(screen.queryByText(/Signed in/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByTestId("direct-terminal")).toBeNull();
  });

  it("restarts by posting the same target again", async () => {
    reply("POST /api/auth-terminal-logins", "not_signed_in", "exited");
    render();
    const restart = await screen.findByRole("button", { name: "Restart terminal" });
    reply("POST /api/auth-terminal-logins", "running");
    fireEvent.click(restart);

    expect(await screen.findByTestId("direct-terminal")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { accountId: "claude-work" },
      { accountId: "claude-work" },
    ]);
    expect(screen.queryByText("Not signed in")).toBeNull();
  });

  it("treats a pending sign-in elsewhere as a running note, not an end state", async () => {
    reply("POST /api/auth-terminal-logins", "running", "another_sign_in_pending");
    render();

    expect(await screen.findByText(/Another sign-in is pending/)).toBeTruthy();
    expect(screen.getByTestId("direct-terminal")).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
  });

  it("shows Not signed in when the daemon forgot the terminal (404)", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    responses[`GET /api/auth-terminal-logins/${ID}`] = () => ({
      status: 404,
      payload: { error: "Unknown terminal login" },
    });
    render();
    await screen.findByTestId("direct-terminal");

    expect(await screen.findByText("Not signed in", {}, { timeout: 6_000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
  }, 10_000);

  it("stops the terminal on Close, then closes", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    responses[`DELETE /api/auth-terminal-logins/${ID}`] = () => ({ payload: { stopped: ID } });
    render();
    await screen.findByTestId("direct-terminal");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith(ID))).toBe(true);
  });

  it("closes even when the stop request fails", async () => {
    reply("POST /api/auth-terminal-logins", "running");
    responses[`DELETE /api/auth-terminal-logins/${ID}`] = () => ({
      status: 404,
      payload: { error: "Unknown terminal login" },
    });
    render();
    await screen.findByTestId("direct-terminal");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("shows a start failure and lets the user restart", async () => {
    responses["POST /api/auth-terminal-logins"] = () => ({
      status: 502,
      payload: { error: "tmux unavailable" },
    });
    render();

    expect((await screen.findByRole("status")).textContent).toBe("tmux unavailable");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
  });
});
