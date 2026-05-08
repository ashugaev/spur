import { describe, expect, it } from "vitest";
import { IDLE_WAIT_BEFORE_FLUSH_MS, isIdleEnoughToReceive } from "../../src/session-service.js";

describe("isIdleEnoughToReceive", () => {
  const now = Date.parse("2026-05-08T12:00:00.000Z");

  it("treats null lastActivityAt as idle", () => {
    expect(isIdleEnoughToReceive(null, IDLE_WAIT_BEFORE_FLUSH_MS, now)).toBe(true);
  });

  it("treats an unparseable string as idle", () => {
    expect(isIdleEnoughToReceive("not-a-date", IDLE_WAIT_BEFORE_FLUSH_MS, now)).toBe(true);
  });

  it("returns true when the Date is older than the threshold", () => {
    const past = new Date(now - 31_000);
    expect(isIdleEnoughToReceive(past, IDLE_WAIT_BEFORE_FLUSH_MS, now)).toBe(true);
  });

  it("returns false when the Date is newer than the threshold", () => {
    const recent = new Date(now - 10_000);
    expect(isIdleEnoughToReceive(recent, IDLE_WAIT_BEFORE_FLUSH_MS, now)).toBe(false);
  });

  it("returns true when an ISO string is older than the threshold", () => {
    const isoPast = new Date(now - 31_000).toISOString();
    expect(isIdleEnoughToReceive(isoPast, IDLE_WAIT_BEFORE_FLUSH_MS, now)).toBe(true);
  });
});
