import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelect } from "@/components/ModelSelect.js";
import type { ResolvedSpawnDefaults } from "@/lib/spawn-defaults.js";
import type { AgentModel } from "@/lib/types.js";

const CLAUDE_MODELS: AgentModel[] = [
  { id: "opus", label: "Opus", isDefault: true },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const CODEX_MODELS: AgentModel[] = [{ id: "codex-model-id", label: "Codex model" }];

// The owning component (Dashboard, SessionDetail) now fetches spawn-defaults
// once and passes the result down; ModelSelect no longer fetches it itself.
// Most tests only care about the model catalog, so default to an
// already-settled, no-project-default answer.
const SETTLED_NO_DEFAULT: ResolvedSpawnDefaults = {
  model: null,
  worktree: null,
  loading: false,
  error: null,
};

function mockModelsFetch(models: Record<string, AgentModel[]>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/models") {
      const agent = parsed.searchParams.get("agent") ?? "";
      const list = models[agent] ?? [];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ models: list }),
      } as Response);
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
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={vi.fn()}
        onResolvedChange={vi.fn()}
        spawnDefaults={SETTLED_NO_DEFAULT}
        value={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument());
    expect(screen.getByRole("menuitem", { name: /Haiku/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "opus" } });
    expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Haiku/ })).not.toBeInTheDocument();
  });

  it("never renders a Default menu row", async () => {
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={vi.fn()}
        onResolvedChange={vi.fn()}
        spawnDefaults={SETTLED_NO_DEFAULT}
        value="sonnet"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: "Default" })).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    // Opus carries the agent's own catalog isDefault flag, but "sonnet" is
    // selected here — the badge must never read as "the selected/preselected
    // choice" for this control, only as the agent catalog's own default.
    expect(screen.queryByText("(default)")).not.toBeInTheDocument();
    expect(screen.getByText("(catalog default)")).toBeInTheDocument();
  });

  it("shows a motion-only resolving indicator before the fetches settle, then the resolved concrete label", async () => {
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));

    function Harness() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={setValue}
          onResolvedChange={vi.fn()}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={value}
        />
      );
    }

    render(<Harness />);

    // No visible wait-text label — a motion-only Skeleton instead.
    expect(
      within(screen.getByRole("button", { name: "Model" })).getByRole("status", {
        name: "Resolving model",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus"),
    );
  });

  it("pins a favorited model to the top and persists it", async () => {
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={vi.fn()}
        onResolvedChange={vi.fn()}
        spawnDefaults={SETTLED_NO_DEFAULT}
        value={null}
      />,
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
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
    render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={onChange}
        onResolvedChange={vi.fn()}
        spawnDefaults={{ model: "opus", worktree: true, loading: false, error: null }}
        value={null}
      />,
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("haiku"));
  });

  it("resets the selection when the agent changes to a list that lacks it", async () => {
    const onChange = vi.fn();
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS, codex: CODEX_MODELS }));
    const { rerender } = render(
      <ModelSelect
        agent="claude"
        carry={null}
        onChange={onChange}
        onResolvedChange={vi.fn()}
        spawnDefaults={SETTLED_NO_DEFAULT}
        value="opus"
      />,
    );
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());

    rerender(
      <ModelSelect
        agent="codex"
        carry={null}
        onChange={onChange}
        onResolvedChange={vi.fn()}
        spawnDefaults={SETTLED_NO_DEFAULT}
        value="opus"
      />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it("re-pins to a concrete model after a stale-selection reset without looping", async () => {
    vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
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
          onResolvedChange={vi.fn()}
          spawnDefaults={SETTLED_NO_DEFAULT}
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

  describe("onResolvedChange", () => {
    it("never reports resolved on the pre-effect mount render, even when the models fetch settles fast", async () => {
      // Regression guard: ModelSelect's own `loading` must start true, not
      // false. If it started false, the very first render — before the
      // mount effect has set loading — would compute `settled` as true and
      // fire a spurious onResolvedChange(true) ahead of the real one, even
      // though the models fetch hasn't actually resolved yet.
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      const onResolvedChange = vi.fn();
      render(
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={null}
        />,
      );

      // Checked synchronously, right after the mount commit: the very first
      // call recorded must be `false`, never `true`, regardless of how fast
      // the underlying fetch goes on to settle.
      expect(onResolvedChange.mock.calls[0]).toEqual([false, null]);

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(true, null));
    });

    it("reports unresolved while the model list is in flight, then resolved once settled with a concrete model", async () => {
      let resolveModels: ((response: Response) => void) | undefined;
      const pendingModels = new Promise<Response>((resolve) => {
        resolveModels = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const parsed = new URL(url, "http://localhost");
          if (parsed.pathname === "/api/models") return pendingModels;
          return Promise.reject(new Error(`unexpected fetch ${url}`));
        }) as unknown as typeof fetch,
      );
      const onResolvedChange = vi.fn();

      function Harness() {
        const [value, setValue] = useState<string | null>(null);
        return (
          <ModelSelect
            agent="claude"
            carry={null}
            onChange={setValue}
            onResolvedChange={onResolvedChange}
            spawnDefaults={SETTLED_NO_DEFAULT}
            value={value}
          />
        );
      }

      render(<Harness />);

      expect(onResolvedChange).toHaveBeenCalledWith(false, null);
      expect(onResolvedChange).not.toHaveBeenCalledWith(true, null);
      expect(
        within(screen.getByRole("button", { name: "Model" })).getByRole("status", {
          name: "Resolving model",
        }),
      ).toBeInTheDocument();

      resolveModels?.(
        new Response(JSON.stringify({ models: CLAUDE_MODELS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus"),
      );
      expect(onResolvedChange).toHaveBeenLastCalledWith(true, null);
    });

    it("stays unresolved while the caller's spawnDefaults is still loading, even once the model list has settled", async () => {
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      const onResolvedChange = vi.fn();
      const { rerender } = render(
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={{ model: null, worktree: null, loading: true, error: null }}
          value={null}
        />,
      );

      // The model list itself resolves quickly, but the caller-owned
      // spawnDefaults fetch is still in flight; settle must wait on both.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onResolvedChange).not.toHaveBeenCalledWith(true, null);

      rerender(
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={{ model: null, worktree: true, loading: false, error: null }}
          value={null}
        />,
      );

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(true, null));
    });

    it("reports resolved with a null value once the catalog settles empty", async () => {
      vi.stubGlobal("fetch", mockModelsFetch({}));
      const onResolvedChange = vi.fn();
      const onChange = vi.fn();
      render(
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={onChange}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={null}
        />,
      );

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(true, null));
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("No models");
    });

    it("stays unresolved and reports the error when the models fetch errors, distinct from a genuinely empty catalog", async () => {
      // F3: an errored fetch must not be treated like a settled-empty
      // catalog — it keeps blocking submit (never reports resolved:true)
      // and surfaces the failure message, the same way an unresolved
      // workspace-mode default does at the caller.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch,
      );
      const onResolvedChange = vi.fn();
      const onChange = vi.fn();
      render(
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={onChange}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={null}
        />,
      );

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(false, "network down"));
      // B2: the closed control's own label must not read the same as a
      // genuinely empty catalog — the user should not have to open the
      // dropdown to learn the list simply failed to load.
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
        "Model list unavailable",
      );
      expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("No models");
      // Stays this way — never flips to resolved on its own.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onResolvedChange).not.toHaveBeenCalledWith(true, expect.anything());
      expect(onChange).not.toHaveBeenCalled();
    });

    it("lets OpenCode spawn without a model when catalog discovery fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch,
      );
      const onResolvedChange = vi.fn();
      render(
        <ModelSelect
          agent="opencode"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={null}
        />,
      );

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(true, "network down"));
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
        "Model list unavailable",
      );
    });

    it("lets OpenCode spawn without a model when catalog discovery is empty", async () => {
      vi.stubGlobal("fetch", mockModelsFetch({ opencode: [] }));
      const onResolvedChange = vi.fn();
      render(
        <ModelSelect
          agent="opencode"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={null}
        />,
      );

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(true, null));
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("No models");
    });

    it("blocks an explicit OpenCode model when catalog discovery fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch,
      );
      const onResolvedChange = vi.fn();
      render(
        <ModelSelect
          agent="opencode"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value="openai/gpt-5"
        />,
      );

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(false, "network down"));
    });

    it("F2: a models fetch that never resolves on its own times out into the error state instead of disabling submit forever", async () => {
      vi.useFakeTimers();
      let capturedSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          capturedSignal = init?.signal ?? undefined;
          // Never resolves or rejects on its own — only reacts to abort,
          // exactly like a real fetch racing AbortSignal.timeout.
          return new Promise<Response>((_resolve, reject) => {
            capturedSignal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted", "TimeoutError"));
            });
          });
        }) as unknown as typeof fetch,
      );
      const onResolvedChange = vi.fn();
      render(
        <ModelSelect
          agent="claude"
          carry={null}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value={null}
        />,
      );

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(onResolvedChange).not.toHaveBeenCalledWith(true, expect.anything());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });

      expect(onResolvedChange).toHaveBeenLastCalledWith(false, expect.any(String));
      expect(
        within(screen.getByRole("button", { name: "Model" })).queryByRole("status", {
          name: "Resolving model",
        }),
      ).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it("does not report resolved just because a caller-seeded value is already non-null, before any fetch settles", async () => {
      // A caller must seed `value` as null and rely on `carry` alone (see
      // SessionDetail's openRespawnEditor): a value seeded directly from an
      // unfiltered source, like session.model, would otherwise report
      // resolved immediately even for a model that has since left the
      // catalog. Reported here with a value the seed would produce, to
      // confirm the settle signal never trusts it early regardless.
      vi.stubGlobal("fetch", mockModelsFetch({ claude: CLAUDE_MODELS }));
      const onResolvedChange = vi.fn();
      render(
        <ModelSelect
          agent="claude"
          carry={{ agent: "claude", model: "opus" }}
          onChange={vi.fn()}
          onResolvedChange={onResolvedChange}
          spawnDefaults={SETTLED_NO_DEFAULT}
          value="opus"
        />,
      );

      expect(onResolvedChange).toHaveBeenCalledWith(false, null);
      expect(onResolvedChange).not.toHaveBeenCalledWith(true, null);

      await waitFor(() => expect(onResolvedChange).toHaveBeenLastCalledWith(true, null));
    });
  });
});
