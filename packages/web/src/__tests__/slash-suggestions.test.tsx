import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlashSuggestions } from "@/components/SlashSuggestions";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
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
});
