import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlashSuggestions } from "@/components/SlashSuggestions";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  window.localStorage.clear();
});

describe("SlashSuggestions", () => {
  it("renders the toggle button labeled '/'", () => {
    render(<SlashSuggestions endpoint="/api/suggestions" onSelect={() => undefined} />);
    expect(screen.getByRole("button", { name: "Slash" })).toBeInTheDocument();
  });

  it("does not request suggestions until the button is clicked", () => {
    render(<SlashSuggestions endpoint="/api/suggestions" onSelect={() => undefined} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the menu and fires onSelect when a suggestion is clicked", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          commands: [{ id: "compact", label: "/compact", detail: "Summarize", source: "agent" }],
          skills: [],
          agents: [],
        }),
    });
    const onSelect = vi.fn();
    render(<SlashSuggestions endpoint="/api/suggestions" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Slash" }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("menuitem"));

    expect(onSelect).toHaveBeenCalledWith({
      id: "compact",
      label: "/compact",
      detail: "Summarize",
      source: "agent",
    });
  });

  it("moves favorite suggestions into a top Favorites group without duplicates", async () => {
    window.localStorage.setItem(
      "spur:slash-suggestion-favorites",
      JSON.stringify(["command:project:review", "skill:user:planner"]),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          commands: [
            {
              id: "compact",
              label: "/compact",
              detail: "Summarize",
              source: "agent",
              kind: "command",
            },
            {
              id: "review",
              label: "/review",
              detail: "Review",
              source: "project",
              kind: "command",
            },
          ],
          skills: [
            {
              id: "planner",
              label: "$planner",
              detail: "Plan",
              source: "user",
              kind: "skill",
            },
          ],
          agents: [],
        }),
    });

    render(<SlashSuggestions endpoint="/api/suggestions" onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Slash" }));

    await waitFor(() => {
      expect(screen.getByText("Favorites")).toBeInTheDocument();
    });

    expect(
      screen.getAllByText(/^(Favorites|Commands)$/).map((header) => header.textContent),
    ).toEqual(["Favorites", "Commands"]);
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "/reviewReview",
      "$plannerPlan",
      "/compactSummarize",
    ]);
  });

  it("filters suggestions by the search input over label, detail, and id and restores on clear", async () => {
    window.localStorage.setItem(
      "spur:slash-suggestion-favorites",
      JSON.stringify(["command:project:review"]),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          commands: [
            {
              id: "compact",
              label: "/compact",
              detail: "Summarize",
              source: "agent",
              kind: "command",
            },
            {
              id: "review",
              label: "/review",
              detail: "Review changes",
              source: "project",
              kind: "command",
            },
          ],
          skills: [
            { id: "planner", label: "$planner", detail: "Plan", source: "user", kind: "skill" },
          ],
          agents: [],
        }),
    });

    render(<SlashSuggestions endpoint="/api/suggestions" onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Slash" }));

    const search = await screen.findByRole("textbox", { name: "Search commands" });
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);

    // Typing filters to matches (by label/detail/id, case-insensitive).
    fireEvent.change(search, { target: { value: "plan" } });
    await waitFor(() => {
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "$plannerPlan",
      ]);
    });
    expect(screen.queryByText("Favorites")).not.toBeInTheDocument();

    // Favorites still pin to the top within the filtered set.
    fireEvent.change(search, { target: { value: "review" } });
    await waitFor(() => {
      expect(screen.getByText("Favorites")).toBeInTheDocument();
    });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "/reviewReview changes",
    ]);

    // Clearing restores the full list.
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    });
  });

  it("does not render a Favorites group when no visible suggestions are favorited", async () => {
    window.localStorage.setItem(
      "spur:slash-suggestion-favorites",
      JSON.stringify(["command:project:missing"]),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          commands: [
            {
              id: "compact",
              label: "/compact",
              detail: "Summarize",
              source: "agent",
              kind: "command",
            },
          ],
          skills: [],
          agents: [],
        }),
    });

    render(<SlashSuggestions endpoint="/api/suggestions" onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Slash" }));

    await waitFor(() => {
      expect(screen.getByText("Commands")).toBeInTheDocument();
    });

    expect(screen.queryByText("Favorites")).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "/compactSummarize",
    ]);
  });
});
