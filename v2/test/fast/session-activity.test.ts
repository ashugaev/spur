import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyActivity, isWaitingInput } from "../../src/session-service.js";

describe("session activity detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));
  });

  it("detects permission and plan-mode menus as waiting_input", () => {
    expect(
      isWaitingInput([
        "Entered plan mode",
        "1. fast",
        "2. runtime",
        "Enter to select",
        "Esc to cancel",
      ]),
    ).toBe(true);

    expect(
      classifyActivity(
        [
          "Need approval required before continuing",
          "(Y)es / (N)o",
        ].join("\n"),
        new Date("2026-03-18T10:04:00.000Z"),
      ),
    ).toBe("waiting_input");
  });

  it("keeps active state when a trailing working line is still visible", () => {
    expect(
      classifyActivity(
        [
          "OpenAI Codex",
          "›",
          "• Working (reviewing changes)",
          "gpt-5.4 · footer",
        ].join("\n"),
        new Date("2026-03-18T10:04:00.000Z"),
      ),
    ).toBe("active");
  });

  it("treats a prompt as ready until the idle threshold passes", () => {
    expect(
      classifyActivity("Claude Code\n❯", new Date("2026-03-18T10:04:30.000Z")),
    ).toBe("ready");

    expect(
      classifyActivity("Claude Code\n❯", new Date("2026-03-18T09:59:59.000Z")),
    ).toBe("idle");
  });
});
