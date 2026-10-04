import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import type { SpurSessionsResponse, SpurSessionView } from "@/lib/types";

vi.mock("next/font/google", () => ({ JetBrains_Mono: () => ({ variable: "--font-mono" }) }));
vi.mock("@/components/DirectTerminal", () => ({ DirectTerminal: () => <div /> }));
vi.mock("@/components/SessionLinkBadge", () => ({
  useSessionLinkPrInfo: () => ({ state: "merged", ciStatus: "success" }),
  SessionLinkBadge: () => null,
}));

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const source: SpurSessionView = {
  id: "callback-one",
  project: "api",
  agent: "claude",
  prompt: "callback",
  branch: "feature/test",
  worktree: true,
  tmuxSession: "callback-one",
  status: "running",
  state: "waiting",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  lastActivityAt: "2026-01-01",
  runtimeAlive: true,
  workspaceExists: true,
  services: [],
  slots: {
    title: "Callback session",
    links: [{ label: "pr", url: "https://github.com/test/repo/pull/1" }],
  },
  lifecycle: { instanceId: "epoch-one", revision: 0, operation: null },
};
function completed(revision = 2): SpurSessionView {
  return {
    ...source,
    status: "completed",
    state: "stopped",
    runtimeAlive: false,
    lifecycle: {
      instanceId: "epoch-one",
      revision,
      operation: {
        operationId: "complete-one",
        action: "complete",
        phase: "succeeded",
        targetIds: [source.id],
        outcomes: [{ sessionId: source.id, phase: "succeeded" }],
      },
    },
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const list = (rows: SpurSessionView[], epoch = "epoch-one") =>
  json({
    sessions: rows,
    lifecycleInstanceId: epoch,
    projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
    backlog: [],
    daemonAlive: true,
  });
function mount(fetcher: typeof fetch) {
  vi.spyOn(global, "fetch").mockImplementation(fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Dashboard />
    </QueryClientProvider>,
  );
  return client;
}
async function poll(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["sessions"] });
  });
}
function shell(url: string) {
  if (url === "/api/tags") return json({ tags: [] });
  if (url.startsWith("/api/runtime/")) return json({ available: false });
  throw new Error(`Unexpected fetch: ${url}`);
}

