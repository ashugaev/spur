import { describe, expect, it, vi } from "vitest";
import { applyReloadedConfig, type ReloadApplyHooks } from "../../src/server.js";

const hooksWith = (
  overrides: Partial<ReloadApplyHooks>,
): { hooks: ReloadApplyHooks; calls: string[] } => {
  const calls: string[] = [];
  const hooks: ReloadApplyHooks = {
    applyNext: () => calls.push("applyNext"),
    startAutomation: async () => {
      calls.push("startAutomation");
    },
    applyPrevious: () => calls.push("applyPrevious"),
    onReloaded: () => calls.push("onReloaded"),
    onRollbackFailed: () => calls.push("onRollbackFailed"),
    setReady: (ready) => calls.push(`setReady:${ready}`),
    ...overrides,
  };
  return { hooks, calls };
};

describe("applyReloadedConfig", () => {
  it("applies the new config, starts automation, logs reloaded, and restores readiness", async () => {
    const { hooks, calls } = hooksWith({});
    await applyReloadedConfig(hooks);
    expect(calls).toEqual(["applyNext", "startAutomation", "onReloaded", "setReady:true"]);
  });

  it("rolls back to the previous config and rethrows when the new config fails to start", async () => {
    const failure = new Error("startup failed");
    const startAutomation = vi
      .fn<ReloadApplyHooks["startAutomation"]>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const { hooks, calls } = hooksWith({
      startAutomation: async () => {
        calls.push("startAutomation");
        await startAutomation();
      },
    });

    await expect(applyReloadedConfig(hooks)).rejects.toBe(failure);
    // New start attempted, failed, previous config restored, automation restarted.
    expect(calls).toEqual([
      "applyNext",
      "startAutomation",
      "applyPrevious",
      "startAutomation",
      "setReady:true",
    ]);
    // Successful-reload signal must NOT fire on the rollback path.
    expect(calls).not.toContain("onReloaded");
    expect(calls).not.toContain("onRollbackFailed");
  });

  it("emits the rollback-failed signal, rethrows, and still restores readiness when rollback also fails", async () => {
    const primary = new Error("primary failed");
    const rollback = new Error("rollback failed");
    let attempt = 0;
    const onRollbackFailed = vi.fn();
    const hooks = hooksWith({
      startAutomation: async () => {
        attempt += 1;
        throw attempt === 1 ? primary : rollback;
      },
      onRollbackFailed,
    }).hooks;
    const setReady = vi.fn();
    hooks.setReady = setReady;
    const onReloaded = vi.fn();
    hooks.onReloaded = onReloaded;

    await expect(applyReloadedConfig(hooks)).rejects.toBe(rollback);
    expect(onRollbackFailed).toHaveBeenCalledExactlyOnceWith("rollback failed");
    expect(onReloaded).not.toHaveBeenCalled();
    // Readiness restored even on total failure → daemon stays responsive, never wedged on 503.
    expect(setReady).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("stringifies a non-Error rollback failure for the signal", async () => {
    let attempt = 0;
    const onRollbackFailed = vi.fn();
    const { hooks } = hooksWith({
      startAutomation: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("primary");
        throw "rollback string failure";
      },
      onRollbackFailed,
    });

    await expect(applyReloadedConfig(hooks)).rejects.toBe("rollback string failure");
    expect(onRollbackFailed).toHaveBeenCalledExactlyOnceWith("rollback string failure");
  });
});
