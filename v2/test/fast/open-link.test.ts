import { describe, expect, it, vi } from "vitest";
import { openExternalUrl, runOpenLinkCli } from "../../src/open-link.js";

describe("open-link", () => {
  it("spawns the first available opener and detaches it", () => {
    const unref = vi.fn();
    const spawnProcess = vi.fn().mockReturnValue({ unref });

    const opened = openExternalUrl("https://tracker.example.com/TASK-1", {
      openers: ["open", "xdg-open"],
      spawnProcess,
    });

    expect(opened).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith("open", ["https://tracker.example.com/TASK-1"], {
      detached: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("falls back past missing openers and returns false when none are available", () => {
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        const error = new Error("missing opener") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      })
      .mockImplementationOnce(() => {
        const error = new Error("still missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      });

    const opened = openExternalUrl("https://github.com/org/repo/pull/42", {
      openers: ["open", "xdg-open"],
      spawnProcess,
    });

    expect(opened).toBe(false);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("returns a failure exit code when no URL is provided", () => {
    expect(runOpenLinkCli(["node", "open-link.js"])).toBe(1);
  });
});
