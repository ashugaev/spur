import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import { fileAttachmentsFromFiles, type FileAttachment } from "@/lib/file-attachments";
import type * as FileAttachmentsModule from "@/lib/file-attachments";
import { SPAWN_DRAFT_STORAGE_KEY, writeSpawnDraft } from "@/lib/spawn-draft";
import type { SpurSessionView } from "@/lib/types";

vi.mock("@/lib/file-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof FileAttachmentsModule>()),
  fileAttachmentsFromFiles: vi.fn(),
}));
vi.mock("@/components/DirectTerminal", () => ({ DirectTerminal: () => null }));

const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
const photo = (name = "photo.png"): FileAttachment => ({
  file: new File([Uint8Array.from(atob(imageData), (character) => character.charCodeAt(0))], name, {
    type: "image/png",
  }),
  preview: `data:image/png;base64,${imageData}`,
});

function pendingRead() {
  let resolve!: (photos: FileAttachment[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FileAttachment[]>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  vi.mocked(fileAttachmentsFromFiles).mockReturnValueOnce(promise);
  return { resolve, reject };
}

const spawnedSession: SpurSessionView = {
  lifecycle: { instanceId: "test-instance", revision: 0, operation: null },
  id: "spawned",
  project: "demo",
  agent: "claude",
  prompt: "Clear photo",
  branch: "",
  worktree: false,
  tmuxSession: null,
  status: "spawning",
  state: "working",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  lastActivityAt: "2026-10-02T00:00:00.000Z",
  runtimeAlive: false,
  workspaceExists: false,
  worktreePath: "",
  slots: { links: [] },
};

describe("Dashboard spawn photo preparation", () => {
  let requests: RequestInit[];
  let spawnFails: boolean;
  let spawnResponse: Promise<Response> | undefined;
  let previewResponse: Promise<Response> | undefined;
  let spawnConflict: "spawn_in_progress" | "spawn_committed" | "spawn_failed" | undefined;
  let batchRequests: number;
  let sessionsGate: Promise<void> | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    requests = [];
    spawnFails = false;
    spawnResponse = undefined;
    previewResponse = undefined;
    spawnConflict = undefined;
    batchRequests = 0;
    sessionsGate = undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions") {
        await sessionsGate;
        return Response.json({
          lifecycleInstanceId: "test-instance",
          projects: [
            { id: "demo", name: "Demo", configured: true, prefix: "demo", path: "/repo/demo" },
          ],
          sessions: [],
        });
      }
      if (url.startsWith("/api/models"))
        return Response.json({ models: [{ id: "sonnet", label: "Sonnet" }] });
      if (url.includes("spawn-defaults")) return Response.json({ model: null, worktree: false });
      if (url === "/api/projects/demo/preflight-batches") {
        batchRequests += 1;
        return Response.json({ preflightBatchId: `batch-${batchRequests}` });
      }
      if (url === "/api/preflight") {
        if (previewResponse) return previewResponse;
        return Response.json({ branch: null });
      }
      if (url === "/api/spawn") {
        requests.push(init ?? {});
        if (spawnResponse) return spawnResponse;
        if (spawnConflict) {
          const conflict = spawnConflict;
          return Response.json(
            {
              error: `Session demo-7 conflict ${conflict}`,
              code: conflict,
              sessionId: "demo-7",
            },
            { status: 409 },
          );
        }
        return spawnFails
          ? Response.json({ error: "Spawn failed" }, { status: 502 })
          : Response.json(spawnedSession, { status: 201 });
      }
      return Response.json({ available: false, sessions: [], commands: [] });
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function open() {
    fireEvent.click((await screen.findAllByRole("button", { name: "Spawn Session" }))[0]);
    await waitFor(() => expect(submit()).not.toBeDisabled());
  }
  function submit() {
    return within(screen.getByRole("dialog")).getByRole("button", { name: "Spawn", exact: true });
  }
  function attach() {
    const input = screen.getByRole("dialog").querySelector('input[type="file"]');
    if (!input) throw new Error("Missing file picker");
    fireEvent.change(input, { target: { files: [photo().file] } });
  }
  async function mount() {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Dashboard />
      </QueryClientProvider>,
    );
    await open();
  }

  for (const failure of ["HTTP", "network"] as const) {
    it(`retains prompt and photo through in-flight spawn close attempts and late ${failure} failure`, async () => {
      await mount();
      fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Keep photo" } });
      const read = pendingRead();
      attach();
      await act(async () => read.resolve([photo()]));
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      spawnResponse = new Promise<Response>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      const button = submit();
      act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Close", exact: true })).toBeDisabled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
      fireEvent.click(dialog);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.getByLabelText("Prompt...")).toHaveValue("Keep photo");
      expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
      await waitFor(() => expect(requests).toHaveLength(1));
      await act(async () => {
        if (failure === "HTTP")
          resolve(Response.json({ error: "Late HTTP failure" }, { status: 502 }));
        else reject(new Error("Late network failure"));
      });
      expect(within(dialog).getByRole("alert")).toHaveTextContent(`Late ${failure} failure`);
      expect(submit()).not.toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Close", exact: true })).not.toBeDisabled();
      expect(screen.getByLabelText("Prompt...")).toHaveValue("Keep photo");
      expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
      spawnResponse = undefined;
      spawnFails = true;
      fireEvent.click(submit());
      await waitFor(() =>
        expect(within(dialog).getByRole("alert")).toHaveTextContent("Spawn failed"),
      );
      expect(JSON.parse(String(requests[1].body))).toMatchObject({
        prompt: "Keep photo",
        attachments: [{ name: "photo.png" }],
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }

  function sentBatchId(index: number): unknown {
    return (JSON.parse(String(requests[index]?.body)) as { preflightBatchId?: unknown })
      .preflightBatchId;
  }

  it("allocates a preflight batch before spawn when the preview has not run", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Fast submit" } });
    fireEvent.click(submit());
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(batchRequests).toBe(1);
    expect(sentBatchId(0)).toBe("batch-1");
  });

  it("keeps Close locked through a delayed preview and sends one spawn request", async () => {
    await mount();
    let resolvePreview!: (response: Response) => void;
    previewResponse = new Promise<Response>((accept) => {
      resolvePreview = accept;
    });
    fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Slow preview" } });
    const read = pendingRead();
    attach();
    await act(async () => read.resolve([photo()]));
    await waitFor(() => expect(batchRequests).toBe(1));
    fireEvent.click(submit());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
    fireEvent.click(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(requests).toHaveLength(0);
    await act(async () => resolvePreview(Response.json({ branch: null })));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0].body))).toMatchObject({
      preflightBatchId: "batch-1",
      attachments: [{ name: "photo.png" }],
    });
  });

  it("keeps prompt, photo and batch after spawn_in_progress", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Keep all" } });
    const read = pendingRead();
    attach();
    await act(async () => read.resolve([photo()]));
    spawnConflict = "spawn_in_progress";
    fireEvent.click(submit());
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("demo-7"),
    );
    expect(screen.getByLabelText("Prompt...")).toHaveValue("Keep all");
    expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
    spawnConflict = undefined;
    fireEvent.click(submit());
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(sentBatchId(1)).toBe(sentBatchId(0));
    expect(batchRequests).toBe(1);
  });

  it.each(["spawn_committed", "spawn_failed"] as const)(
    "keeps prompt and photo and rotates the batch after %s",
    async (code) => {
      await mount();
      fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Keep all" } });
      const read = pendingRead();
      attach();
      await act(async () => read.resolve([photo()]));
      spawnConflict = code;
      fireEvent.click(submit());
      await waitFor(() =>
        expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("demo-7"),
      );
      expect(screen.getByLabelText("Prompt...")).toHaveValue("Keep all");
      expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
      spawnConflict = undefined;
      fireEvent.click(submit());
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(sentBatchId(0)).toBe("batch-1");
      expect(sentBatchId(1)).toBe("batch-2");
      expect(JSON.parse(String(requests[1].body))).toMatchObject({
        prompt: "Keep all",
        attachments: [{ name: "photo.png" }],
      });
    },
  );

  it("persists the allocated batch to the draft before the spawn request settles", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Persist batch" } });
    let resolve!: (response: Response) => void;
    spawnResponse = new Promise<Response>((accept) => {
      resolve = accept;
    });
    fireEvent.click(submit());
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(window.localStorage.getItem(SPAWN_DRAFT_STORAGE_KEY)))).toMatchObject({
      preflightBatchId: "batch-1",
      preflightBatchProjectId: "demo",
    });
    await act(async () => resolve(Response.json(spawnedSession, { status: 201 })));
  });

  async function openBeforeProjectsLoad(batchProjectId: string) {
    writeSpawnDraft({
      prompt: "Retry after reload",
      agent: "claude",
      model: null,
      branch: "",
      branchIsExplicit: false,
      workspaceMode: "shared",
      workspaceModeConfirmedFor: null,
      defaultBranch: "",
      planMode: false,
      selfDestruct: false,
      selfDestructConditions: "",
      steps: [],
      trackerUrl: null,
      sessionMode: null,
      preflightBatchId: "saved-batch",
      preflightBatchProjectId: batchProjectId,
    });
    let releaseSessions!: () => void;
    sessionsGate = new Promise<void>((accept) => {
      releaseSessions = accept;
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Dashboard />
      </QueryClientProvider>,
    );
    fireEvent.click((await screen.findAllByRole("button", { name: "Spawn Session" }))[0]);
    expect(screen.getByLabelText("Prompt...")).toHaveValue("Retry after reload");
    await act(async () => releaseSessions());
    await waitFor(() => expect(submit()).not.toBeDisabled());
    fireEvent.click(submit());
    await waitFor(() => expect(requests).toHaveLength(1));
  }

  it("reuses the saved batch when the modal opens before projects load", async () => {
    await openBeforeProjectsLoad("demo");
    expect(sentBatchId(0)).toBe("saved-batch");
    expect(batchRequests).toBe(0);
  });

  it("rotates the saved batch when its project is gone once projects load", async () => {
    await openBeforeProjectsLoad("removed");
    expect(sentBatchId(0)).toBe("batch-1");
    expect(JSON.parse(String(requests[0].body))).toMatchObject({ projectId: "demo" });
  });

  it("closes and resets after an in-flight spawn succeeds", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Clear photo" } });
    const read = pendingRead();
    attach();
    await act(async () => read.resolve([photo()]));
    let resolve!: (response: Response) => void;
    spawnResponse = new Promise<Response>((accept) => {
      resolve = accept;
    });
    fireEvent.click(submit());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => resolve(Response.json(spawnedSession, { status: 201 })));
    expect(screen.queryByRole("dialog")).toBeNull();
    await open();
    expect(screen.getByLabelText("Prompt...")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove photo.png" })).toBeNull();
  });

  it("blocks spawn while a photo is pending and includes it after preparation", async () => {
    await mount();
    const read = pendingRead();
    attach();
    expect(submit()).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Prompt..."), { key: "Enter", ctrlKey: true });
    fireEvent.click(submit());
    expect(requests).toHaveLength(0);
    await act(async () => read.resolve([photo()]));
    expect(submit()).not.toBeDisabled();
    fireEvent.click(submit());
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0].body))).toMatchObject({
      attachments: [{ name: "photo.png", data: photo().preview.split(",")[1] }],
    });
  });

  it("keeps spawn blocked until every concurrent batch settles", async () => {
    await mount();
    const first = pendingRead();
    attach();
    const second = pendingRead();
    attach();
    await act(async () => first.resolve([photo("first.png")]));
    expect(submit()).toBeDisabled();
    await act(async () => second.resolve([photo("second.png")]));
    expect(submit()).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove first.png" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove second.png" })).toBeVisible();
  });

  it("blocks submit in the same event before React commits disabled state", async () => {
    await mount();
    const read = pendingRead();
    const button = submit();
    const input = screen.getByRole("dialog").querySelector('input[type="file"]');
    if (!input) throw new Error("Missing file picker");
    Object.defineProperty(input, "files", { configurable: true, value: [photo().file] });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(requests).toHaveLength(0);
    await act(async () => read.resolve([photo()]));
    expect(submit()).not.toBeDisabled();
  });

  it("ignores old completion and errors after closing and reopening", async () => {
    await mount();
    const oldRead = pendingRead();
    attach();
    const oldFailure = pendingRead();
    attach();
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    await open();
    const current = pendingRead();
    attach();
    await act(async () => {
      oldRead.resolve([photo("obsolete.png")]);
      oldFailure.reject(new Error("obsolete error"));
    });
    expect(submit()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove obsolete.png" })).toBeNull();
    expect(screen.queryByText("obsolete error")).toBeNull();
    await act(async () => current.resolve([photo()]));
    expect(submit()).not.toBeDisabled();
  });

  it("shows read and limit errors while retaining ready photos and enabling retry", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt..."), { target: { value: "Retain me" } });
    const first = pendingRead();
    attach();
    await act(async () => first.resolve([photo()]));
    const broken = pendingRead();
    attach();
    await act(async () => broken.reject(new Error("Cannot read photo")));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "Cannot read photo",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss spawn error" }));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
    expect(submit()).not.toBeDisabled();
    const excess = pendingRead();
    attach();
    await act(async () =>
      excess.resolve(Array.from({ length: 20 }, (_, i) => photo(`extra-${i}.png`))),
    );
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      /Too many attachments/,
    );
    expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
    expect(screen.getByLabelText("Prompt...")).toHaveValue("Retain me");
    expect(submit()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    await open();
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  });

  it("retains photo after spawn failure and permits removal and same-file reselection", async () => {
    await mount();
    const first = pendingRead();
    attach();
    await act(async () => first.resolve([photo()]));
    spawnFails = true;
    fireEvent.click(submit());
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
        "Spawn failed",
      ),
    );
    expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
    const again = pendingRead();
    attach();
    await act(async () => again.resolve([photo()]));
    fireEvent.click(submit());
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(JSON.parse(String(requests[1].body))).toMatchObject({
      attachments: [{ name: "photo.png" }],
    });
  });
});
