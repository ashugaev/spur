import { describe, expect, it } from "vitest";
import type { WorkItemMember } from "../../src/types.js";
import {
  buildWorkItemRecord,
  compareWorkItemRetryOrder,
  isWorkItemMemberDue,
  isWorkItemRecordDue,
  isWorkItemRecordEmitDue,
  WORK_ITEM_RETRY_INTERVAL_MS,
} from "../../src/work-item-retry.js";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function member(overrides: Partial<WorkItemMember>): WorkItemMember {
  return {
    triggerId: "review",
    blockIndex: 0,
    state: "failed",
    claimedAt: iso(-3 * WORK_ITEM_RETRY_INTERVAL_MS),
    attempts: 1,
    deferrals: 0,
    ...overrides,
  };
}

const itemBase = {
  externalId: "acme/api#7",
  url: "https://github.com/acme/api/pull/7",
  number: 7,
  title: "Review me",
  repo: "acme/api",
  autoComplete: true,
  createdAt: iso(-1000),
};

describe("isWorkItemMemberDue", () => {
  it("is due once a failed member reaches nextRetryAt", () => {
    expect(isWorkItemMemberDue(member({ nextRetryAt: iso(1) }), NOW)).toBe(false);
    expect(isWorkItemMemberDue(member({ nextRetryAt: iso(0) }), NOW)).toBe(true);
  });

  it("treats a failed member without nextRetryAt as due", () => {
    expect(isWorkItemMemberDue(member({}), NOW)).toBe(true);
  });

  it("has no attempt or deferral cap", () => {
    expect(isWorkItemMemberDue(member({ attempts: 1000, deferrals: 1000 }), NOW)).toBe(true);
    expect(
      isWorkItemMemberDue(member({ state: "spawning", attempts: 1000, claimedAt: iso(-1e9) }), NOW),
    ).toBe(true);
  });

  it("is never due once ended", () => {
    expect(isWorkItemMemberDue(member({ endedReason: "anchor_not_live" }), NOW)).toBe(false);
  });

  it("is due for a stale spawning claim only", () => {
    const spawning = (age: number) =>
      member({ state: "spawning", claimedAt: iso(-age), attempts: 1 });
    expect(isWorkItemMemberDue(spawning(WORK_ITEM_RETRY_INTERVAL_MS - 1), NOW)).toBe(false);
    expect(isWorkItemMemberDue(spawning(WORK_ITEM_RETRY_INTERVAL_MS), NOW)).toBe(true);
  });

  it("is never due once running or completed", () => {
    expect(isWorkItemMemberDue(member({ state: "running", sessionId: "api-1" }), NOW)).toBe(false);
    expect(isWorkItemMemberDue(member({ state: "completed", sessionId: "api-1" }), NOW)).toBe(
      false,
    );
  });
});

describe("record due and emit order", () => {
  it("is due when any member is due", () => {
    const record = {
      members: [member({ state: "running", sessionId: "api-1" }), member({ blockIndex: 1 })],
    };
    expect(isWorkItemRecordDue(record, NOW)).toBe(true);
  });

  it("gates the emit on lastRetryEmitAt", () => {
    const members = [member({})];
    expect(isWorkItemRecordEmitDue({ members }, NOW)).toBe(true);
    expect(
      isWorkItemRecordEmitDue(
        { members, lastRetryEmitAt: iso(-WORK_ITEM_RETRY_INTERVAL_MS + 1) },
        NOW,
      ),
    ).toBe(false);
    expect(
      isWorkItemRecordEmitDue({ members, lastRetryEmitAt: iso(-WORK_ITEM_RETRY_INTERVAL_MS) }, NOW),
    ).toBe(true);
  });

  it("orders never-emitted first, then least recently emitted, then oldest due", () => {
    const old = { members: [member({ nextRetryAt: iso(-5000) })] };
    const recent = { members: [member({ nextRetryAt: iso(-1000) })] };
    const emitted = { members: [member({})], lastRetryEmitAt: iso(-100) };
    const emittedEarlier = { members: [member({})], lastRetryEmitAt: iso(-200) };
    const sorted = [emitted, recent, emittedEarlier, old].sort(compareWorkItemRetryOrder);
    expect(sorted).toEqual([old, recent, emittedEarlier, emitted]);
  });
});

describe("buildWorkItemRecord", () => {
  const nowIso = iso(0);

  it("derives running with the lowest running block as anchor", () => {
    const record = buildWorkItemRecord(
      itemBase,
      [
        member({ blockIndex: 2, state: "running", sessionId: "api-3" }),
        member({ blockIndex: 1, state: "running", sessionId: "api-2" }),
        member({ blockIndex: 0, state: "failed" }),
      ],
      nowIso,
    );
    expect(record).toMatchObject({ state: "running", sessionId: "api-2" });
  });

  it("derives pending while any member is spawning and none runs", () => {
    const record = buildWorkItemRecord(
      itemBase,
      [member({ state: "spawning" }), member({ blockIndex: 1, state: "failed" })],
      nowIso,
    );
    expect(record.state).toBe("pending");
  });

  it("derives completed only when every member completed", () => {
    const completed = member({ state: "completed", sessionId: "api-1" });
    expect(buildWorkItemRecord(itemBase, [completed], nowIso)).toMatchObject({
      state: "completed",
      sessionId: "api-1",
      completedAt: nowIso,
    });
    expect(
      buildWorkItemRecord(itemBase, [completed, member({ blockIndex: 1 })], nowIso).state,
    ).toBe("failed");
  });

  it("derives failed with the member error", () => {
    expect(buildWorkItemRecord(itemBase, [member({ error: "boom" })], nowIso)).toMatchObject({
      state: "failed",
      error: "boom",
    });
  });
});