describe("Dashboard lifecycle callback ownership", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it.each(["newer receipt", "new epoch", "equal revision current state"])(
    "rejects delayed opened data after %s and preserves the accepted row",
    async (change) => {
      window.history.replaceState(null, "", `/?terminal=${source.id}`);
      const opened = deferred();
      let rows = [source];
      let epoch = "epoch-one";
      let entered = false;
      let dispatched = "";
      const client = mount(async (input, init) => {
        const url = String(input);
        if (url === "/api/sessions") return list(rows, epoch);
        if (url.endsWith("/opened")) {
          entered = true;
          return opened.promise;
        }
        if (url.endsWith("/complete")) {
          dispatched = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
          return json(
            {
              code: "open_pr_action_required",
              sessionId: source.id,
              pr: { number: 1, title: "PR", url: "https://github.com/test/repo/pull/1" },
            },
            409,
          );
        }
        return shell(url);
      });
      await waitFor(() => expect(entered).toBe(true));
      const current =
        change === "new epoch"
          ? { ...completed(), lifecycle: { instanceId: "epoch-two", revision: 0, operation: null } }
          : change === "equal revision current state"
            ? {
                ...source,
                status: "completed" as const,
                state: "stopped" as const,
                runtimeAlive: false,
              }
            : completed();
      epoch = current.lifecycle.instanceId;
      rows = [current];
      await poll(client);
      await act(async () => {
        opened.resolve(json({ ...source, lastOpenedAt: "2026-01-02" }));
      });
      expect(client.getQueryData<SpurSessionsResponse>(["sessions"])?.sessions[0]).toEqual(current);
      expect(
        screen.queryByRole("button", { name: `Mark ${source.id} as done` }),
      ).not.toBeInTheDocument();
      if (change === "newer receipt") {
        rows = [{ ...current, status: "running", state: "waiting", runtimeAlive: true }];
        await poll(client);
        fireEvent.click(await screen.findByRole("button", { name: `Mark ${source.id} as done` }));
        await screen.findByRole("dialog", { name: "Open Pull Request" });
        expect(dispatched).toMatch(/^[0-9a-f-]{36}$/);
      }
    },
  );

  it("accepts current opened metadata without changing the lifecycle floor", async () => {
    window.history.replaceState(null, "", `/?terminal=${source.id}`);
    const opened = { ...source, lastOpenedAt: "2026-01-02" };
    const client = mount(async (input) => {
      const url = String(input);
      if (url === "/api/sessions") return list([source]);
      if (url.endsWith("/opened")) return json(opened);
      return shell(url);
    });
    await waitFor(() =>
      expect(client.getQueryData<SpurSessionsResponse>(["sessions"])?.sessions[0]).toEqual(opened),
    );
  });

  it("does not replace a current completed row with a delayed spawn response", async () => {
    const spawn = deferred();
    let rows: SpurSessionView[] = [];
    let entered = false;
    const client = mount(async (input) => {
      const url = String(input);
      if (url === "/api/sessions") return list(rows);
      if (url.startsWith("/api/models")) return json({ models: [{ id: "auto", label: "Auto" }] });
      if (url.startsWith("/api/projects/api/spawn-defaults"))
        return json({ model: "auto", worktree: false });
      if (url === "/api/projects/api/preflight-batches")
        return json({ preflightBatchId: "batch-one" });
      if (url === "/api/preflight") return json({ branch: null });
      if (url === "/api/spawn") {
        entered = true;
        return spawn.promise;
      }
      return shell(url);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Spawn Session" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Spawn callback" },
    });
    const submit = dialog.querySelector('button[class*="min-w-32"]');
    if (!(submit instanceof HTMLButtonElement)) throw new Error("Spawn submit missing");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(entered).toBe(true));
    rows = [completed()];
    await poll(client);
    await act(async () => {
      spawn.resolve(json(source, 201));
    });
    expect(client.getQueryData<SpurSessionsResponse>(["sessions"])?.sessions[0]).toEqual(rows[0]);
    expect(
      screen.queryByRole("button", { name: `Mark ${source.id} as done` }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["open_pr_action_required", "new owner"],
    ["github_pr_check_unavailable", "new owner"],
    ["open_pr_action_required", "new epoch"],
    ["github_pr_check_unavailable", "new epoch"],
  ])("suppresses obsolete %s dialog after reconciliation accepts %s", async (code, change) => {
    const read = deferred();
    let holdNext = false;
    let entered = false;
    const client = mount(async (input) => {
      const url = String(input);
      if (url === "/api/sessions") {
        if (holdNext) {
          holdNext = false;
          entered = true;
          return read.promise;
        }
        return list([source]);
      }
      if (url.endsWith("/complete")) {
        holdNext = true;
        return json(
          code === "open_pr_action_required"
            ? {
                code,
                sessionId: source.id,
                pr: { number: 1, title: "PR", url: "https://github.com/test/repo/pull/1" },
              }
            : { code, sessionId: source.id, rateLimited: true, pr: null },
          409,
        );
      }
      return shell(url);
    });
    fireEvent.click(await screen.findByRole("button", { name: `Mark ${source.id} as done` }));
    await waitFor(() => expect(entered).toBe(true));
    const next = {
      ...completed(3),
      status: "running" as const,
      lifecycle: {
        ...completed(3).lifecycle,
        operation: {
          ...completed(3).lifecycle.operation!,
          operationId: "new-owner",
          phase: "pending" as const,
          outcomes: [],
        },
      },
    };
    if (change === "new epoch") next.lifecycle.instanceId = "epoch-two";
    await act(async () => {
      read.resolve(list([next], next.lifecycle.instanceId));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.getQueryData<SpurSessionsResponse>(["sessions"])?.sessions[0]).toEqual(next);
  });
});
