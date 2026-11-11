import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";

vi.mock("next/font/google", () => ({
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));
vi.mock("@/components/DirectTerminal", () => ({ DirectTerminal: () => <div /> }));
vi.mock("@/components/SessionLinkBadge", () => ({
  useSessionLinkPrInfo: () => ({ state: null }),
  SessionLinkBadge: () => null,
}));

describe("Dashboard shell while sessions are pending", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/sessions") return new Promise<Response>(() => {});
      if (url === "/api/tags") return Promise.resolve(new Response('{"tags":[]}'));
      if (url.startsWith("/api/runtime/")) {
        return Promise.resolve(new Response('{"available":false}'));
      }
      return Promise.resolve(new Response("{}"));
    });
  });

  it("renders header controls and the status bar; only the lanes area shows the loader", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Dashboard />
      </QueryClientProvider>,
    );

    const search = screen.getByRole("textbox", { name: "Filter sessions" });
    expect(search).toBeEnabled();
    expect(screen.getByRole("button", { name: "Filters" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Spawn Session" })).toBeEnabled();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();

    const main = screen.getByRole("main");
    expect(within(main).getByRole("status", { name: "Loading dashboard" })).toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "Loading dashboard" })).toHaveLength(1);
    expect(within(main).queryAllByRole("region")).toHaveLength(0);
  });
});
