import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecoverActionDialog } from "@/components/RecoverActionDialog";
import type { SessionNotRestorablePayload } from "@/lib/types";

function payload(
  overrides: Partial<SessionNotRestorablePayload> = {},
): SessionNotRestorablePayload {
  return {
    code: "session_not_restorable",
    sessionId: "api-1",
    reason: "Session api-1 is not restorable",
    availableActions: ["force_kill", "respawn"],
    ...overrides,
  };
}

describe("RecoverActionDialog", () => {
  it("always renders Force Kill and the reason", () => {
    render(
      <RecoverActionDialog
        payload={payload({ availableActions: ["force_kill"] })}
        onForceKill={vi.fn()}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Session api-1 is not restorable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Force Kill" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Respawn" })).not.toBeInTheDocument();
  });

  it("renders Respawn only when it is an available action", () => {
    render(
      <RecoverActionDialog
        payload={payload()}
        onForceKill={vi.fn()}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Respawn" })).toBeInTheDocument();
  });

  it("fires the matching callback for each action", () => {
    const onForceKill = vi.fn();
    const onRespawn = vi.fn();
    const onCancel = vi.fn();

    render(
      <RecoverActionDialog
        payload={payload()}
        onForceKill={onForceKill}
        onRespawn={onRespawn}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Force Kill" }));
    fireEvent.click(screen.getByRole("button", { name: "Respawn" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onForceKill).toHaveBeenCalledTimes(1);
    expect(onRespawn).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables every action while busy", () => {
    const onForceKill = vi.fn();

    render(
      <RecoverActionDialog
        payload={payload()}
        busy
        onForceKill={onForceKill}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const forceKill = screen.getByRole("button", { name: "Force Kill" });
    expect(forceKill).toBeDisabled();
    fireEvent.click(forceKill);
    expect(onForceKill).not.toHaveBeenCalled();
  });
});
