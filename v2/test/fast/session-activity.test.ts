import { describe, expect, it } from "vitest";
import { isWaitingInput } from "../../src/session-service.js";

describe("session state detection", () => {
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
  });

  it("detects approval prompts as needs_input", () => {
    expect(isWaitingInput(["Need approval required before continuing", "(Y)es / (N)o"])).toBe(true);
  });

  it("does not mark normal output as needs_input", () => {
    expect(isWaitingInput(["OpenAI Codex", "Working on the task", "No questions for you"])).toBe(
      false,
    );
  });
});
