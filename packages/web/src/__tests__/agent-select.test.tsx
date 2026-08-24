import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSelect } from "@/components/AgentSelect";

describe("AgentSelect", () => {
  it("renders all four agent options", () => {
    render(<AgentSelect value="claude" onChange={() => undefined} />);
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("option", { name: "opencode" })).toBeDefined();
  });

  it("marks the current value as selected", () => {
    render(<AgentSelect value="codex" onChange={() => undefined} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("codex");
  });

  it("propagates the new value through onChange", () => {
    const onChange = vi.fn();
    render(<AgentSelect value="claude" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cursor" } });
    expect(onChange).toHaveBeenCalledWith("cursor");
  });
});
