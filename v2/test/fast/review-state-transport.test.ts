import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseConfig, parseRequest, prepareReview, publishReview } from "../../src/review-app.js";
import { stateBody } from "../../src/review-state.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(mode: "clean" | "denied" | "lost" | "final-failure") {
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
    rows: [{ status: "passed", evidence: "fixture" }],
    coverage: { challenger: "critic", output: "coverage", omissionsClosed: true },
    assessment: {
      status: "N/A",
      manifest: { version: 1, repository: "owner/repo", baseBranch: "main", surfaces: [] },
      dispositions: [],
    },
  });
  const comments: { id: number; body: string; user: { login: string } }[] = [];
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
        (mode === "final-failure" && payload.body.includes('"status":"APPROVED"'))
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
      nativePosts++;
      const payload = JSON.parse(String(options.body)) as { body: string; commit_id: string };
      review = {
        id: 20,
        body: payload.body,
        state: "APPROVED",
        commit_id: payload.commit_id,
        submitted_at: "2026-10-05T12:00:00Z",
        user: { login: "code[bot]" },
      };
      return Response.json(review);
    }
    if (path.endsWith("/reviews/20")) return Response.json(review);
    throw new Error("unexpected fixture API");
  };
  return {
    config,
    request,
    transport,
    comments,
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
