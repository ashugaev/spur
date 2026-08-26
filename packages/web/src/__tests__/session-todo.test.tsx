import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTodo } from "@/components/SessionTodo.js";
import type { SpurTodoProjection } from "@/lib/types.js";

const projection: SpurTodoProjection = {
  revision: "event-2",
  status: "held",
  counts: { total: 1, open: 0, held: 1, completed: 0, cancelled: 0 },
  items: [
    {
      id: "item-12345678",
      text: "Choose the public command",
      status: "held",
      added: {
        reason: "Required by the task",
        actor: { kind: "system", source: "spawn" },
        at: "2026-08-20T10:00:00.000Z",
      },
      latestTransition: {
        type: "held",
        reason: "Need product input",
        blocker: { kind: "human", requiredAction: "Choose command name" },
        actor: { kind: "agent", agent: "codex", sessionId: "api-1" },
        at: "2026-08-20T10:01:00.000Z",
      },
      history: [
        {
          eventId: "event-1",
          type: "item_added",
          reason: "Required by the task",
          actor: { kind: "system", source: "spawn" },
          at: "2026-08-20T10:00:00.000Z",
        },
        {
          eventId: "event-2",
          type: "item_held",
          reason: "Need product input",
          blocker: { kind: "human", requiredAction: "Choose command name" },
          actor: { kind: "agent", agent: "codex", sessionId: "api-1" },
          at: "2026-08-20T10:01:00.000Z",
        },
      ],
    },
  ],
  finishOverrides: [],
};

afterEach(() => vi.restoreAllMocks());

describe("SessionTodo", () => {
  it("shows compact human action and expands immutable audit detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(projection), { status: 200 }),
    );
    render(<SessionTodo sessionId="api-1" />);

    expect(screen.getByLabelText("Loading ToDo")).toBeInTheDocument();
    expect(await screen.findByText("Human action: Choose command name")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Choose the public command/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Need product input")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete|complete|cancel|resume/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the last good projection when polling fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(projection), { status: 200 }))
      .mockRejectedValue(new Error("transport failed"));
    render(<SessionTodo sessionId="api-1" />);
    expect(await screen.findByText("Choose the public command")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Choose the public command")).toBeInTheDocument());
  });

  it("shows transport and corrupt-payload failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("transport failed"));
    const { unmount } = render(<SessionTodo sessionId="api-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("transport failed");
    unmount();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "resolved", items: [] }), { status: 200 }),
    );
    render(<SessionTodo sessionId="api-2" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid ToDo response");
  });

  it("hides zero unfinished indicators for resolved work", async () => {
    const resolved: SpurTodoProjection = {
      ...projection,
      revision: "event-3",
      status: "resolved",
      counts: { total: 1, open: 0, held: 0, completed: 1, cancelled: 0 },
      items: [
        {
          ...projection.items[0]!,
          status: "completed",
          latestTransition: {
            type: "completed",
            reason: "Shipped",
            actor: { kind: "agent", agent: "codex", sessionId: "api-1" },
            at: "2026-08-20T10:02:00.000Z",
          },
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(resolved), { status: 200 }),
    );
    render(<SessionTodo sessionId="api-1" />);

    expect(await screen.findByText("1 resolved")).toBeInTheDocument();
    expect(screen.queryByText("0 open")).not.toBeInTheDocument();
    expect(screen.queryByText("0 held")).not.toBeInTheDocument();
  });

  it("renders completion override audit history without changing item state", async () => {
    const overridden: SpurTodoProjection = {
      ...projection,
      status: "active",
      counts: { total: 1, open: 1, held: 0, completed: 0, cancelled: 0 },
      items: [{ ...projection.items[0]!, status: "open", latestTransition: undefined }],
      finishOverrides: [
        {
          eventId: "override-1",
          type: "finish_override_recorded",
          reason: "Operator accepted risk",
          unfinishedItemIds: [projection.items[0]!.id],
          actor: { kind: "human", origin: "ui" },
          at: "2026-08-20T10:03:00.000Z",
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(overridden), { status: 200 }),
    );
    render(<SessionTodo sessionId="api-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Choose the public command/ }));

    expect(screen.getByText(/Completion override/)).toBeInTheDocument();
    expect(screen.getByText("Operator accepted risk")).toBeInTheDocument();
    expect(screen.getByLabelText("open")).toBeInTheDocument();
  });

  it("hard-wraps a long unbroken item text and expanded reasons so they never overflow", async () => {
    const longToken = "supercalifragilisticexpialidocious".repeat(8);
    const overflowing: SpurTodoProjection = {
      ...projection,
      items: [
        {
          ...projection.items[0]!,
          text: longToken,
          latestTransition: {
            type: "held",
            reason: longToken,
            blocker: { kind: "human", requiredAction: "Choose command name" },
            actor: { kind: "agent", agent: "codex", sessionId: "api-1" },
            at: "2026-08-20T10:01:00.000Z",
          },
          history: [
            {
              eventId: "event-1",
              type: "item_held",
              reason: longToken,
              actor: { kind: "system", source: "spawn" },
              at: "2026-08-20T10:00:00.000Z",
            },
          ],
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(overflowing), { status: 200 }),
    );
    render(<SessionTodo sessionId="api-1" />);

    const itemText = await screen.findByText(longToken, { selector: "span" });
    expect(itemText).toHaveClass("min-w-0");
    expect(itemText).toHaveClass("[overflow-wrap:anywhere]");

    fireEvent.click(screen.getByRole("button", { name: new RegExp(longToken) }));
    const reason = screen.getAllByText(longToken, { selector: "div" })[0] as HTMLElement;
    expect(reason).toHaveClass("[overflow-wrap:anywhere]");
    expect(reason).toHaveClass("whitespace-pre-wrap");
  });
});
