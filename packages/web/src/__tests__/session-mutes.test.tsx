import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMutes } from "@/components/SessionMutes.js";
import type { AutoPingMute, AutoPingMuteProjection } from "@/lib/types.js";

const untilChange: AutoPingMute = {
  suppressionId: "m1",
  mode: "until_change",
  items: [{ subject: "review:github:o/r#7", kind: "ci_failed", label: "until next commit" }],
  createdAt: "2026-11-03T00:00:00.000Z",
};
const forever: AutoPingMute = {
  suppressionId: "m2",
  mode: "forever",
  items: [{ subject: "review:github:o/r#7", kind: "merge_conflict", label: "x" }],
  reason: "trigger is wrong for this session",
  createdAt: "2026-11-03T00:01:00.000Z",
};
const ended = (id: string, endReason: "resumed" | "expired"): AutoPingMute => ({
  ...untilChange,
  suppressionId: id,
  reason: "waiting",
  endedAt: "2026-11-03T02:00:00.000Z",
  endReason,
});

function mockProjection(projection: AutoPingMuteProjection | null, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(projection ?? { error: "down" }), { status }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("SessionMutes", () => {
  it("renders nothing without mutes or history", async () => {
    mockProjection({ records: [], history: [] });
    const { container } = render(<SessionMutes sessionId="api-1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/api-1/auto-ping",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("shows a MUTED count chip and lists kind, subject and until label", async () => {
    mockProjection({ records: [untilChange], history: [untilChange] });
    render(<SessionMutes sessionId="api-1" />);

    const chip = await screen.findByRole("button", { name: "Muted pings 1" });
    expect(chip).toHaveTextContent("Muted 1");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Auto-ping mutes" });
    expect(dialog).toHaveTextContent("ci failed");
    expect(dialog).toHaveTextContent("o/r#7");
    expect(dialog).toHaveTextContent("until next commit");
    // The still-active record is not repeated under History.
    expect(screen.queryByRole("region", { name: "History" })).not.toBeInTheDocument();
  });

  it("shows FOREVER with its reason", async () => {
    mockProjection({ records: [forever], history: [forever] });
    render(<SessionMutes sessionId="api-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Muted pings 1" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("forever");
    expect(dialog).toHaveTextContent("trigger is wrong for this session");
  });

  it("shows a dim MUTES chip with history only", async () => {
    mockProjection({ records: [], history: [ended("h1", "resumed"), ended("h2", "expired")] });
    render(<SessionMutes sessionId="api-1" />);

    expect(screen.queryByRole("button", { name: /Muted pings/ })).not.toBeInTheDocument();
    const chip = await screen.findByRole("button", { name: "Mute history" });
    expect(chip).toHaveTextContent("Mutes");
    fireEvent.click(chip);
    const history = screen.getByRole("region", { name: "History" });
    expect(history).toHaveTextContent("Ended resumed");
    expect(history).toHaveTextContent("Ended expired");
    expect(screen.queryByRole("region", { name: "Active" })).not.toBeInTheDocument();
  });

  it("lists history newest first and drops the stale until label on ended rows", async () => {
    const older = { ...ended("old", "resumed"), endedAt: "2026-11-03T01:00:00.000Z" };
    const newer = { ...ended("new", "expired"), endedAt: "2026-11-03T03:00:00.000Z" };
    mockProjection({ records: [], history: [older, newer] });
    render(<SessionMutes sessionId="api-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Mute history" }));
    const history = screen.getByRole("region", { name: "History" });
    const rows = within(history).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Ended expired");
    expect(rows[1]).toHaveTextContent("Ended resumed");
    expect(history).not.toHaveTextContent("until next commit");
    expect(history).toHaveTextContent("until it changes");
  });

  it("opens and closes the popover by click and Escape", async () => {
    mockProjection({ records: [untilChange], history: [] });
    render(<SessionMutes sessionId="api-1" />);

    const chip = await screen.findByRole("button", { name: "Muted pings 1" });
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays hidden when the poll fails", async () => {
    mockProjection(null, 502);
    const { container } = render(<SessionMutes sessionId="api-1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
