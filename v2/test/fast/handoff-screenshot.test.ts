import { describe, expect, it, vi } from "vitest";

const captureTmuxPaneOrEmptyMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/runtime-tmux.js", () => ({
  captureTmuxPaneOrEmpty: captureTmuxPaneOrEmptyMock,
}));

import {
  HANDOFF_SCREENSHOT_NAME,
  buildHandoffScreenshotAttachment,
} from "../../src/handoff-screenshot.js";

describe("buildHandoffScreenshotAttachment", () => {
  it("returns null when tmux pane capture is empty", async () => {
    captureTmuxPaneOrEmptyMock.mockResolvedValueOnce("   \n");
    await expect(buildHandoffScreenshotAttachment("spur-1")).resolves.toBeNull();
    expect(captureTmuxPaneOrEmptyMock).toHaveBeenCalledWith("spur-1", 400);
  });

  it("returns a base64 attachment when tmux pane has content", async () => {
    captureTmuxPaneOrEmptyMock.mockResolvedValueOnce("agent output\n");
    const attachment = await buildHandoffScreenshotAttachment("spur-1");
    expect(attachment).toEqual({
      name: HANDOFF_SCREENSHOT_NAME,
      data: Buffer.from("agent output\n", "utf-8").toString("base64"),
    });
  });
});
