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
        canForceKill
        onForceKill={vi.fn()}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Session api-1 is not restorable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Force Kill" })).toBeInTheDocument();
  });

  it("renders Respawn regardless of availableActions", () => {
    const forceKillOnly = render(
      <RecoverActionDialog
        payload={payload({ availableActions: ["force_kill"] })}
        canForceKill
        onForceKill={vi.fn()}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Respawn" })).toBeInTheDocument();
    forceKillOnly.unmount();

    render(
      <RecoverActionDialog
        payload={payload({ availableActions: ["respawn"] })}
        canForceKill
        onForceKill={vi.fn()}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Respawn" })).toBeInTheDocument();
  });

  it("hides Force Kill while keeping Respawn and Cancel when canForceKill is false", () => {
    render(
      <RecoverActionDialog
        payload={payload()}
        canForceKill={false}
        onForceKill={vi.fn()}
        onRespawn={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Force Kill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Respawn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("fires the matching callback for each action", () => {
    const onForceKill = vi.fn();
    const onRespawn = vi.fn();
    const onCancel = vi.fn();

    render(
      <RecoverActionDialog
        payload={payload()}
        canForceKill
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
        canForceKill
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
