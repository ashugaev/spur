import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRunningState, isWaitingInput } from "../../src/session-service.js";

describe("session state detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));
  });

  it("detects permission and plan-mode menus as needs_input", () => {
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
      classifyRunningState({
        pane: ["Need approval required before continuing", "(Y)es / (N)o"].join("\n"),
        updatedAt: new Date("2026-03-18T10:04:00.000Z"),
        signalAt: null,
      }),
    ).toBe("needs_input");
  });

  it("keeps working state when the pane is not sitting at a prompt", () => {
    expect(
      classifyRunningState({
        pane: ["OpenAI Codex", "›", "• Working (reviewing changes)", "gpt-5.4 · footer"].join("\n"),
        updatedAt: new Date("2026-03-18T10:04:00.000Z"),
        signalAt: null,
      }),
    ).toBe("working");
  });

  it("keeps a prompt in working during the delivery grace window", () => {
    expect(
      classifyRunningState({
        pane: "Claude Code\n❯",
        updatedAt: new Date("2026-03-18T10:04:35.000Z"),
        signalAt: null,
      }),
    ).toBe("working");
  });

  it("treats a stale prompt as waiting when no fresh signal remains", () => {
    expect(
      classifyRunningState({
        pane: "Claude Code\n❯",
        updatedAt: new Date("2026-03-18T10:03:59.000Z"),
        signalAt: null,
      }),
    ).toBe("waiting");
  });
});
