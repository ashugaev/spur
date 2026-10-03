import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningSelect } from "@/components/ReasoningSelect";
import { ModelReasoningField } from "@/components/ModelReasoningField";
import type { ReasoningIntent } from "@/lib/reasoning-effort";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = {
  label: "Respawn reasoning",
  intent: { kind: "carried" as const, level: "high" as const },
  levels: ["low", "high"] as ("low" | "high")[],
  loading: false,
  error: null,
  needsModel: false,
  lifecycle: true,
  projectEffort: "low" as const,
  onChange: vi.fn(),
};

describe("ReasoningSelect", () => {
  it("shows carried value and sends clear rather than project level on Default", () => {
    const onChange = vi.fn();
    render(<ReasoningSelect {...props} onChange={onChange} />);
    expect(screen.getByRole("option", { name: "Reasoning · High · current" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "default" } });
    expect(onChange).toHaveBeenCalledWith({ kind: "clear" });
  });
  it("renders only advertised levels and explicit intent", () => {
    const onChange = vi.fn();
    render(<ReasoningSelect {...props} onChange={onChange} />);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "low" } });
    expect(onChange).toHaveBeenCalledWith({ kind: "explicit", level: "low" });
  });
  it.each([
    { levels: [], needsModel: false, error: null, text: "Not supported" },
    { levels: [], needsModel: true, error: null, text: "Pick a model" },
    { levels: undefined, needsModel: false, error: "catalog failed", text: "Unavailable" },
  ])("disables unavailable metadata: $text", ({ text, ...state }) => {
    render(<ReasoningSelect {...props} {...state} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole("option").textContent).toContain(text);
  });
  it("uses a motion skeleton while loading", () => {
    render(<ReasoningSelect {...props} loading />);
    expect(screen.getByLabelText("Resolving reasoning")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("model capability revalidation", () => {
  function Composer() {
    const [model, setModel] = useState<string | null>("supported");
    const [intent, setIntent] = useState<ReasoningIntent>({ kind: "carried", level: "high" });
    return (
      <>
        <ModelReasoningField
          agent="claude"
          value={model}
          onChange={setModel}
          carry={null}
          spawnDefaults={{ model: null, worktree: false, loading: false, error: null }}
          onValidityChange={() => {}}
          lifecycle
          reasoningLabel="Respawn reasoning"
          reasoningIntent={intent}
          onReasoningChange={setIntent}
        />
        <output>{intent.kind}</output>
        <button onClick={() => setModel("unsupported")}>Switch model</button>
      </>
    );
  }
  it("clears carried unsupported effort using the one existing catalog request", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { id: "supported", label: "Supported", reasoningEfforts: ["high"] },
          { id: "unsupported", label: "Unsupported", reasoningEfforts: [] },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    render(<Composer />);
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("high"),
    );
    fireEvent.click(screen.getByText("Switch model"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("clear"));
    expect(screen.getByText("High not offered by Unsupported, using Default")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
