import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import type { SpurSessionView } from "@/lib/types";

vi.mock("next/font/google", () => ({ JetBrains_Mono: () => ({ variable: "--font-mono" }) }));
vi.mock("@/components/DirectTerminal", () => ({ DirectTerminal: () => <div /> }));
vi.mock("@/components/SessionLinkBadge", () => ({
  useSessionLinkPrInfo: () => ({ state: "none" }),
  SessionLinkBadge: () => null,
}));

const running: SpurSessionView = {
  id: "row-one",
  project: "api",
  agent: "claude",
  prompt: "row actions",
  branch: "feature/test",
  worktree: true,
  tmuxSession: "row-one",
  status: "running",
  state: "waiting",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  lastActivityAt: "2026-01-01",
  runtimeAlive: true,
  workspaceExists: true,
  worktreePath: "/tmp/row-one",
  services: [],
  slots: { title: "Row session", links: [] },
  lifecycle: { instanceId: "epoch-one", revision: 0, operation: null },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const list = (rows: SpurSessionView[]) =>
  json({
    sessions: rows,
    lifecycleInstanceId: "epoch-one",
    projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
    backlog: [],
    daemonAlive: true,
  });

function mount(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.spyOn(global, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url === "/api/tags") return Promise.resolve(json({ tags: [] }));
    if (url.startsWith("/api/runtime/")) return Promise.resolve(json({ available: false }));
    return fetcher(url, init);
  });
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
const trigger = () => screen.findByRole("button", { name: `Actions for ${running.id}` });
async function choose(label: string) {
  fireEvent.click(await trigger());
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}
async function poll(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["sessions"] });
  });
}

