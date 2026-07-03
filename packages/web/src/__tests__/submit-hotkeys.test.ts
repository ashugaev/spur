import { describe, expect, it } from "vitest";
import { isPrimarySubmitHotkey, isVoiceToggleHotkey } from "@/lib/submit-hotkeys";

interface HotkeyEvent {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

function event(overrides: Partial<HotkeyEvent>): HotkeyEvent {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "Enter",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("isPrimarySubmitHotkey", () => {
  it("returns true for Cmd+Enter", () => {
    expect(isPrimarySubmitHotkey(event({ key: "Enter", metaKey: true }))).toBe(true);
  });

  it("returns false for Shift+Enter", () => {
    expect(isPrimarySubmitHotkey(event({ key: "Enter", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
  });

  it("returns false while composing", () => {
    expect(isPrimarySubmitHotkey(event({ key: "Enter", metaKey: true, isComposing: true }))).toBe(
      false,
    );
  });
});

describe("isVoiceToggleHotkey", () => {
  it("returns true for Cmd+.", () => {
    expect(isVoiceToggleHotkey(event({ key: ".", metaKey: true }))).toBe(true);
  });

  it("returns false for plain .", () => {
    expect(isVoiceToggleHotkey(event({ key: "." }))).toBe(false);
  });
});
