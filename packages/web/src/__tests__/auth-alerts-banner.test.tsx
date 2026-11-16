import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAlertsBanner } from "@/components/AuthAlertsBanner";
import { AUTH_ALERTS_QUERY_KEY } from "@/lib/auth-accounts";
import type { AuthAlert } from "@/lib/types";

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
}));

const MANAGED: AuthAlert = {
  id: "managed:claude-work",
  kind: "managed",
  provider: "claude",
  accountId: "claude-work",
  label: "alek@x.com",
  since: "2026-01-01T00:00:00.000Z",
  sessionsWaiting: 2,
};
const HOST: AuthAlert = {
  id: "host:codex",
  kind: "host",
  provider: "codex",
  label: "Codex host",
  since: "2026-01-01T00:00:00.000Z",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let alertsReply: () => { status: number; payload: unknown };
let client: QueryClient;

function render() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(<AuthAlertsBanner />, { wrapper: Wrapper });
}

beforeEach(() => {
  calls = [];
  alertsReply = () => ({ status: 200, payload: { alerts: [MANAGED, HOST] } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let reply: { status: number; payload: unknown } = {
        status: 404,
        payload: { error: "unmocked" },
      };
      if (method === "GET" && url === "/api/auth-alerts") reply = alertsReply();
      if (method === "POST" && url === "/api/auth-terminal-logins") {
        reply = {
          status: 200,
          payload: {
            id: "auth-login-x",
            target: { host: "codex" },
            tmuxSession: "auth-login-x",
            status: "running",
          },
        };
      }
      return new Response(JSON.stringify(reply.payload), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthAlertsBanner", () => {
  it("renders one row per alert with meta, Sign in and a terminal icon", async () => {
    render();

    const managed = within(await screen.findByTestId("auth-alert-managed:claude-work"));
    expect(managed.getByText(/claude · alek@x.com signed out/)).toBeTruthy();
    expect(managed.getByText(/managed account · 2 sessions waiting/)).toBeTruthy();
    expect(managed.getByRole("button", { name: "Sign in alek@x.com" })).toBeTruthy();
    // The row names the account by its display name, never an id.
    expect(managed.queryByText(/claude-work/)).toBeNull();
    expect(managed.getByRole("button", { name: "Continue in terminal" })).toBeTruthy();
    const host = within(screen.getByTestId("auth-alert-host:codex"));
    expect(host.getByText(/Codex host login expired or rejected/)).toBeTruthy();
    expect(host.getByText(/host credentials/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sign-in alerts" })).toBeTruthy();
  });

  it("renders nothing when there are no alerts", async () => {
    alertsReply = () => ({ status: 200, payload: { alerts: [] } });
    const { container } = render();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a malformed response", async () => {
    alertsReply = () => ({ status: 200, payload: {} });
    const { container } = render();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.innerHTML).toBe("");
  });

  it("opens the guided dialog for a managed account", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in alek@x.com" }));

    const dialog = within(
      await screen.findByRole("dialog", { name: "Sign in Claude · alek@x.com" }),
    );
    expect(dialog.getByRole("radiogroup", { name: "Sign-in method" })).toBeTruthy();
  });

  it("opens the account terminal from the managed row icon", async () => {
    render();
    const row = within(await screen.findByTestId("auth-alert-managed:claude-work"));

    fireEvent.click(row.getByRole("button", { name: "Continue in terminal" }));

    expect(await screen.findByTestId("direct-terminal")).toBeTruthy();
    expect(calls).toContainEqual({
      url: "/api/auth-terminal-logins",
      method: "POST",
      body: { accountId: "claude-work" },
    });
  });

  it("opens the host terminal directly from Sign in", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in Codex host" }));

    expect(await screen.findByTestId("direct-terminal")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(calls).toContainEqual({
      url: "/api/auth-terminal-logins",
      method: "POST",
      body: { host: "codex" },
    });
  });

  it("keeps rows through a failed refresh and drops them only when the server does", async () => {
    render();
    await screen.findByTestId("auth-alert-host:codex");

    alertsReply = () => ({ status: 502, payload: { error: "daemon down" } });
    await client.invalidateQueries({ queryKey: AUTH_ALERTS_QUERY_KEY });
    expect(screen.getByTestId("auth-alert-host:codex")).toBeTruthy();
    expect(screen.getByTestId("auth-alert-managed:claude-work")).toBeTruthy();

    alertsReply = () => ({ status: 200, payload: { alerts: [HOST] } });
    await client.invalidateQueries({ queryKey: AUTH_ALERTS_QUERY_KEY });
    await waitFor(() => expect(screen.queryByTestId("auth-alert-managed:claude-work")).toBeNull());
    expect(screen.getByTestId("auth-alert-host:codex")).toBeTruthy();
  });
});
