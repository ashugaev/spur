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
      reviewRequirement: "required",
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
      reviewers: { approved: ["alice", "bob"], changesRequested: ["carol"] },
      reviewRequirement: "required",
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
      reviewRequirement: "required",
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
      reviewers: { approved: ["alice"], changesRequested: ["carol"] },
      reviewRequirement: "none",
    },
  },
  {
    name: "empty",
    info: {
      state: "open",
      reviewDecision: "review_required",
      ciStatus: "pending",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: [], changesRequested: [] },
      reviewRequirement: "required",
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
      reviewRequirement: "required",
    },
  },
  {
    name: "policy unavailable",
    info: {
      state: "open",
      reviewDecision: "changes_requested",
      ciStatus: "success",
      canMerge: false,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers: { approved: ["alice"], changesRequested: ["carol"] },
      reviewRequirement: "unavailable",
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
      const person = badge.locator("[data-pr-reviewers]");
      if (info.reviewRequirement !== "required") {
        await expect(person).toHaveCount(0);
      } else {
        await expect(person).toHaveCount(1);
        await expect(person).toHaveText(
          info.reviewers ? String(info.reviewers.approved.length) : "",
        );
        await person.hover();
        if (info.reviewers) {
          for (const login of [...info.reviewers.approved, ...info.reviewers.changesRequested]) {
            await expect(person).toHaveAttribute("title", new RegExp(`@${login}`));
          }
        } else {
          await expect(person).toHaveAttribute("title", /Review history unavailable/);
        }
        const color =
          info.reviewDecision === "changes_requested" ||
          (info.reviewers?.changesRequested.length ?? 0) > 0
            ? "error"
            : info.reviewDecision === "approved"
              ? "ready"
              : "attention";
        await expect(person).toHaveAttribute("class", new RegExp(`--color-status-${color}`));
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
        await expect(status).toHaveAttribute("title", "CI passing\nGitHub requires review");
      }
    }
  });
}
