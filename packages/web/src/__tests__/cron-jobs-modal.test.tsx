import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronJobsModal } from "@/components/CronJobsModal";
import { formatAbsoluteTime, formatShortTimestamp } from "@/lib/format";
import type {
  CronJobEditDraft,
  CronJobEditUpdate,
  CronJobsResponse,
  ProjectInfo,
} from "@/lib/types";

const PROJECTS: ProjectInfo[] = [
  { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
  { id: "web", name: "Web", configured: true, prefix: "web", path: "/repo/web" },
];

const READY: CronJobsResponse = {
  eventsSince: "2026-10-20T00:00:00.000Z",
  projects: [
    {
      projectId: "api",
      projectName: "API",
      owner: { state: "loaded", path: "/repo/api/spur.yaml", revision: "abc", changed: true },
      sources: [
        {
          sourceId: "nightly",
          schedule: "0 3 * * *",
          runOnStart: false,
          disk: "changed",
          recentTicks: ["2026-10-27T03:00:00.000Z"],
          triggers: [
            {
              triggerId: "audit",
              event: "cron:tick",
              disk: "same",
              action: {
                kind: "spawn",
                blocks: [
                  {
                    prompt: "Audit errored sessions",
                    agent: "claude",
                    model: null,
                    reasoningEffort: "high",
                    mode: null,
                  },
                ],
              },
              recentActions: [
                {
                  at: "2026-10-27T03:00:02.000Z",
                  event: "trigger.spawn.completed",
                  sessionId: "api-412",
                  message: null,
                },
              ],
            },
          ],
        },
        {
          sourceId: "lonely",
          schedule: "0 8 1 * *",
          runOnStart: true,
          disk: "same",
          recentTicks: [],
          triggers: [],
        },
      ],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderModal(initialProjectId = "api", onClose = vi.fn()) {
  render(
    <CronJobsModal initialProjectId={initialProjectId} onClose={onClose} projects={PROJECTS} />,
  );
  return onClose;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CronJobsModal", () => {
  it("shows loading while the request is pending", () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    renderModal();
    expect(screen.getByRole("status", { name: "Loading cron jobs" })).toBeInTheDocument();
  });

  it("shows the error text on a failed request", async () => {
    stubFetch(() => jsonResponse({ error: "down" }, 502));
    renderModal();
    expect(await screen.findByText("Could not load cron jobs")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    stubFetch(() => jsonResponse({ projects: [], eventsSince: null }));
    renderModal();
    expect(await screen.findByText("No cron jobs")).toBeInTheDocument();
  });

  it("renders rows, drift line, source-only row and session link without edit controls", async () => {
    stubFetch(() => jsonResponse(READY));
    renderModal();
    expect(await screen.findByText("audit")).toBeInTheDocument();
    expect(screen.getByText(/spur\.yaml changed on disk, not loaded/)).toBeInTheDocument();
    expect(screen.getByText("No action configured")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "api-412" })).toHaveAttribute(
      "href",
      "/sessions/api-412?project=api",
    );
    expect(screen.getByTitle("changed on disk")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|save/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("input, textarea")).toBeNull();
  });

  it("expands a row into settings and recent runs blocks with readable values", async () => {
    stubFetch(() => jsonResponse(READY));
    renderModal();
    const row = (await screen.findByText("audit")).closest("[aria-expanded]");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const settings = screen.getByText("Settings").closest("section") as HTMLElement;
    const pairs = Array.from(settings.querySelectorAll("dt")).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(pairs).toEqual([
      ["Cron", "0 3 * * *"],
      ["Run on start", "no"],
      ["Action", "spawn"],
      ["Agent", "claude"],
      ["Model", "default"],
      ["Effort", "high"],
      ["Prompt", "Audit errored sessions"],
    ]);
    for (const value of settings.querySelectorAll("dd")) {
      expect(value.className).not.toContain("text-tertiary");
    }
    const runs = screen.getByText("Recent runs").closest("section") as HTMLElement;
    expect(within(runs).getByText("Cron tick")).toBeInTheDocument();
    const tickTime = formatShortTimestamp("2026-10-27T03:00:00.000Z");
    expect(tickTime).toMatch(/^Oct 2[67] \d{2}:\d{2}:00$/);
    expect(within(runs).getByText(tickTime)).toHaveAttribute(
      "title",
      formatAbsoluteTime("2026-10-27T03:00:00.000Z"),
    );
    expect(screen.getByText("Settings").className).toContain("text-[var(--color-text-secondary)]");
    expect(settings.className).toContain("border-t");
    expect(runs.className).toContain("border-t");
    expect(within(runs).getByText("Session")).toBeInTheDocument();
    expect(within(runs).getByRole("link", { name: "api-412" })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: "Edit YAML" })).toBeEnabled();
  });

  it("shows the window start for an empty history, or no tick recorded without one", async () => {
    stubFetch(() => jsonResponse(READY));
    renderModal();
    fireEvent.click((await screen.findByText("lonely")).closest("[aria-expanded]") as HTMLElement);
    const runs = screen.getByText("Recent runs").closest("section") as HTMLElement;
    expect(
      within(runs).getByText(`No tick since ${formatAbsoluteTime("2026-10-20T00:00:00.000Z")}`),
    ).toBeInTheDocument();
  });

  it("shows no tick recorded when eventsSince is null", async () => {
    stubFetch(() => jsonResponse({ ...READY, eventsSince: null }));
    renderModal();
    fireEvent.click((await screen.findByText("lonely")).closest("[aria-expanded]") as HTMLElement);
    const runs = screen.getByText("Recent runs").closest("section") as HTMLElement;
    expect(within(runs).getByText("No tick recorded")).toBeInTheDocument();
  });

  it("fetches with the initial project and refetches when the select changes", async () => {
    const fetchMock = stubFetch(() => jsonResponse(READY));
    renderModal("api");
    await screen.findByText("audit");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/cron?project=api",
      expect.objectContaining({ cache: "no-store" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Cron project" }), {
      target: { value: "" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/cron", expect.anything()));
    expect(await screen.findByText(/API · nightly/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests all projects when the dashboard filter is empty", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ projects: [], eventsSince: null }));
    renderModal("");
    await screen.findByText("No cron jobs");
    expect(fetchMock).toHaveBeenCalledWith("/api/cron", expect.anything());
  });

  it("toggles a row from a native, focusable button", async () => {
    stubFetch(() => jsonResponse(READY));
    renderModal();
    const toggle = (await screen.findByText("audit")).closest("button") as HTMLButtonElement;
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    expect(toggle).toHaveFocus();
    // Browsers dispatch click on Enter and Space for a native button.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the session link outside the toggle so Enter and click never toggle the row", async () => {
    stubFetch(() => jsonResponse(READY));
    renderModal();
    const toggle = (await screen.findByText("audit")).closest("button") as HTMLButtonElement;
    const link = screen.getByRole("link", { name: "api-412" });
    expect(toggle.contains(link)).toBe(false);
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    // jsdom cannot navigate: cancel only the default action, on the link itself
    // (the row's stopPropagation keeps the event from reaching window).
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape", async () => {
    stubFetch(() => jsonResponse({ projects: [], eventsSince: null }));
    const onClose = renderModal();
    await screen.findByText("No cron jobs");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const DRAFT: CronJobEditDraft = {
  projectId: "api",
  sourceId: "nightly",
  triggerId: "audit",
  ownerPath: "/repo/api/spur.yaml",
  revision: "a".repeat(64),
  schedule: "0 5 * * *",
  sourceTriggerIds: ["audit", "sibling"],
  blocks: [
    {
      prompt: "  Disk prompt  ",
      agent: "claude",
      model: "custom-unlisted",
      reasoningEffort: "high",
    },
    { prompt: "Second block", agent: null, model: null, reasoningEffort: null },
  ],
};

function stubEditor(patch?: (body: CronJobEditUpdate) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/cron/edit")) {
      if (init?.method === "PATCH") {
        const body = (await new Response(init.body).json()) as CronJobEditUpdate;
        return patch
          ? patch(body)
          : jsonResponse({ ...DRAFT, ...body, saved: true, activation: "pending" });
      }
      return jsonResponse(DRAFT);
    }
    return jsonResponse(READY);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openEditor() {
  fireEvent.click(await screen.findByText("audit"));
  fireEvent.click(screen.getByRole("button", { name: "Edit YAML" }));
  await screen.findByLabelText("Block 1 prompt");
}

describe("CronJob editor", () => {
  it("reads disk values during drift and saves every block with raw/default values intact", async () => {
    const patch = vi.fn((body: CronJobEditUpdate) =>
      jsonResponse({ ...DRAFT, ...body, saved: true, activation: "pending" }),
    );
    stubEditor(patch);
    renderModal();
    await openEditor();
    expect(screen.getByLabelText("Schedule")).toHaveValue("0 5 * * *");
    expect(screen.getByLabelText("Block 1 prompt")).toHaveValue("  Disk prompt  ");
    expect(screen.getByLabelText("Block 1 model")).toHaveValue("custom-unlisted");
    expect(screen.getByLabelText("Block 2 agent")).toHaveValue("");
    expect(screen.getByText(/schedule affects: audit, sibling/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save YAML" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "0 6 * * *" } });
    fireEvent.change(screen.getByLabelText("Block 2 prompt"), {
      target: { value: "Changed second block" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save YAML" }));
    expect(await screen.findByText("Saved to YAML. Pending activation.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save YAML" })).not.toHaveAttribute("aria-busy");
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
    expect(patch).toHaveBeenCalledWith({
      revision: DRAFT.revision,
      schedule: "0 6 * * *",
      blocks: [DRAFT.blocks[0], { ...DRAFT.blocks[1], prompt: "Changed second block" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to cron jobs" }));
    expect(await screen.findByText("Audit errored sessions")).toBeVisible();
    expect(screen.getByText("0 3 * * *", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit YAML" })).toHaveFocus();
  });

  it("retains a conflicted draft, blocks Save, and reloads only after explicit discard", async () => {
    const fetchMock = stubEditor(() =>
      jsonResponse(
        { error: "Config file changed. Reload before saving.", code: "config_changed" },
        409,
      ),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderModal();
    await openEditor();
    fireEvent.change(screen.getByLabelText("Block 1 prompt"), {
      target: { value: "Keep my draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save YAML" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Config file changed");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByLabelText("Block 1 prompt")).toHaveValue("Keep my draft");
    expect(screen.getByRole("button", { name: "Save YAML" })).toBeDisabled();
    const count = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Reload YAML" }));
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(screen.getByLabelText("Block 1 prompt")).toHaveValue("Keep my draft");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload YAML" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Block 1 prompt")).toHaveValue("  Disk prompt  "),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps field values after validation or network failure", async () => {
    const patch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "Invalid cron schedule.", field: "schedule" }, 422),
      )
      .mockRejectedValueOnce(new Error("network unavailable"));
    stubEditor(patch);
    renderModal();
    await openEditor();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "invalid cron" } });
    fireEvent.click(screen.getByRole("button", { name: "Save YAML" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid cron schedule.");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByLabelText("Schedule")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Schedule")).toHaveValue("invalid cron");
    fireEvent.click(screen.getByRole("button", { name: "Save YAML" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("network unavailable"));
    expect(screen.getByLabelText("Schedule")).toHaveValue("invalid cron");
  });

  it("guards Escape/backdrop/cancel with one dirty discard path", async () => {
    const fetchMock = stubEditor();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onClose = renderModal();
    await openEditor();
    fireEvent.change(screen.getByLabelText("Block 1 prompt"), { target: { value: "Unsaved" } });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Block 1 prompt")).toHaveValue("Unsaved");
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to cron jobs" }));
    expect(screen.queryByLabelText("Block 1 prompt")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("blocks repeat submissions and closing while a save is pending", async () => {
    let finish: ((response: Response) => void) | undefined;
    const patch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    stubEditor(patch);
    renderModal();
    await openEditor();
    fireEvent.change(screen.getByLabelText("Block 1 prompt"), {
      target: { value: "Saving prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save YAML" }));
    const savingButton = await screen.findByRole("button", { name: "Saving YAML" });
    expect(savingButton).toBeDisabled();
    expect(savingButton).toHaveAttribute("aria-busy", "true");
    expect(savingButton.querySelector("[data-busy-content]")).toBeInTheDocument();
    expect(within(savingButton).queryByText("Saving…")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("Block 1 prompt")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(patch).toHaveBeenCalledTimes(1);
    finish?.(
      jsonResponse({
        ...DRAFT,
        blocks: [{ ...DRAFT.blocks[0], prompt: "Saving prompt" }, DRAFT.blocks[1]],
        saved: true,
        activation: "pending",
      }),
    );
    expect(await screen.findByText("Saved to YAML. Pending activation.")).toBeVisible();
  });

  it("shows loading, actionable load errors and read-only source rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/cron/edit")
        ? jsonResponse({ error: "Only Cron spawn triggers can be edited." }, 422)
        : jsonResponse(READY),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderModal();
    fireEvent.click(await screen.findByText("lonely"));
    expect(screen.getByText("No spawn trigger to edit")).toBeVisible();
    fireEvent.click(screen.getByText("audit"));
    fireEvent.click(screen.getByRole("button", { name: "Edit YAML" }));
    expect(screen.getByRole("status", { name: "Loading disk settings" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Loading disk settings" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status", { name: "Loading disk settings" }).textContent).toBe("");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only Cron spawn triggers can be edited.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});

describe("CronJobsModal owner states", () => {
  const withOwner = (owner: CronJobsResponse["projects"][number]["owner"]): CronJobsResponse => ({
    ...READY,
    projects: READY.projects.map((project) => ({ ...project, owner })),
  });

  it.each([
    [
      {
        state: "invalid",
        path: "/repo/api/spur.yaml",
        revision: "r",
        error: "schedule must be a string",
      },
      "• spur.yaml invalid: schedule must be a string",
    ],
    [{ state: "project_removed" }, "• API removed from its config file, not loaded"],
  ] as const)("renders the %o drift line", async (owner, text) => {
    stubFetch(() => jsonResponse(withOwner(owner)));
    renderModal();
    await screen.findByText("audit");
    expect(spanWithText(text)).toBeInTheDocument();
  });

  function spanWithText(text: string): HTMLElement {
    return screen.getByText(
      (_, element) => element?.tagName === "SPAN" && element.textContent === text,
    );
  }

  it("lists each failed config file with its parser message, capped at three", async () => {
    const failed = (file: string) => ({
      file,
      reason: "parse_error" as const,
      message: `Bad indent in ${file} at line 2, column 1`,
    });
    stubFetch(() =>
      jsonResponse(
        withOwner({
          state: "ambiguous",
          failedFiles: [
            failed("spur.yaml"),
            { file: "b.yaml", reason: "unreadable", message: "EACCES" },
            failed("c.yaml"),
            failed("d.yaml"),
          ],
        }),
      ),
    );
    renderModal();
    await screen.findByText("audit");
    expect(spanWithText("• config for API not found; failed to load:")).toBeInTheDocument();
    expect(
      spanWithText("spur.yaml invalid: Bad indent in spur.yaml at line 2, column 1"),
    ).toBeInTheDocument();
    expect(spanWithText("b.yaml unreadable: EACCES")).toBeInTheDocument();
    expect(
      spanWithText("c.yaml invalid: Bad indent in c.yaml at line 2, column 1"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/d\.yaml invalid/)).toBeNull();
    expect(spanWithText("and 1 more")).toBeInTheDocument();
  });

  it("shows removed rows for a project removed from its file", async () => {
    stubFetch(() =>
      jsonResponse({
        ...withOwner({ state: "project_removed" }),
        projects: withOwner({ state: "project_removed" }).projects.map((project) => ({
          ...project,
          sources: project.sources.map((source) => ({ ...source, disk: "removed" as const })),
        })),
      }),
    );
    renderModal();
    await screen.findByText("audit");
    expect(screen.getAllByTitle("removed on disk").length).toBeGreaterThan(0);
  });

  it("shows a send trigger prompt in settings", async () => {
    stubFetch(() =>
      jsonResponse({
        eventsSince: null,
        projects: [
          {
            projectId: "api",
            projectName: "API",
            owner: { state: "loaded", path: "/repo/api/spur.yaml", revision: "r", changed: false },
            sources: [
              {
                sourceId: "digest",
                schedule: "0 * * * *",
                runOnStart: false,
                disk: "same",
                recentTicks: [],
                triggers: [
                  {
                    triggerId: "poke",
                    event: "cron:tick",
                    disk: "same",
                    action: { kind: "send", prompt: "Post the hourly digest" },
                    recentActions: [],
                  },
                ],
              },
            ],
          },
        ],
      } satisfies CronJobsResponse),
    );
    renderModal();
    fireEvent.click((await screen.findByText("poke")).closest("button") as HTMLElement);
    const settings = screen.getByText("Settings").closest("section") as HTMLElement;
    const pairs = Array.from(settings.querySelectorAll("dt")).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(pairs).toContainEqual(["Action", "send"]);
    expect(pairs).toContainEqual(["Prompt", "Post the hourly digest"]);
  });
});
