import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import { fileAttachmentsFromFiles, type FileAttachment } from "@/lib/file-attachments";
import type * as FileAttachmentsModule from "@/lib/file-attachments";

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

describe("Dashboard spawn photo preparation", () => {
  let requests: RequestInit[];
  let spawnFails: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    requests = [];
    spawnFails = false;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions")
        return Response.json({
          projects: [
            { id: "demo", name: "Demo", configured: true, prefix: "demo", path: "/repo/demo" },
          ],
          sessions: [],
        });
      if (url.startsWith("/api/models"))
        return Response.json({ models: [{ id: "sonnet", label: "Sonnet" }] });
      if (url.includes("spawn-defaults")) return Response.json({ model: null, worktree: false });
      if (url === "/api/spawn") {
        requests.push(init ?? {});
        return Response.json({ error: "Spawn failed" }, { status: spawnFails ? 502 : 201 });
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