describe("Dashboard row actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("holds an accepted pause through stale reads until a read confirms it", async () => {
    let rows = [running];
    let paused = false;
    const client = mount(async (url) => {
      if (url === "/api/sessions") return list(rows);
      if (url.endsWith("/pause")) {
        paused = true;
        return json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Pause");
    await waitFor(() => expect(paused).toBe(true));
    await poll(client);
    expect(await trigger()).toBeDisabled();
    rows = [{ ...running, status: "stopped", state: "stopped", runtimeAlive: false }];
    await poll(client);
    await waitFor(async () => expect(await trigger()).not.toBeDisabled());
    fireEvent.click(await trigger());
    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeInTheDocument();
  });

  it("rolls a failed pause back to the server row and toasts", async () => {
    mount(async (url) => {
      if (url === "/api/sessions") return list([running]);
      if (url.endsWith("/pause")) return json({ error: "pause exploded" }, 500);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Pause");
    expect(await screen.findByText("pause exploded")).toBeInTheDocument();
    await waitFor(async () => expect(await trigger()).not.toBeDisabled());
    fireEvent.click(await trigger());
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeInTheDocument();
  });

  it("routes a kill open-PR response through the dialog and retries with the choice", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let rows = [running];
    const kills: Record<string, unknown>[] = [];
    mount(async (url, init) => {
      if (url === "/api/sessions") return list(rows);
      if (url.endsWith("/kill")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        kills.push(body);
        if (!body.prAction)
          return json(
            {
              code: "open_pr_action_required",
              sessionId: running.id,
              pr: { number: 1, title: "PR", url: "https://github.com/test/repo/pull/1" },
            },
            409,
          );
        rows = [{ ...running, status: "killed", state: "killed", runtimeAlive: false }];
        return json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Kill");
    expect(window.confirm).toHaveBeenCalledWith(
      `Kill session ${running.id}? This forces cleanup even with local changes.`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Leave Pull Request Open" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open Pull Request" })).not.toBeInTheDocument(),
    );
    expect(kills).toEqual([{ force: true }, { prAction: "leave_open", force: true }]);
  });

  function editorFetch(url: string) {
    if (url.startsWith("/api/models")) return json({ models: [{ id: "auto", label: "Auto" }] });
    if (url.startsWith("/api/projects/api/spawn-defaults"))
      return json({ model: "auto", worktree: false });
    if (url.includes("/slash-commands")) return json({ commands: [] });
    return null;
  }

  it.each([
    ["Handoff", running, "Handoff"],
    ["Desk agent", running, "Desk agent"],
    [
      "Edit & Respawn",
      { ...running, status: "errored", state: "error", runtimeAlive: false },
      "Edit & Respawn",
    ],
  ] as const)("opens the detail-page %s editor from the row menu", async (label, row, title) => {
    mount(async (url) => {
      if (url === "/api/sessions") return list([row as SpurSessionView]);
      if (url === `/api/sessions/${running.id}`) return json(row);
      const editor = editorFetch(url);
      if (editor) return editor;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose(label);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(title);
  });

  // The list endpoint omits artifacts; this row matches it.
  const errored: SpurSessionView = {
    ...running,
    status: "errored",
    state: "error",
    runtimeAlive: false,
  };

  it("shows startup images from the full session in Edit & Respawn", async () => {
    mount(async (url) => {
      if (url === "/api/sessions") return list([errored]);
      if (url === `/api/sessions/${running.id}`)
        return json({
          ...errored,
          startupAttachmentIds: ["shot.png"],
          artifacts: [
            {
              id: "shot.png",
              name: "shot.png",
              size: 1,
              mimeType: "image/png",
              kind: "image",
              origin: "intentional",
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
            },
          ],
        });
      const editor = editorFetch(url);
      if (editor) return editor;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Edit & Respawn");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Keep existing images")).toBeInTheDocument();
    expect(within(dialog).getByAltText("shot.png")).toBeInTheDocument();
  });

  it("toasts when the full session read fails and opens nothing", async () => {
    mount(async (url) => {
      if (url === "/api/sessions") return list([errored]);
      if (url === `/api/sessions/${running.id}`) return json({ error: "read exploded" }, 502);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Edit & Respawn");
    expect(await screen.findByText("read exploded")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("drops a slow full read once another dialog opened", async () => {
    const other: SpurSessionView = { ...running, id: "row-two", tmuxSession: "row-two" };
    let release!: (response: Response) => void;
    mount(async (url) => {
      if (url === "/api/sessions") return list([errored, other]);
      if (url === `/api/sessions/${running.id}`)
        return new Promise<Response>((resolve) => (release = resolve));
      const editor = editorFetch(url);
      if (editor) return editor;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Edit & Respawn");
    fireEvent.click(await screen.findByRole("button", { name: "Actions for row-two" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Handoff");
    await act(async () => {
      release(json(errored));
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Edit & Respawn");
  });

  it("puts an icon before every row menu item", async () => {
    mount(async (url) => {
      if (url === "/api/sessions") return list([running]);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    fireEvent.click(await trigger());
    for (const item of screen.getAllByRole("menuitem"))
      expect(item.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("opens Recover from the row menu for a session without a workspace", async () => {
    mount(async (url) => {
      if (url === "/api/sessions") return list([{ ...running, workspaceExists: false }]);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Recover");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /force kill/i })).toBeInTheDocument();
  });

  it("opens Recover for a not-restorable restore and force-kills from it", async () => {
    let rows: SpurSessionView[] = [
      { ...running, status: "stopped", state: "stopped", runtimeAlive: false },
    ];
    const calls: string[] = [];
    mount(async (url) => {
      if (url === "/api/sessions") return list(rows);
      if (url.endsWith("/restore")) {
        calls.push("restore");
        return json(
          {
            code: "session_not_restorable",
            sessionId: running.id,
            reason: "Workspace is gone",
            availableActions: ["force_kill", "respawn"],
          },
          409,
        );
      }
      if (url.endsWith("/kill")) {
        calls.push("kill");
        rows = [{ ...running, status: "killed", state: "killed", runtimeAlive: false }];
        return json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await choose("Restore");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Workspace is gone");
    fireEvent.click(within(dialog).getByRole("button", { name: /force kill/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toEqual(["restore", "kill"]);
  });
});
