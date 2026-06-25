import { describe, expect, it, vi } from "vitest";
import { insertTextAtCursor } from "@/lib/textarea";

describe("insertTextAtCursor", () => {
  it("calls setValue with the value when the element is null", () => {
    const setValue = vi.fn();
    insertTextAtCursor(null, "hello", setValue);
    expect(setValue).toHaveBeenCalledWith("hello");
  });

  it("inserts text at the mid-cursor position", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "abXYef";
    textarea.selectionStart = 2;
    textarea.selectionEnd = 4;
    const setValue = vi.fn();

    insertTextAtCursor(textarea, "CD", setValue);

    expect(setValue).toHaveBeenCalledWith("abCDef");
  });

  it("inserts text at the start position", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "tail";
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    const setValue = vi.fn();

    insertTextAtCursor(textarea, "head-", setValue);

    expect(setValue).toHaveBeenCalledWith("head-tail");
  });
});
