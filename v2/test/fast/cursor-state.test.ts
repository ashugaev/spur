import { describe, expect, it } from "vitest";
import { cursorShowsReadyPrompt, cursorShowsWorkspaceTrustPrompt } from "../../src/cursor-state.js";
import { CURSOR_RESUME_READY_MARKER } from "../../src/agents/cursor.js";

const READY = "Cursor Agent";
const RESUME_READY = CURSOR_RESUME_READY_MARKER;
const NEEDS_INPUT = "Press any key to log in";
const TRUST = "Workspace Trust Required";

describe("cursorShowsReadyPrompt", () => {
  it("returns true when only a ready marker is present", () => {
    expect(cursorShowsReadyPrompt(`prefix\n${READY}\nsuffix`)).toBe(true);
  });

  it("returns true when only a resume ready marker is present", () => {
    expect(cursorShowsReadyPrompt(`previous output\n${RESUME_READY}\n`)).toBe(true);
  });

  it("returns false when a needs-input marker follows the ready marker", () => {
    expect(cursorShowsReadyPrompt(`${READY}\n${NEEDS_INPUT}\n`)).toBe(false);
  });

  it("returns false when a needs-input marker follows the resume ready marker", () => {
    expect(cursorShowsReadyPrompt(`${RESUME_READY}\n${NEEDS_INPUT}\n`)).toBe(false);
  });

  it("returns true when a later ready marker follows a needs-input marker", () => {
    expect(cursorShowsReadyPrompt(`${NEEDS_INPUT}\n${READY}\n`)).toBe(true);
  });

  it("returns true when a later resume ready marker follows a needs-input marker", () => {
    expect(cursorShowsReadyPrompt(`${NEEDS_INPUT}\n${RESUME_READY}\n`)).toBe(true);
  });

  it("returns false when the pane has no markers", () => {
    expect(cursorShowsReadyPrompt("no markers here")).toBe(false);
  });
});

describe("cursorShowsWorkspaceTrustPrompt", () => {
  it("returns true when only a workspace trust marker is present", () => {
    expect(cursorShowsWorkspaceTrustPrompt(`${TRUST}\n`)).toBe(true);
  });

  it("returns false when a later ready marker hides the trust marker", () => {
    expect(cursorShowsWorkspaceTrustPrompt(`${TRUST}\n${READY}\n`)).toBe(false);
  });

  it("returns true when a trust marker follows the ready marker", () => {
    expect(cursorShowsWorkspaceTrustPrompt(`${READY}\n${TRUST}\n`)).toBe(true);
  });

  it("returns false when the pane has no markers", () => {
    expect(cursorShowsWorkspaceTrustPrompt("no markers here")).toBe(false);
  });
});
