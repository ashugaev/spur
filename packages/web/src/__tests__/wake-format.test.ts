import { describe, expect, it } from "vitest";
import { getWakeSummaries, getWakeSummary } from "@/lib/wake-format";

describe("wake-format", () => {
  it("returns every configured wake in interval, daily, scheduled order", () => {
    const session = {
      scheduledWake: { dueAt: "2026-04-15T12:00:00.000Z", message: "One shot" },
      intervalWake: {
        nextDueAt: "2026-04-15T10:00:00.000Z",
        intervalMs: 300_000,
        message: "Interval msg",
        stopCondition: "CI green",
      },
      dailyWake: {
        dailyAt: ["09:00"],
        nextDueAt: "2026-04-15T09:00:00.000Z",
        message: "Daily msg",
        stopCondition: "Daily done",
      },
    };

    const summaries = getWakeSummaries(session);
    expect(summaries.map((summary) => summary.target)).toEqual(["interval", "daily", "scheduled"]);
    expect(getWakeSummary(session)?.target).toBe("interval");
  });
});
