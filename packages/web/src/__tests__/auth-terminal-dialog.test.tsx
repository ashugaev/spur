import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTerminalDialog } from "@/components/AuthTerminalDialog";
import type { TerminalLogin } from "@/lib/types";

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({
    sessionId,
    agentInputEnabled,
  }: {
    sessionId: string;
    agentInputEnabled?: boolean;
  }) => (
    <div data-input={String(agentInputEnabled)} data-testid="direct-terminal">
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

function render(
  target: { accountId: string } | { host: "claude" | "codex" } = { accountId: "claude-work" },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(
    <AuthTerminalDialog label="work" provider="claude" target={target} onClose={onClose} />,
    { wrapper: Wrapper },
  );
}

function reply(key: string, status: TerminalLogin["status"], reason?: TerminalLogin["reason"]) {
  responses[key] = () => ({ payload: terminal(status, reason) });
}

beforeEach(() => {
  calls = [];
  responses = {};
  onClose.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
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
    expect(calls[0]).toEqual({
      url: "/api/auth-terminal-logins",
      method: "POST",
      body: { accountId: "claude-work" },
    });
    expect(screen.getByTestId("auth-terminal-status").textContent).toContain(
      "Waiting for terminal sign-in…",
    );
    expect(screen.queryByText(/Signed in/)).toBeNull();
    expect(screen.getByRole("dialog", { name: /Sign in claude · work · Terminal/ })).toBeTruthy();
    // No terminal icon inside the terminal dialog.
    expect(screen.queryByRole("button", { name: "Continue in terminal" })).toBeNull();
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
      await screen.findByText(/Signed in · verified by test request/, {}, { timeout: 6_000 }),
    ).toBeTruthy();
    expect(screen.queryByTestId("direct-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
  }, 10_000);

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
    fireEvent.click(await screen.findByRole("button", { name: "Restart terminal" }));
    reply("POST /api/auth-terminal-logins", "running");

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
