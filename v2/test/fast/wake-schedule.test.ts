import { describe, expect, it } from "vitest";
import { normalizeDailyWakeTimes, resolveNextDailyWakeAt } from "../../src/wake-schedule.js";

describe("wake-schedule", () => {
  it("normalizes daily wake times by trimming and sorting", () => {
    expect(normalizeDailyWakeTimes(["14:30", " 09:15 "])).toEqual(["09:15", "14:30"]);
  });

  it("rejects duplicate daily wake times", () => {
    expect(() => normalizeDailyWakeTimes(["09:15", "09:15"])).toThrow(
      "duplicate daily wake time: 09:15",
    );
  });

  it("rejects invalid daily wake times", () => {
    for (const value of ["9:15", "24:00", "12:60", "12:00:00", ""]) {
      expect(() => normalizeDailyWakeTimes([value])).toThrow(
        "dailyAt entries must use HH:MM from 00:00 through 23:59",
      );
    }
  });

  it("chooses the next same-day daily wake time", () => {
    const nextDueAt = resolveNextDailyWakeAt(
      ["17:45", "09:30"],
      new Date(2026, 2, 18, 9, 15, 0, 0),
    );

    expect(nextDueAt).toEqual(new Date(2026, 2, 18, 9, 30, 0, 0));
  });

  it("rolls daily wake time to the next day when no configured time remains", () => {
    const nextDueAt = resolveNextDailyWakeAt(
      ["09:30", "17:45"],
      new Date(2026, 2, 18, 17, 45, 0, 0),
    );

    expect(nextDueAt).toEqual(new Date(2026, 2, 19, 9, 30, 0, 0));
  });

  it("uses daemon-local wall clock timezone", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const nextDueAt = resolveNextDailyWakeAt(["09:30"], new Date(2026, 2, 18, 9, 15, 0, 0));

      expect(nextDueAt.getHours()).toBe(9);
      expect(nextDueAt.getMinutes()).toBe(30);
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });
});
