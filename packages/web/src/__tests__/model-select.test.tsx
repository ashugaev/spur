import { useState } from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelect } from "@/components/ModelSelect.js";
import type { AgentModel, SpawnDefaultsResponse } from "@/lib/types.js";

const CLAUDE_MODELS: AgentModel[] = [
  { id: "opus", label: "Opus", isDefault: true },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const CODEX_MODELS: AgentModel[] = [{ id: "codex-model-id", label: "Codex model" }];

function mockSpurFetch(options: {
  models?: Record<string, AgentModel[]>;
  defaults?: SpawnDefaultsResponse;
}) {
  const defaults: SpawnDefaultsResponse = options.defaults ?? { model: null, worktree: true };
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/models") {
      const agent = parsed.searchParams.get("agent") ?? "";
      const models = options.models?.[agent] ?? [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models }) } as Response);
    }
    if (parsed.pathname.endsWith("/spawn-defaults")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaults) } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
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
    vi.stubGlobal("fetch", mockSpurFetch({ models: { claude: CLAUDE_MODELS } }));
    render(
      <ModelSelect agent="claude" carry={null} onChange={vi.fn()} projectId="proj" value={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument());
    expect(screen.getByRole("menuitem", { name: /Haiku/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "opus" } });
    expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Haiku/ })).not.toBeInTheDocument();
  });

  it("never renders a Default menu row", async () => {
    vi.stubGlobal("fetch", mockSpurFetch({ models: { claude: CLAUDE_MODELS } }));
    render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={vi.fn()}
        projectId="proj"
        value="sonnet"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: "Default" })).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("shows Resolving… before the fetches settle, then the resolved concrete label", async () => {
    vi.stubGlobal("fetch", mockSpurFetch({ models: { claude: CLAUDE_MODELS } }));

    function Harness() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <ModelSelect agent="claude" carry={null} onChange={setValue} projectId="proj" value={value} />
      );
    }

    render(<Harness />);

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Resolving…");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus"),
    );
  });

  it("pins a favorited model to the top and persists it", async () => {
    vi.stubGlobal("fetch", mockSpurFetch({ models: { claude: CLAUDE_MODELS } }));
    render(
      <ModelSelect agent="claude" carry={null} onChange={vi.fn()} projectId="proj" value={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Haiku/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add favorite Haiku/ }));

    const items = screen.getAllByRole("menuitem");
    expect(items[0]?.textContent).toContain("Haiku");

    const stored = window.localStorage.getItem("spur:model-favorites");
    expect(stored).toContain("claude:haiku");
  });

  it("preselects the first favorite over the project-resolved default", async () => {
    window.localStorage.setItem("spur:model-favorites", JSON.stringify(["claude:haiku"]));
    const onChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockSpurFetch({
        models: { claude: CLAUDE_MODELS },
        defaults: { model: "opus", worktree: true },
      }),
    );
    render(
      <ModelSelect agent="claude" carry={null} onChange={onChange} projectId="proj" value={null} />,
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("haiku"));
  });

  it("resets the selection when the agent changes to a list that lacks it", async () => {
    const onChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockSpurFetch({ models: { claude: CLAUDE_MODELS, codex: CODEX_MODELS } }),
    );
    const { rerender } = render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={onChange}
        projectId="proj"
        value="opus"
      />,
    );
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());

    rerender(
      <ModelSelect agent="codex" carry={null} onChange={onChange} projectId="proj" value="opus" />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it("re-pins to a concrete model after a stale-selection reset without looping", async () => {
    vi.stubGlobal("fetch", mockSpurFetch({ models: { claude: CLAUDE_MODELS } }));
    const onChangeSpy = vi.fn();

    function Harness() {
      const [value, setValue] = useState<string | null>("stale-id");
      return (
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={(next) => {
            onChangeSpy(next);
            setValue(next);
          }}
          projectId="proj"
          value={value}
        />
      );
    }

    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus"),
    );
    // Exactly two transitions: the stale-selection reset to null, then the
    // resolver's fill-in to the first list entry. Anything more indicates a
    // loop between the two effects.
    expect(onChangeSpy).toHaveBeenCalledTimes(2);
    expect(onChangeSpy).toHaveBeenNthCalledWith(1, null);
    expect(onChangeSpy).toHaveBeenNthCalledWith(2, "opus");
  });
});
