import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronJobsModal } from "@/components/CronJobsModal";
import { formatAbsoluteTime, formatShortTimestamp } from "@/lib/format";
import type { CronJobsResponse, ProjectInfo } from "@/lib/types";

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
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
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
