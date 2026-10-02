import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import type { SessionLifecycleSnapshot, SpurSessionView } from "@/lib/types";

vi.mock("next/font/google", () => ({ JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }) }));
vi.mock("@/components/DirectTerminal", () => ({ DirectTerminal: () => <div /> }));
vi.mock("@/components/SessionLinkBadge", () => ({
  useSessionLinkPrInfo: () => ({ state: null }), SessionLinkBadge: () => null,
}));

const source: SpurSessionView = {
  id: "handoff-one", project: "api", agent: "claude", prompt: "handoff", branch: "feature/test",
  worktree: true, tmuxSession: null, status: "stopped", state: "stopped", createdAt: "2026-08-01",
  updatedAt: "2026-08-01", lastActivityAt: "2026-08-01", runtimeAlive: false, workspaceExists: true,
  services: [], slots: { title: "Handoff session", links: [] },
  lifecycle: { instanceId: "epoch-one", revision: 0, operation: null },
};
function snapshot(operationId: string, phase: "pending" | "succeeded", revision: number): SessionLifecycleSnapshot {
  return { instanceId: "epoch-one", revision, operation: { operationId, action: "restore", phase,
    targetIds: [source.id], outcomes: phase === "pending" ? [] : [{ sessionId: source.id, phase }] } };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return { ...render(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>), client };
}
async function poll(client: QueryClient) {
  await act(async () => { await client.refetchQueries({ queryKey: ["sessions"] }); });
}

describe("Dashboard daemon handoff", () => {
  let rows: SpurSessionView[];
  let operationId: string;
  let release: (response: Response) => void;
  let reject: (error: Error) => void;
  let calls: number;
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    rows = [source]; operationId = ""; calls = 0;
    const post = new Promise<Response>((resolve, fail) => { release = resolve; reject = fail; });
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/sessions") return new Response(JSON.stringify({ sessions: rows,
        projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
        backlog: [], daemonAlive: true, lifecycleInstanceId: "epoch-one" }));
      if (url === `/api/sessions/${source.id}/restore`) {
        calls += 1;
        operationId = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
        return post;
      }
      if (url === "/api/tags") return new Response('{"tags":[]}');
      if (url.startsWith("/api/runtime/")) return new Response('{"available":false}');
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  it("shows server settlement before POST returns and recovers the same pending receipt after remount", async () => {
    const first = mount();
    fireEvent.click(await screen.findByRole("button", { name: `Restore session ${source.id}` }));
    await waitFor(() => expect(calls).toBe(1));
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    rows = [{ ...source, lifecycle: snapshot(operationId, "pending", 1) }];
    await poll(first.client);
    first.unmount(); first.client.clear();
    const second = mount();
    await screen.findByText("Working", { exact: true });
    expect(screen.queryByRole("button", { name: `Restore session ${source.id}` })).not.toBeInTheDocument();
    rows = [{ ...source, status: "running", state: "waiting", runtimeAlive: true,
      lifecycle: snapshot(operationId, "succeeded", 2) }];
    await poll(second.client);
    expect(screen.getByText("Waiting", { exact: true })).toBeInTheDocument();
    await act(async () => { release(new Response(JSON.stringify(rows[0]))); });
    expect(screen.getByText("Waiting", { exact: true })).toBeInTheDocument();
  });

  it.each(["lost", "delivery503"] as const)("reconciles %s POST through current GET without replay", async (failure) => {
    const { client } = mount();
    fireEvent.click(await screen.findByRole("button", { name: `Restore session ${source.id}` }));
    await waitFor(() => expect(calls).toBe(1));
    const settled = snapshot(operationId, "succeeded", 2);
    rows = [{ ...source, status: "running", state: "waiting", runtimeAlive: true, lifecycle: settled }];
    await act(async () => {
      if (failure === "lost") reject(new TypeError("Network response lost"));
      else release(new Response(JSON.stringify({ code: "session_lifecycle_snapshot_changed", error: "Delivery changed", lifecycle: settled }), { status: 503 }));
    });
    await screen.findByText("Waiting", { exact: true });
    await poll(client);
    expect(calls).toBe(1);
    expect(screen.queryByRole("button", { name: `Restore session ${source.id}` })).not.toBeInTheDocument();
  });
});
