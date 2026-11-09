import { test, expect, makeSessionWithPR, mockSessions, mockPrStatusBatch } from "./fixtures.js";
import type { PrInfo } from "../src/lib/pr-status-shape.js";

const cases: Array<{ name: string; info: PrInfo }> = [
  {
    name: "approved",
    info: {
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      canMerge: true,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: ["alice", "bob"], changesRequested: [] },
    },
  },
  {
    name: "mixed",
    info: {
      state: "open",
      reviewDecision: "changes_requested",
      ciStatus: "success",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: ["alice"], changesRequested: ["carol"] },
    },
  },
  {
    name: "required",
    info: {
      state: "open",
      reviewDecision: "review_required",
      ciStatus: "success",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: ["alice"], changesRequested: [] },
    },
  },
  {
    name: "failed",
    info: {
      state: "open",
      reviewDecision: "approved",
      ciStatus: "failure",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: ["alice"], changesRequested: [] },
    },
  },
  {
    name: "empty",
    info: {
      state: "open",
      reviewDecision: null,
      ciStatus: "pending",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: [], changesRequested: [] },
    },
  },
  {
    name: "unknown",
    info: {
      state: "open",
      reviewDecision: null,
      ciStatus: "success",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: null,
    },
  },
];

for (const { name, info } of cases) {
  test(`reviewer metadata in dashboard and session header: ${name}`, async ({ page }) => {
    const prUrl = "https://github.com/test/repo/pull/42";
    const session = makeSessionWithPR({ id: `reviewers-${name}` });
    await mockSessions(page, [session]);
    await mockPrStatusBatch(page, { [prUrl]: { ...info } });
    await page.route(/\/api\/pr-status\?/, (route) => route.fulfill({ json: info }));
    await page.route(`**/api/sessions/${session.id}`, (route) => route.fulfill({ json: session }));

    for (const path of ["/", `/sessions/${session.id}`]) {
      await page.goto(path);
      const badge = page.locator(`a[href='${prUrl}']`).first();
      await expect(badge).toBeVisible();
      for (const [key, label] of [
        ["approved", "Approved"],
        ["changesRequested", "Changes requested"],
      ] as const) {
        const logins = info.reviewers?.[key] ?? [];
        const group = badge.locator(`[title^='${label} ·']`);
        if (logins.length === 0) {
          await expect(group).toHaveCount(0);
        } else {
          await expect(group).toHaveText(String(logins.length));
          await group.hover();
          await expect(group).toHaveAttribute(
            "title",
            `${label} · ${logins.length}\n${logins.map((login) => `@${login}`).join("\n")}`,
          );
        }
      }
      if (name === "approved") {
        await expect(badge.locator("[data-pr-review-decision='approved']")).toBeVisible();
        await expect(badge.locator("[data-pr-review-decision='approved'] path")).toHaveCount(4);
      }
      if (name === "mixed")
        await expect(badge.getByLabel("Changes requested", { exact: true })).toBeVisible();
      if (name === "failed") await expect(badge.getByLabel("CI failing")).toBeVisible();
      if (name === "empty") await expect(badge.getByLabel("CI pending")).toBeVisible();
      if (name === "required") {
        await expect(badge.getByLabel("CI passing")).toBeVisible();
        const status = badge.locator("[title*='GitHub requires review']");
        await status.hover();
        await expect(status).toHaveAttribute(
          "title",
          "CI passing\nGitHub requires review\nRemaining required approvals: unknown",
        );
      }
    }
  });
}
