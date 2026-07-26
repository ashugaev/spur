import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwitchAuthDialog } from "@/components/SwitchAuthDialog";

describe("SwitchAuthDialog", () => {
  it("keeps an expired committed account current and disables unavailable targets", () => {
    render(
      <SwitchAuthDialog
        accounts={[
          { id: "home", label: "Home", status: "expired" },
          { id: "work", label: "Work", status: "ready" },
          { id: "legacy", label: "Old", status: "legacy" },
        ]}
        activeAccountId="home"
        errorMessage={null}
        status="idle"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const home = screen.getByRole("option", { name: "Home (current) (expired)" });
    const work = screen.getByRole("option", { name: "Work" });
    const legacy = screen.getByRole("option", { name: "Old (legacy)" });
    expect(home).toBeDisabled();
    expect(legacy).toBeDisabled();
    expect(work).toBeEnabled();
    expect(screen.getByRole("combobox")).toHaveValue("work");
  });

  it("preserves the current marker while a switch is pending or failed", () => {
    const { rerender } = render(
      <SwitchAuthDialog
        accounts={[
          { id: "home", label: "Home", status: "ready" },
          { id: "work", label: "Work", status: "ready" },
        ]}
        activeAccountId="home"
        errorMessage={null}
        status="pending"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Home (current)" })).toBeInTheDocument();

    rerender(
      <SwitchAuthDialog
        accounts={[
          { id: "home", label: "Home", status: "ready" },
          { id: "work", label: "Work", status: "ready" },
        ]}
        activeAccountId="home"
        errorMessage="switch failed"
        status="error"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Home (current)" })).toBeInTheDocument();
    expect(screen.getByTestId("switch-auth-error")).toHaveTextContent("switch failed");
  });
});
