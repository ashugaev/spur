import { describe, expect, it } from "vitest";
import { mapVoiceRect, supportedVoiceStyle } from "@/lib/snippets/snippet-voice-layout";

describe("trusted voice placement", () => {
  const viewport = { width: 400, height: 300 };
  const rail = { x: 350, y: 150, width: 32, height: 108 };
  it("maps frame content coordinates through borders and axis-aligned scale", () => {
    const content = { x: 12, y: 22, width: 320, height: 240 };
    expect(mapVoiceRect(rail, viewport, content, [])).toEqual({
      x: 292,
      y: 142,
      width: 25.6,
      height: 86.4,
    });
  });
  it("hides partial rails at visual viewport and ancestor clips", () => {
    const content = { x: 0, y: 0, width: 400, height: 300 };
    expect(mapVoiceRect(rail, viewport, content, [{ ...content, height: 250 }])).toBeNull();
    expect(mapVoiceRect(rail, viewport, { ...content, width: 0 }, [])).toBeNull();
  });
  it("rejects rotation, skew, perspective, masks and hidden ancestors", () => {
    for (const style of [
      { transform: "matrix(1, 0.1, 0, 1, 0, 0)" },
      { transform: "matrix(-1, 0, 0, 1, 0, 0)" },
      { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)" },
      { perspective: "100px" },
      { clipPath: "circle(50%)" },
      { maskImage: "url(mask.svg)" },
      { visibility: "hidden" },
    ])
      expect(supportedVoiceStyle(style as CSSStyleDeclaration)).toBe(false);
    expect(
      supportedVoiceStyle({ transform: "matrix(0.8, 0, 0, 0.8, 10, 20)" } as CSSStyleDeclaration),
    ).toBe(true);
  });
});
