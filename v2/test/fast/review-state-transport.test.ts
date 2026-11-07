import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readJson } from "../../src/github-app.js";
import {
  blockReview,
  parseConfig,
  parseRequest,
  prepareReview,
  publishReview,
} from "../../src/review-app.js";
import { stateBody, readStateBody } from "../../src/review-state.js";
import { plan, capability, defect } from "./review-feedback.fixture.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(mode: "clean" | "denied" | "lost" | "final-failure" | "all-final-denied") {
  const root = await mkdtemp(join(tmpdir(), "spur-state-transport-"));
  dirs.push(root);
  const keyPath = join(root, "fixture.pem");
  await writeFile(
    keyPath,
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
    { mode: 0o600 },
  );
  const config = parseConfig({
    repositories: ["owner/repo"],
    receiptRoot: root,
    code: { appId: 1, keyPath },
    browser: { appId: 2, keyPath },
  });
  const request = parseRequest({
    repo: "owner/repo",
    pr: 1,
    lane: "code",
    session: "review-code",
    attempt: "attempt",
    H: "a".repeat(40),
    B: "b".repeat(40),
    contractDigest: "c".repeat(64),
    receipt: join(root, "owner", "repo", "1", "code.json"),
    body: "Code Review Conclusion",
    verdict: "APPROVED",
    feedback: plan,
    rows: [{ status: "passed", evidence: "fixture" }],
    coverage: { challenger: "critic", output: "coverage", omissionsClosed: true },
    assessment: {
      status: "N/A",
      manifest: { version: 1, repository: "owner/repo", baseBranch: "main", surfaces: [] },
      dispositions: [],
    },
  });
  const comments: { id: number; body: string; user: { login: string } }[] = [];
  const snapshots = { beforeNative: "", afterNative: "" };
  let offlineObserved = false,
    nativePosts = 0;
  let review:
    | {
        id: number;
        body: string;
        state: string;
        commit_id: string;
        submitted_at: string;
        user: { login: string };
      }
    | undefined;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/app") {
      const receipt = JSON.parse(await readFile(request.receipt, "utf8")) as { status: string };
      offlineObserved ||= receipt.status === "PENDING";
      return Response.json({ id: 1, slug: "code" });
    }
    if (path.endsWith("/installation")) return Response.json({ id: 10, app_id: 1 });
    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "fixture",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { pull_requests: "write", metadata: "read" },
      });
    if (path === "/repos/owner/repo") return Response.json({ id: 1, full_name: "owner/repo" });
    if (path.endsWith("/pulls/1"))
      return Response.json({
        state: "open",
        head: { sha: request.H },
        base: { sha: request.B },
        user: { login: "author" },
      });
    if (path.endsWith("/issues/1/comments")) {
      if (options?.method !== "POST") return Response.json(comments);
      const payload = JSON.parse(String(options.body)) as { body: string };
      if (
        mode === "denied" ||
        (mode === "final-failure" &&
          /"status":"(?:APPROVED|CHANGES_REQUESTED)"/.test(payload.body)) ||
        (mode === "all-final-denied" && nativePosts > 0)
      )
        return new Response("denied", { status: 403 });
      const row = { id: comments.length + 1, body: payload.body, user: { login: "code[bot]" } };
      comments.push(row);
      if (mode === "lost") throw new Error("lost state reply");
      return Response.json(row);
    }
    if (path.includes("/issues/comments/"))
      return Response.json(comments.find((row) => String(row.id) === path.split("/").at(-1)));
    if (path.endsWith("/reviews")) {
      if (options?.method !== "POST") return Response.json(review ? [review] : []);
      snapshots.beforeNative = await readFile(request.receipt, "utf8");
      nativePosts++;
      const payload = JSON.parse(String(options.body)) as {
        body: string;
        commit_id: string;
        event: string;
      };
      review = {
        id: 20,
        body: payload.body,
        state: payload.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
        commit_id: payload.commit_id,
        submitted_at: "2026-10-05T12:00:00Z",
        user: { login: "code[bot]" },
      };
      return Response.json(review);
    }
    if (path.endsWith("/reviews/20")) {
      snapshots.afterNative = await readFile(request.receipt, "utf8");
      return Response.json(review);
    }
    throw new Error("unexpected fixture API");
  };
  return {
    config,
    request,
    transport,
    comments,
    snapshots,
    offlineObserved: () => offlineObserved,
    nativePosts: () => nativePosts,
  };
}
test("offline PENDING precedes auth; confirmed public PENDING permits native publication", async () => {
  const f = await fixture("clean");
  expect((await prepareReview(f.config, f.request, f.request.session, f.transport)).status).toBe(
    "PENDING",
  );
  expect(f.offlineObserved()).toBe(true);
  expect(f.comments[0]?.body).toContain('"status":"PENDING"');
  expect(f.comments[0]?.body).toMatch(/^Code review: pending — Reason:/);
  expect(readStateBody(f.comments[0]?.body ?? "").status).toBe("PENDING");
  expect((await publishReview(f.config, f.request, f.request.session, f.transport)).status).toBe(
    "APPROVED",
  );
  expect(f.comments.at(-1)?.body).toContain('"status":"APPROVED"');
  expect(f.nativePosts()).toBe(1);
});
test.each(["denied", "lost"] as const)(
  "unconfirmed %s state blocks QA and never publishes native approve",
  async (mode) => {
    const f = await fixture(mode);
    expect((await prepareReview(f.config, f.request, f.request.session, f.transport)).status).toBe(
      "BLOCKED",
    );
    expect(f.nativePosts()).toBe(0);
    expect(f.offlineObserved()).toBe(true);
    await expect(
      publishReview(f.config, f.request, f.request.session, f.transport),
    ).rejects.toThrow("attempt-blocked");
  },
);
test("failure to publish final state retains confirmed blocking public state", async () => {
  const f = await fixture("final-failure");
  await prepareReview(f.config, f.request, f.request.session, f.transport);
  expect((await publishReview(f.config, f.request, f.request.session, f.transport)).status).toBe(
    "BLOCKED",
  );
  expect(f.nativePosts()).toBe(1);
  expect(f.comments.at(-1)?.body).toContain('"status":"BLOCKED"');
});
test("plan-only prepare and unchanged wakes publish no duplicate status or native review", async () => {
  const f = await fixture("clean");
  const {
    body: _body,
    rows: _rows,
    verdict: _verdict,
    assessment: _assessment,
    coverage: _coverage,
    ...attempt
  } = f.request;
  await prepareReview(f.config, attempt, attempt.session, f.transport);
  await prepareReview(f.config, attempt, attempt.session, f.transport);
  expect(f.comments).toHaveLength(1);
  await publishReview(f.config, f.request, f.request.session, f.transport);
  expect(f.comments).toHaveLength(2);
  const saved = await readFile(f.request.receipt, "utf8");
  await prepareReview(f.config, attempt, attempt.session, f.transport);
  await publishReview(f.config, f.request, f.request.session, f.transport);
  expect(f.comments).toHaveLength(2);
  expect(f.nativePosts()).toBe(1);
  expect(await readFile(f.request.receipt, "utf8")).toBe(saved);
});
test.each(["beforeNative", "afterNative"] as const)(
  "interrupted %s snapshot reconciles native review without another POST",
  async (stage) => {
    const f = await fixture("clean");
    await prepareReview(f.config, f.request, f.request.session, f.transport);
    await publishReview(f.config, f.request, f.request.session, f.transport);
    const snapshot = f.snapshots[stage];
    await writeFile(f.request.receipt, snapshot);
    f.comments.splice(1);
    const receipt = await readJson(f.request.receipt);
    expect(receipt).toMatchObject({
      status: "PENDING",
      feedback: { kind: "plan" },
      preparedFeedback: plan,
      localVerdict: "APPROVED",
      evidence: f.request.rows,
      mutationStarted: true,
      reviewId: stage === "beforeNative" ? null : 20,
    });
    expect(await publishReview(f.config, f.request, f.request.session, f.transport)).toMatchObject({
      status: "APPROVED",
      feedbackPublication: { status: "confirmed" },
      reviewId: 20,
    });
    expect(f.nativePosts()).toBe(1);
    expect(f.comments).toHaveLength(2);
  },
);
test("uncertain environment BLOCKED publishes observed and unproven facts once", async () => {
  const f = await fixture("clean");
  await prepareReview(f.config, f.request, f.request.session, f.transport);
  const blocked = { ...f.request, feedback: capability };
  const result = await blockReview(f.config, blocked, f.request.session, f.transport);
  expect(result).toMatchObject({ status: "BLOCKED", feedbackPublication: { status: "confirmed" } });
  const visible = f.comments.at(-1)?.body.split("\n\n<!--")[0] ?? "";
  expect(visible).toContain(capability.observed);
  expect(visible).toContain("unproven");
  await blockReview(f.config, blocked, f.request.session, f.transport);
  expect(f.comments).toHaveLength(2);
  expect(f.nativePosts()).toBe(0);
});
test.each(["clean", "all-final-denied"] as const)(
  "confirmed defect %s retains verdict and public feedback outcome",
  async (mode) => {
    const f = await fixture(mode);
    await prepareReview(f.config, f.request, f.request.session, f.transport);
    const request = parseRequest({
      ...f.request,
      verdict: "CHANGES_REQUESTED",
      feedback: defect,
      rows: [{ status: "failed", evidence: "attributable named assertion" }],
    });
    const result = await publishReview(f.config, request, request.session, f.transport);
    assert.ok("inputDigest" in result);
    expect(result).toMatchObject({
      status: mode === "clean" ? "CHANGES_REQUESTED" : "BLOCKED",
      localVerdict: "CHANGES_REQUESTED",
      reviewId: 20,
      evidence: request.rows,
      feedbackPublication:
        mode === "clean" ? { status: "confirmed" } : { status: "failed", error: "http-403" },
    });
    if (mode === "clean") {
      const visible = f.comments.at(-1)?.body.split("\n\n<!--")[0] ?? "";
      expect(visible).toContain(defect.evidence);
      expect(visible).toContain(defect.action);
      expect(visible).toContain(defect.actor);
    }
    await publishReview(f.config, request, request.session, f.transport);
    expect(f.nativePosts()).toBe(1);
    const blocked = await blockReview(
      f.config,
      { ...request, feedback: capability },
      request.session,
      f.transport,
    );
    expect(blocked).toMatchObject({
      localVerdict: "CHANGES_REQUESTED",
      localFeedback: defect,
      evidence: request.rows,
      reviewId: 20,
      inputDigest: result.inputDigest,
    });
  },
);
test("denied-before-commit prepare cannot remotely revoke an existing same-head approval", async () => {
  const f = await fixture("denied");
  const body = stateBody({
    version: 1,
    repo: f.request.repo,
    pr: f.request.pr,
    lane: f.request.lane,
    session: f.request.session,
    attempt: "previous",
    H: f.request.H,
    B: f.request.B,
    status: "APPROVED",
    evidenceDigest: "d".repeat(64),
    reviewId: 20,
    assessment: f.request.assessment,
  });
  f.comments.push({ id: 50, body, user: { login: "code[bot]" } });
  expect((await prepareReview(f.config, f.request, f.request.session, f.transport)).status).toBe(
    "BLOCKED",
  );
  expect(f.comments).toEqual([{ id: 50, body, user: { login: "code[bot]" } }]);
  expect(f.nativePosts()).toBe(0);
});
