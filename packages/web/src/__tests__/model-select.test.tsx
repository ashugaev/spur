import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelect } from "@/components/ModelSelect.js";
import type { AgentModel } from "@/lib/types.js";

const CLAUDE_MODELS: AgentModel[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const CODEX_MODELS: AgentModel[] = [{ id: "gpt-5.5", label: "GPT-5.5" }];

function mockModelsFetch(byAgent: Record<string, AgentModel[]>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const agent = new URL(url, "http://localhost").searchParams.get("agent") ?? "";
    const models = byAgent[agent] ?? [];
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ models }),
    } as Response);
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ModelSelect", () => {
  it("opens the menu and filters models by search", async () => {
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(<ModelSelect agent="claude" value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument());
    expect(screen.getByRole("menuitem", { name: /Haiku/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "opus" } });
    expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Haiku/ })).not.toBeInTheDocument();
  });

  it("shows a Default option that clears the model", async () => {
    const onChange = vi.fn();
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(<ModelSelect agent="claude" value="opus" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Default" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("pins a favorited model to the top and persists it", async () => {
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(<ModelSelect agent="claude" value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Haiku/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add favorite Haiku/ }));

    const items = screen.getAllByRole("menuitem").filter((el) => el.textContent !== "Default");
    expect(items[0]?.textContent).toContain("Haiku");

    const stored = window.localStorage.getItem("spur:model-favorites");
    expect(stored).toContain("claude:haiku");
  });

  it("resets the selection when the agent changes to a list that lacks it", async () => {
    const onChange = vi.fn();
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS, codex: CODEX_MODELS }));
    const { rerender } = render(<ModelSelect agent="claude" value="opus" onChange={onChange} />);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());

    rerender(<ModelSelect agent="codex" value="opus" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it("does not drop a persisted value when switching back to an agent whose list hasn't loaded yet", async () => {
    // "haiku" is deliberately NOT the model that a preselect/fallback would
    // pick for claude (the first entry, "opus"), so a regression that
    // discards it in favor of a fallback pick would be caught here.
    const onChange = vi.fn();
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS, codex: CODEX_MODELS }));
    const { rerender } = render(<ModelSelect agent="claude" value="haiku" onChange={onChange} />);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());

    // Switch to codex (its own persisted model), then back to claude with
    // "haiku" restored -- simulating the parent seeding value synchronously
    // on agent change, ahead of the new agent's models fetch resolving.
    rerender(<ModelSelect agent="codex" value="gpt-5.5" onChange={onChange} />);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());

    rerender(<ModelSelect agent="claude" value="haiku" onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Haiku");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("preselectWhenEmpty", () => {
    it("auto-selects the alphabetically-first favorited model", async () => {
      window.localStorage.setItem(
        "spur:model-favorites",
        JSON.stringify(["claude:sonnet", "claude:haiku"]),
      );
      const onChange = vi.fn();
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      render(<ModelSelect agent="claude" onChange={onChange} preselectWhenEmpty value={null} />);

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("haiku"));
    });

    it("auto-selects the first model in the fetched list when there are no favorites", async () => {
      const onChange = vi.fn();
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      render(<ModelSelect agent="claude" onChange={onChange} preselectWhenEmpty value={null} />);

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("opus"));
    });

    it("does not auto-select when the prop is left off (default), non-regression for respawn/handoff/Shepherd", async () => {
      const onChange = vi.fn();
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      render(<ModelSelect agent="claude" onChange={onChange} value={null} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Default");
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it("never shows the literal Default text on the button, before or after models load", async () => {
      const onChange = vi.fn();
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      const { rerender } = render(
        <ModelSelect agent="claude" onChange={onChange} preselectWhenEmpty value={null} />,
      );

      // Synchronously after mount, before the models fetch resolves: showing
      // the same "Loading…" copy the dropdown body uses, never "Default".
      expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Default");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("opus"));
      rerender(<ModelSelect agent="claude" onChange={onChange} preselectWhenEmpty value="opus" />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus");
      });

      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: /Sonnet/ })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("menuitem", { name: "Default" })).not.toBeInTheDocument();
    });
  });

  describe("onUserSelect", () => {
    it("fires with the model id on a model click and with null on the Default click", async () => {
      const onChange = vi.fn();
      const onUserSelect = vi.fn();
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      render(
        <ModelSelect agent="claude" onChange={onChange} onUserSelect={onUserSelect} value={null} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: /Sonnet/ })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));
      expect(onUserSelect).toHaveBeenCalledWith("sonnet");

      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Default" }));
      expect(onUserSelect).toHaveBeenCalledWith(null);
    });

    it("does not fire for the programmatic clear-on-agent-change", async () => {
      const onChange = vi.fn();
      const onUserSelect = vi.fn();
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS, codex: CODEX_MODELS }));
      const { rerender } = render(
        <ModelSelect agent="claude" onChange={onChange} onUserSelect={onUserSelect} value="opus" />,
      );
      await waitFor(() => expect(onChange).not.toHaveBeenCalled());

      rerender(
        <ModelSelect agent="codex" onChange={onChange} onUserSelect={onUserSelect} value="opus" />,
      );
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
      expect(onUserSelect).not.toHaveBeenCalled();
    });
  });
});
