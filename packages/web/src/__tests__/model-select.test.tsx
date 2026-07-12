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
});
