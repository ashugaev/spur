import { describe, expect, it } from "vitest";
import { initialReasoningIntent, serializeReasoningIntent } from "@/lib/reasoning-effort";

describe("reasoning submission intent", () => {
  it("keeps fresh defaults and untouched lifecycle carry absent", () => {
    expect(serializeReasoningIntent(initialReasoningIntent(false, "high"))).toBeUndefined();
    expect(serializeReasoningIntent(initialReasoningIntent(true, "high"))).toBeUndefined();
  });
  it("distinguishes a chosen level from deliberate lifecycle reset", () => {
    expect(serializeReasoningIntent({ kind: "explicit", level: "low" })).toBe("low");
    expect(serializeReasoningIntent({ kind: "clear" })).toBeNull();
  });
});
