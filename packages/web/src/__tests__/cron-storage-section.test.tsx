import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronStorageSection } from "@/components/CronStorageSection";
import type { CronStorageView, SpurSessionArtifact } from "@/lib/types";

const STORAGE_URL = "/api/cron/storage/api/audit";

function artifact(id: string, size: number, mimeType = "text/markdown"): SpurSessionArtifact {
  return {
    id,
    name: id.split("/").pop() ?? id,
    size,
    mimeType,
    kind: "text",
    origin: "intentional",
    createdAt: "2026-11-27T08:00:00.000Z",
    updatedAt: "2026-11-27T08:00:00.000Z",
  };
}

const FILLED: CronStorageView = {
  note: "Last run: 14 issues",
  noteUpdatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  files: [artifact("triage.md", 4198), artifact("runs/seen.json", 12902, "application/json")],
  totalBytes: 17100,
  updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  truncated: false,
};

const EMPTY: CronStorageView = {
  note: "",
  noteUpdatedAt: null,
  files: [],
  totalBytes: 0,
  updatedAt: null,
  truncated: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (init: RequestInit | undefined, url: string) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(init, String(input))),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection() {
  render(<CronStorageSection projectId="api" triggerId="audit" />);
}

function noteToggle(name: "Note" | "Add note") {
  return screen.getByRole("button", { name });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CronStorageSection", () => {
  it("S1 renders collapsed by default with file count and size", async () => {
    const fetchMock = stubFetch(() => jsonResponse(FILLED));
    renderSection();
    expect(await screen.findByText("2 files · 16.7 KB")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(STORAGE_URL, expect.anything());
    expect(noteToggle("Note")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("S2 toggles the note panel and keeps unsaved text across close and open", async () => {
    stubFetch(() => jsonResponse(FILLED));
    renderSection();
    const toggle = await screen.findByRole("button", { name: "Note" });
    expect(toggle.querySelector("svg, span")).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-controls");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const textbox = screen.getByRole("textbox", { name: "Storage note" });
    expect(toggle).toHaveAttribute("aria-controls", textbox.parentElement?.id);
    fireEvent.change(textbox, { target: { value: "draft" } });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("textbox", { name: "Storage note" })).toHaveValue("draft");
  });

  it("S3 shows the note update time when clean", async () => {
    stubFetch(() => jsonResponse(FILLED));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Note" }));
    expect(screen.getByRole("textbox", { name: "Storage note" })).toHaveValue(FILLED.note);
    expect(screen.getByText("Updated 3h ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("S4 marks a dirty note, saves it via PATCH and returns to clean", async () => {
    const saved = { ...FILLED, note: "next", noteUpdatedAt: new Date().toISOString() };
    const fetchMock = stubFetch((init) =>
      init?.method === "PATCH" ? jsonResponse(saved) : jsonResponse(FILLED),
    );
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Storage note" }), {
      target: { value: "next" },
    });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Updated just now")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(`${STORAGE_URL}/note`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "next" }),
    });
  });

  it("S5 renders empty storage with only the Add note toggle", async () => {
    stubFetch(() => jsonResponse(EMPTY));
    renderSection();
    expect(await screen.findByText("Empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear storage" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(noteToggle("Add note"));
    const textbox = screen.getByRole("textbox", { name: "Storage note" });
    expect(textbox).toHaveValue("");
    expect(textbox).toHaveAttribute("placeholder", "Context for later runs...");
    expect(screen.getByText("Later runs read this note")).toBeInTheDocument();
  });

  it("S6 shows trash but no file list for a note without files", async () => {
    stubFetch(() => jsonResponse({ ...FILLED, files: [], totalBytes: 0 }));
    renderSection();
    expect(await screen.findByText("0 files · 0 B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear storage" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("S7 confirms inline; Cancel restores and Delete clears to empty", async () => {
    const fetchMock = stubFetch((init) =>
      init?.method === "DELETE" ? jsonResponse(EMPTY) : jsonResponse(FILLED),
    );
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Clear storage" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Delete note and 2 files?");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(noteToggle("Note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear storage" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Clear storage" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Empty")).toBeInTheDocument();
    expect(noteToggle("Add note")).toBeInTheDocument();
    expect(noteToggle("Add note")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear storage" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(STORAGE_URL, { method: "DELETE" });
  });

  it("S8 disables actions in flight and shows load and save errors", async () => {
    let finish: ((response: Response) => void) | undefined;
    stubFetch((init) =>
      init?.method === "PATCH"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : jsonResponse(FILLED),
    );
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Storage note" }), {
      target: { value: "next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Clear storage" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Storage note" })).toHaveAttribute("readonly");
    finish?.(jsonResponse({ error: "Cron storage path is not a real directory" }, 409));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a real directory");
    expect(screen.getByRole("textbox", { name: "Storage note" })).toHaveValue("next");
    expect(screen.getByRole("textbox", { name: "Storage note" })).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("S8 shows a load error line for a failed or malformed response", async () => {
    stubFetch(() => jsonResponse({ projects: [], eventsSince: null }));
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load storage.");
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("S10 previews a file in a new tab and links open/download to the storage file URL", async () => {
    stubFetch(() => jsonResponse(FILLED));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderSection();
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Preview seen.json" }));
    expect(open).toHaveBeenCalledWith(`${STORAGE_URL}/files/runs/seen.json`, "_blank", "noopener");
    expect(within(table).getByRole("link", { name: "Download triage.md" })).toHaveAttribute(
      "href",
      `${STORAGE_URL}/files/triage.md`,
    );
  });
});
