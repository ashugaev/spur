import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateRespawnParentProcess } from "../../src/cli.js";

const originalTmux = process.env["TMUX"];
const originalSession = process.env["SPUR_SESSION"];
const originalSessionToolDir = process.env["SPUR_SESSION_TOOL_DIR"];
const originalSidecarName = process.env["SPUR_SIDECAR_NAME"];
const originalTest = process.env["TEST"];
const originalVitest = process.env["VITEST"];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTmux === undefined) {
    delete process.env["TMUX"];
  } else {
    process.env["TMUX"] = originalTmux;
  }
  if (originalSession === undefined) {
    delete process.env["SPUR_SESSION"];
  } else {
    process.env["SPUR_SESSION"] = originalSession;
  }
  if (originalSessionToolDir === undefined) {
    delete process.env["SPUR_SESSION_TOOL_DIR"];
  } else {
    process.env["SPUR_SESSION_TOOL_DIR"] = originalSessionToolDir;
  }
  if (originalSidecarName === undefined) {
    delete process.env["SPUR_SIDECAR_NAME"];
  } else {
    process.env["SPUR_SIDECAR_NAME"] = originalSidecarName;
  }
  if (originalTest === undefined) {
    delete process.env["TEST"];
  } else {
    process.env["TEST"] = originalTest;
  }
  if (originalVitest === undefined) {
    delete process.env["VITEST"];
  } else {
    process.env["VITEST"] = originalVitest;
  }
});

describe("terminateRespawnParentProcess", () => {
  it("does not signal parent when not inside tmux", () => {
    delete process.env["TMUX"];
    process.env["SPUR_SESSION"] = "api-a1";
    process.env["SPUR_SESSION_TOOL_DIR"] = "/tmp/spur-tools";
    delete process.env["SPUR_SIDECAR_NAME"];
    delete process.env["TEST"];
    delete process.env["VITEST"];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    terminateRespawnParentProcess();

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does not signal parent when inside tmux without a session-bound context", () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,123,0";
    delete process.env["SPUR_SESSION"];
    delete process.env["SPUR_SESSION_TOOL_DIR"];
    delete process.env["SPUR_SIDECAR_NAME"];
    delete process.env["TEST"];
    delete process.env["VITEST"];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    terminateRespawnParentProcess();

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("signals the parent process in tmux", () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,123,0";
    process.env["SPUR_SESSION"] = "api-a1";
    process.env["SPUR_SESSION_TOOL_DIR"] = "/tmp/spur-tools";
    delete process.env["SPUR_SIDECAR_NAME"];
    delete process.env["TEST"];
    delete process.env["VITEST"];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    terminateRespawnParentProcess();

    expect(killSpy).toHaveBeenCalledWith(process.ppid, "SIGTERM");
  });

  it("ignores missing parent process errors", () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,123,0";
    process.env["SPUR_SESSION"] = "api-a1";
    process.env["SPUR_SESSION_TOOL_DIR"] = "/tmp/spur-tools";
    delete process.env["SPUR_SIDECAR_NAME"];
    delete process.env["TEST"];
    delete process.env["VITEST"];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("process missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    expect(() => terminateRespawnParentProcess()).not.toThrow();
    expect(killSpy).toHaveBeenCalledWith(process.ppid, "SIGTERM");
  });

  it("skips parent signaling in test environments", () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,123,0";
    process.env["SPUR_SESSION"] = "api-a1";
    process.env["SPUR_SESSION_TOOL_DIR"] = "/tmp/spur-tools";
    process.env["TEST"] = "1";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const signaled = terminateRespawnParentProcess();

    expect(signaled).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
