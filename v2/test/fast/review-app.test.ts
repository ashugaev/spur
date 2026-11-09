import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  symlink,
  link,
  stat,
} from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import type * as ReviewState from "../../src/review-state.js";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, expect, test, vi } from "vitest";
import {
  parseConfig,
  parseAttempt,
  parseRequest,
  prepareReview,
  blockReview,
  publishReview,
  recoverReview,
  registerReviewApp,
} from "../../src/review-app.js";
import { publishLaneState, stateBody } from "../../src/review-state.js";
import { execFileAsync } from "../helpers/common.js";
import { object, readJson } from "../../src/github-app.js";
import { plan, capability, defect } from "./review-feedback.fixture.js";

const dirs: string[] = [];
const faults = vi.hoisted(() => ({
  approvedWrite: false,
  recovery: "",
  writes: 0,
  afterWrite: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock("../../src/review-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewState>()),
  publishLaneState: vi.fn(async () => undefined),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      faults.writes++;
      if (
        (faults.recovery === "archive-write" && String(args[0]).endsWith("legacy.json")) ||
        (faults.recovery === "canonical-write" && String(args[0]).endsWith("receipt.json"))
      ) {
        faults.recovery = "";
        throw new Error("fixture recovery write denied");
      }
      if (
        faults.approvedWrite &&
        (typeof args[1] === "string" || Buffer.isBuffer(args[1])) &&
        args[1].toString().includes('"status": "APPROVED"')
      )
        throw new Error("fixture final save denied");
      await actual.writeFile(...args);
      await faults.afterWrite?.(String(args[0]));
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.recovery === "archive-link") {
        faults.recovery = "";
        throw new Error("fixture archive link denied");
      }
      return actual.link(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (faults.recovery === "profile-canonical-sync" && String(args[0]).endsWith("/73"))
        faults.recovery = "profile-sync";
      else if (faults.recovery === "profile-sync" && String(args[0]).endsWith("/73")) {
        faults.recovery = "";
        vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("fixture directory sync denied"));
      }
      if (faults.recovery === "canonical-sync" && String(args[0]).endsWith("/4")) {
        faults.recovery = "canonical-sync-ready";
      } else if (
        ["directory-sync", "canonical-sync-ready"].includes(faults.recovery) &&
        String(args[0]).endsWith("/4")
      ) {
        faults.recovery = "";
        vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("fixture directory sync denied"));
      }
      return file;
    },
  };
});
afterEach(async () => {
  faults.approvedWrite = false;
  faults.recovery = "";
  faults.writes = 0;
  faults.afterWrite = undefined;
  vi.unstubAllGlobals();
  vi.mocked(publishLaneState).mockReset().mockResolvedValue(undefined);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const draft = {
  repo: "owner/repo",
  pr: 4,
  lane: "code",
  session: "review-1",
  attempt: "attempt-1",
  H: "a".repeat(40),
  B: "b".repeat(40),
  contractDigest: "c".repeat(64),
  body: "Code Review Conclusion",
  verdict: "APPROVED",
  feedback: plan,
  coverage: { challenger: "critic-1", output: "matrix.txt", omissionsClosed: true },
  rows: [{ status: "passed", evidence: "proof.png" }],
  assessment: {
    status: "N/A",
    manifest: { version: 1, repository: "owner/repo", baseBranch: "main", surfaces: [] },
    dispositions: [],
  },
};
test("accepts optional legacy coverage and blocks malformed coverage or failed rows", () => {
  const { coverage, ...withoutCoverage } = draft;
  expect(parseRequest({ ...withoutCoverage, receipt: "r" }).coverage).toBeNull();
  expect(parseRequest({ ...draft, receipt: "r", coverage: null }).coverage).toBeNull();
  expect(parseRequest({ ...draft, receipt: "r" }).coverage).toEqual(coverage);
  for (const invalid of [false, [], {}, { ...coverage, output: "" }]) {
    expect(() => parseRequest({ ...draft, receipt: "r", coverage: invalid })).toThrow();
  }
  expect(() =>
    parseRequest({
      ...draft,
      receipt: "r",
      coverage: { ...draft.coverage, challenger: draft.session },
    }),
  ).toThrow("coverage-incomplete");
  expect(() =>
    parseRequest({ ...draft, receipt: "r", rows: [{ status: "failed", evidence: "proof" }] }),
  ).toThrow("failed-scenarios");
  expect(() =>
    parseConfig({
      repositories: ["owner/repo"],
      receiptRoot: "/receipts",
      code: { appId: 1, keyPath: "k" },
      browser: { appId: 1, keyPath: "k" },
    }),
  ).toThrow("duplicate-apps");
});
test("final defects require attributable feedback and failed evidence", () => {
  expect(() => parseRequest({ ...draft, receipt: "r", verdict: "CHANGES_REQUESTED" })).toThrow(
    "invalid-review-feedback",
  );
  expect(() =>
    parseRequest({ ...draft, receipt: "r", verdict: "CHANGES_REQUESTED", feedback: defect }),
  ).toThrow("missing-failed-evidence");
});
test("exported action helpers reject bare or misclassified input before network", async () => {
  const network = vi.fn<typeof fetch>();
  const config = parseConfig({
    repositories: ["owner/repo"],
    receiptRoot: "/unused",
    code: { appId: 1, keyPath: "unused" },
    browser: { appId: 2, keyPath: "unused" },
  });
  const { feedback: _feedback, ...bare } = parseRequest({ ...draft, receipt: "unused" });
  await expect(prepareReview(config, bare, draft.session, network)).rejects.toThrow();
  await expect(
    blockReview(config, { ...bare, feedback: defect }, draft.session, network),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  expect(publishLaneState).not.toHaveBeenCalled();
});
test("publishes and reconciles completed approval without a challenger", async () => {
  const f = await lifecycleFixture();
  const { coverage: _coverage, ...input } = f.request;
  const request = parseRequest(input);
  expect(await publishReview(f.config, request, draft.session, f.transport)).toMatchObject({
    status: "APPROVED",
    coverage: null,
  });
  const publishedState = vi.mocked(publishLaneState).mock.lastCall?.[1];
  expect(publishedState).toMatchObject({ status: "APPROVED" });
  expect(publishedState).not.toHaveProperty("feedback");
  expect(JSON.parse(await readFile(request.receipt, "utf8"))).toMatchObject({
    status: "APPROVED",
    coverage: null,
  });
  expect((await publishReview(f.config, request, draft.session, f.transport)).status).toBe(
    "APPROVED",
  );
  expect(f.posts()).toBe(1);
});
test.each(["legacy", "current"])(
  "%s prepared receipt announces only available feedback and omits it from approval",
  async (mode) => {
    const f = await lifecycleFixture();
    if (mode === "legacy") {
      const receipt = (await readJson(f.request.receipt)) as {
        feedback?: unknown;
        preparedFeedback?: unknown;
      };
      delete receipt.feedback;
      delete receipt.preparedFeedback;
      await writeFile(f.request.receipt, JSON.stringify(receipt));
    }
    vi.mocked(publishLaneState).mockClear();
    expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
      "APPROVED",
    );
    const announcements = vi.mocked(publishLaneState).mock.calls.map(([, state]) => state);
    expect(announcements.map((state) => state.status)).toEqual(["PENDING", "APPROVED"]);
    if (mode === "legacy") expect(announcements[0]).not.toHaveProperty("feedback");
    else expect(announcements[0]?.feedback).toEqual(plan);
    expect(announcements[1]).not.toHaveProperty("feedback");
    expect(f.posts()).toBe(1);
  },
);
test.each(["clean", "race", "denial", "ambiguous", "wrong-actor"])(
  "pinned publication %s",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "spur-publish-"));
    dirs.push(dir);
    const keyPath = join(dir, "key.pem");
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
      receiptRoot: dir,
      code: { appId: 1, keyPath },
      browser: { appId: 2, keyPath },
    });
    const request = parseRequest({
      ...draft,
      receipt: join(dir, "owner", "repo", "4", "code.json"),
    });
    await prepareReview(config, request, draft.session);
    let posted = 0,
      reads = 0;
    let review: unknown;
    const transport: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app") return Response.json({ id: 1, slug: "code" });
      if (path.endsWith("/installation")) return Response.json({ id: 2, app_id: 1 });
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "SECRET",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { pull_requests: "write", metadata: "read" },
        });
      if (path === "/repos/owner/repo") return Response.json({ id: 3, full_name: "owner/repo" });
      if (path.endsWith("/pulls/4")) {
        reads++;
        return Response.json({
          state: "open",
          head: { sha: mode === "race" && reads > 2 ? "d".repeat(40) : draft.H },
          base: { sha: draft.B },
          user: { login: "human" },
        });
      }
      if (options?.method === "POST") {
        posted++;
        if (mode === "denial") return new Response("SECRET", { status: 422 });
        const payload = JSON.parse(String(options.body)) as { body: string; commit_id: string };
        review = {
          id: 9,
          submitted_at: "2026-10-05T10:00:00Z",
          state: "APPROVED",
          body: payload.body,
          commit_id: payload.commit_id,
          user: { login: mode === "wrong-actor" ? "other[bot]" : "code[bot]" },
        };
        if (mode === "ambiguous") throw new Error("SECRET");
        return Response.json(review);
      }
      if (path.endsWith("/reviews/9")) return Response.json(review);
      return Response.json(review ? [review] : []);
    };
    const result = await publishReview(config, request, draft.session, transport);
    expect(result.status).toBe(["clean", "ambiguous"].includes(mode) ? "APPROVED" : "BLOCKED");
    expect(posted).toBe(1);
    expect(await readFile(request.receipt, "utf8")).not.toContain("SECRET");
    if (mode === "clean") {
      expect((await publishReview(config, request, draft.session, transport)).status).toBe(
        "APPROVED",
      );
      expect(posted).toBe(1);
    }
  },
);

async function lifecycleFixture(ci: "pending" | "failure" = "pending") {
  const dir = await mkdtemp(join(tmpdir(), "spur-lifecycle-"));
  dirs.push(dir);
  const keyPath = join(dir, "key.pem");
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
    receiptRoot: dir,
    code: { appId: 1, keyPath },
    browser: { appId: 2, keyPath },
  });
  const request = parseRequest({ ...draft, receipt: join(dir, "owner", "repo", "4", "code.json") });
  await prepareReview(config, request, draft.session);
  interface Review {
    id: number;
    submitted_at: string;
    state: string;
    body: string;
    commit_id: string;
    user: { login: string };
  }
  const history: Review[] = [];
  const endpoints: string[] = [];
  let deny = false,
    posts = 0;
  let pause: (() => Promise<void>) | undefined;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    endpoints.push(path);
    if (path === `/repos/owner/repo/commits/${draft.H}/status`) return Response.json({ state: ci });
    if (path === `/repos/owner/repo/commits/${draft.H}/check-runs`)
      return Response.json({
        check_runs: [
          {
            status: ci === "pending" ? "in_progress" : "completed",
            conclusion: ci === "failure" ? "failure" : null,
          },
        ],
      });
    if (path === "/app") {
      if (pause) await pause();
      return Response.json({ id: 1, slug: "code" });
    }
    if (path.endsWith("/installation")) return Response.json({ id: 2, app_id: 1 });
    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "SECRET",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { pull_requests: "write", metadata: "read" },
      });
    if (path === "/repos/owner/repo") return Response.json({ id: 3, full_name: "owner/repo" });
    if (path.endsWith("/pulls/4"))
      return Response.json({
        state: "open",
        head: { sha: draft.H },
        base: { sha: draft.B },
        user: { login: "human" },
      });
    if (path === "/repos/owner/repo/pulls/4/reviews" && options?.method === "POST") {
      posts++;
      if (deny) return new Response("denial", { status: 422 });
      const payload = JSON.parse(String(options.body)) as {
        body: string;
        commit_id: string;
        event: string;
      };
      const review = {
        id: history.length + 1,
        submitted_at: new Date(Date.UTC(2026, 9, 5, 10, 0, history.length)).toISOString(),
        state: payload.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
        body: payload.body,
        commit_id: payload.commit_id,
        user: { login: "code[bot]" },
      };
      history.push(review);
      return Response.json(review);
    }
    if (path.endsWith("/reviews")) return Response.json(history);
    if (/^\/repos\/owner\/repo\/pulls\/4\/reviews\/\d+$/.test(path))
      return Response.json(history.find((review) => String(review.id) === path.split("/").at(-1)));
    throw new Error(`unexpected endpoint: ${path}`);
  };
  return {
    dir,
    config,
    request,
    history,
    endpoints,
    transport,
    posts: () => posts,
    deny: () => {
      deny = true;
    },
    allow: () => {
      deny = false;
    },
    pause: (callback: () => Promise<void>) => {
      pause = callback;
    },
  };
}

test.each([
  { ci: "pending", verdict: "APPROVED" },
  { ci: "failure", verdict: "APPROVED" },
  { ci: "pending", verdict: "CHANGES_REQUESTED" },
  { ci: "failure", verdict: "CHANGES_REQUESTED" },
] as const)("publishes $verdict with CI $ci without reading CI", async ({ ci, verdict }) => {
  const f = await lifecycleFixture(ci);
  const request = parseRequest({
    ...f.request,
    verdict,
    feedback: verdict === "APPROVED" ? plan : defect,
    rows: [
      { status: verdict === "APPROVED" ? "passed" : "failed", evidence: "targeted-check.txt" },
    ],
  });
  const result = await publishReview(f.config, request, draft.session, f.transport);
  expect(result.status).toBe(verdict);
  assert.ok("localVerdict" in result);
  expect(result.localVerdict).toBe(verdict);
  const publishedState = vi.mocked(publishLaneState).mock.lastCall?.[1];
  expect(publishedState).toMatchObject({ status: verdict });
  if (verdict === "APPROVED") expect(publishedState).not.toHaveProperty("feedback");
  else expect(publishedState?.feedback).toEqual(defect);
  expect(f.history).toHaveLength(1);
  expect(f.history[0]).toMatchObject({ state: verdict, commit_id: draft.H });
  expect(JSON.parse(await readFile(request.receipt, "utf8"))).toMatchObject({
    status: verdict,
    localVerdict: verdict,
    reviewId: 1,
  });
  expect(f.endpoints.some((path) => /\/(status|check-runs|actions)(\/|$)/.test(path))).toBe(false);
  expect(new Set(f.endpoints)).toEqual(
    new Set([
      "/app",
      "/repos/owner/repo/installation",
      "/app/installations/2/access_tokens",
      "/repos/owner/repo",
      "/repos/owner/repo/pulls/4",
      "/repos/owner/repo/pulls/4/reviews",
      "/repos/owner/repo/pulls/4/reviews/1",
    ]),
  );
});

test.each([true, false])(
  "announcement includes feedback only when prepared feedback exists: %s",
  async (hasFeedback) => {
    const f = await lifecycleFixture();
    if (!hasFeedback) {
      const prior = object(await readJson(f.request.receipt));
      delete prior.preparedFeedback;
      await writeFile(f.request.receipt, JSON.stringify(prior));
    }
    vi.mocked(publishLaneState)
      .mockClear()
      .mockImplementationOnce(async (_app, state) => {
        stateBody(state);
      });
    const result = await publishReview(f.config, f.request, draft.session, f.transport);
    const announced = vi.mocked(publishLaneState).mock.calls[0]?.[1];
    if (!announced) throw new Error("missing announcement");
    expect(announced.status).toBe("PENDING");
    expect(Object.hasOwn(announced, "feedback")).toBe(hasFeedback);
    expect(JSON.stringify(announced).includes('"feedback":')).toBe(hasFeedback);
    if (hasFeedback) expect(announced.feedback).toEqual(plan);
    expect(result.status).toBe(hasFeedback ? "APPROVED" : "BLOCKED");
    expect(f.posts()).toBe(hasFeedback ? 1 : 0);
    const completed = vi.mocked(publishLaneState).mock.calls.at(-1)?.[1];
    if (!completed) throw new Error("missing final announcement");
    expect(completed.status).toBe(result.status);
    expect(Object.hasOwn(completed, "feedback")).toBe(!hasFeedback);
    expect(JSON.stringify(completed).includes('"feedback":')).toBe(!hasFeedback);
  },
);

test("superseded attempt cannot overwrite newer BLOCKED; new reviewed attempt can recover", async () => {
  const f = await lifecycleFixture();
  expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
    "APPROVED",
  );
  f.deny();
  const newer = { ...f.request, attempt: "attempt-2" };
  await prepareReview(f.config, newer, draft.session);
  expect((await publishReview(f.config, newer, draft.session, f.transport)).status).toBe("BLOCKED");
  const saved = await readFile(f.request.receipt, "utf8");
  await expect(publishReview(f.config, f.request, draft.session, f.transport)).rejects.toThrow(
    "attempt-superseded",
  );
  expect(await readFile(f.request.receipt, "utf8")).toBe(saved);
  expect(f.posts()).toBe(2);
  f.allow();
  await prepareReview(f.config, { ...f.request, attempt: "attempt-3" }, draft.session);
  expect(
    (
      await publishReview(
        f.config,
        { ...f.request, attempt: "attempt-3" },
        draft.session,
        f.transport,
      )
    ).status,
  ).toBe("APPROVED");
  await expect(publishReview(f.config, newer, draft.session, f.transport)).rejects.toThrow(
    "attempt-superseded",
  );
  expect(f.posts()).toBe(3);
});

test("superseded attempt cannot restore approval after newer request-changes", async () => {
  const f = await lifecycleFixture();
  await publishReview(f.config, f.request, draft.session, f.transport);
  const newer = {
    ...f.request,
    attempt: "attempt-2",
    verdict: "CHANGES_REQUESTED" as const,
    feedback: defect,
    rows: [{ status: "failed" as const, evidence: "attributable assertion" }],
  };
  await prepareReview(f.config, { ...newer, feedback: plan }, draft.session);
  expect((await publishReview(f.config, newer, draft.session, f.transport)).status).toBe(
    "CHANGES_REQUESTED",
  );
  await expect(publishReview(f.config, f.request, draft.session, f.transport)).rejects.toThrow(
    "attempt-superseded",
  );
  expect(JSON.parse(await readFile(f.request.receipt, "utf8"))).toMatchObject({
    attempt: "attempt-2",
    status: "CHANGES_REQUESTED",
  });
});

test("prepare invalidates old approval before QA and block ends current attempt without native writes", async () => {
  const f = await lifecycleFixture();
  await publishReview(f.config, f.request, draft.session, f.transport);
  const newer = { ...f.request, attempt: "attempt-2" };
  expect(await prepareReview(f.config, newer, draft.session)).toMatchObject({
    status: "PENDING",
    inputDigest: null,
  });
  expect(vi.mocked(publishLaneState).mock.lastCall?.[1]).toMatchObject({
    status: "PENDING",
    feedback: plan,
  });
  await expect(
    blockReview(f.config, { ...f.request, feedback: capability }, draft.session),
  ).rejects.toThrow("attempt-superseded");
  expect(
    await blockReview(f.config, { ...newer, feedback: capability }, draft.session),
  ).toMatchObject({
    status: "BLOCKED",
    reviewBlocked: true,
  });
  expect(vi.mocked(publishLaneState).mock.lastCall?.[1]).toMatchObject({
    status: "BLOCKED",
    feedback: capability,
  });
  await expect(publishReview(f.config, newer, draft.session, f.transport)).rejects.toThrow(
    "attempt-blocked",
  );
  await expect(publishReview(f.config, f.request, draft.session, f.transport)).rejects.toThrow(
    "attempt-superseded",
  );
  expect(f.posts()).toBe(1);
  expect(JSON.parse(await readFile(f.request.receipt, "utf8"))).toMatchObject({
    attempt: "attempt-2",
    status: "BLOCKED",
  });
});

test.each([null, undefined])(
  "idempotent prepare CLI exits nonzero with prior feedback publication %s",
  async (feedbackPublication) => {
    const f = await lifecycleFixture();
    const prior = object(await readJson(f.request.receipt));
    const saved = JSON.stringify({
      ...prior,
      inputDigest: "d".repeat(64),
      feedbackPublication,
    });
    await writeFile(f.request.receipt, saved);
    const config = join(f.dir, "config.json"),
      request = join(f.dir, "request.json");
    await writeFile(config, JSON.stringify(f.config));
    await writeFile(request, JSON.stringify(f.request));
    const previousSession = process.env["SPUR_SESSION"],
      previousExit = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    vi.mocked(publishLaneState).mockClear();
    try {
      process.env["SPUR_SESSION"] = draft.session;
      process.exitCode = undefined;
      const program = new Command();
      registerReviewApp(program);
      await program.parseAsync([
        "node",
        "spur",
        "review-app",
        "prepare",
        "--app-config",
        config,
        "--request",
        request,
        "--json",
      ]);
      expect(process.exitCode).toBe(1);
      expect(output.mock.calls.at(-1)?.[0]).toContain('"status":"PENDING"');
      expect(await readFile(f.request.receipt, "utf8")).toBe(saved);
      expect(publishLaneState).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      network.mockRestore();
      process.exitCode = previousExit;
      if (previousSession === undefined) delete process.env["SPUR_SESSION"];
      else process.env["SPUR_SESSION"] = previousSession;
    }
  },
);

test("same-attempt payload conflict preserves state and issues no second POST", async () => {
  const f = await lifecycleFixture();
  await publishReview(f.config, f.request, draft.session, f.transport);
  const saved = await readFile(f.request.receipt, "utf8");
  for (const changed of [
    { body: "changed" },
    { H: "d".repeat(40) },
    { B: "d".repeat(40) },
    { rows: [{ status: "passed" as const, evidence: "changed.png" }] },
  ]) {
    await expect(
      publishReview(f.config, { ...f.request, ...changed }, draft.session, f.transport),
    ).rejects.toThrow("attempt-conflict");
  }
  expect(await readFile(f.request.receipt, "utf8")).toBe(saved);
  expect(f.posts()).toBe(1);
});

test("current native verdict supersedes historical exact approval even without newer local attempt", async () => {
  const f = await lifecycleFixture();
  await publishReview(f.config, f.request, draft.session, f.transport);
  f.history.push({
    id: 2,
    submitted_at: "2026-10-05T12:00:00Z",
    state: "CHANGES_REQUESTED",
    body: "new blocking verdict",
    commit_id: draft.H,
    user: { login: "code[bot]" },
  });
  const result = await publishReview(f.config, f.request, draft.session, f.transport);
  expect(result).toMatchObject({ status: "BLOCKED", reason: "native-verdict-superseded" });
  expect(f.posts()).toBe(1);
});

test("alternate receipt targets cannot bypass canonical lane authority", async () => {
  const f = await lifecycleFixture();
  await expect(
    publishReview(
      f.config,
      { ...f.request, receipt: join(f.dir, "other.json") },
      draft.session,
      f.transport,
    ),
  ).rejects.toThrow("receipt-path-mismatch");
  expect(f.posts()).toBe(0);
});

test("concurrent directory aliases share one canonical lane lock", async () => {
  const f = await lifecycleFixture();
  const alias = `${f.dir}-alias`;
  dirs.push(alias);
  await symlink(f.dir, alias);
  let unblock: (() => void) | undefined, entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.pause(async () => {
    entered?.();
    await gate;
  });
  const first = publishReview(f.config, f.request, draft.session, f.transport);
  await ready;
  try {
    await expect(
      publishReview(
        { ...f.config, receiptRoot: alias },
        {
          ...f.request,
          receipt: join(alias, "owner", "repo", "4", "code.json"),
          attempt: "attempt-2",
        },
        draft.session,
        f.transport,
      ),
    ).rejects.toThrow("attempt-locked");
  } finally {
    unblock?.();
  }
  expect((await first).status).toBe("APPROVED");
  expect(f.posts()).toBe(1);
});

test.each(["network", "http-403", "http-404"])(
  "unknown committed POST stays reconciliation-only after %s and hidden history",
  async (failure) => {
    const f = await lifecycleFixture();
    let hidden = false,
      reconciliationFails = true;
    const transport: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/reviews") && options?.method === "POST") {
        expect(JSON.parse(await readFile(f.request.receipt, "utf8"))).toMatchObject({
          mutationStarted: true,
          status: "PENDING",
          feedback: plan,
        });
        await f.transport(url, options);
        throw new Error("lost response after commit");
      }
      if (path.endsWith("/reviews") && f.posts() > 0) {
        if (reconciliationFails) {
          if (failure !== "network")
            return new Response("history denied", { status: Number(failure.slice(5)) });
          throw new Error("history unavailable");
        }
        if (hidden) return Response.json([]);
      }
      return f.transport(url, options);
    };
    expect((await publishReview(f.config, f.request, draft.session, transport)).status).toBe(
      "BLOCKED",
    );
    expect(JSON.parse(await readFile(f.request.receipt, "utf8"))).toMatchObject({
      mutationStarted: true,
      reason: failure,
    });
    reconciliationFails = false;
    hidden = true;
    expect(await publishReview(f.config, f.request, draft.session, transport)).toMatchObject({
      status: "BLOCKED",
      reason: "publication-uncertain",
    });
    expect(f.posts()).toBe(1);
    expect(f.history).toHaveLength(1);
    hidden = false;
    expect((await publishReview(f.config, f.request, draft.session, transport)).status).toBe(
      "APPROVED",
    );
    expect(f.posts()).toBe(1);
  },
);

let sourceLoader: string | undefined;
function fifoSourceLoader() {
  if (!sourceLoader) {
    const require = createRequire(new URL("../../../packages/web/package.json", import.meta.url));
    sourceLoader = pathToFileURL(require.resolve("tsx/esm")).href;
  }
  return sourceLoader;
}

test.skipIf(process.platform === "win32").each(["legacy", "pending"])(
  "legacy recovery rejects FIFO archive during %s without hanging the canonical lock",
  async (mode) => {
    const f = await legacyRecoveryFixture();
    if (mode === "pending") {
      await f.recover();
      expect(
        createHash("sha256")
          .update(await readFile(f.archive))
          .digest("hex"),
      ).toBe(f.sha256);
      await rm(f.archive);
    }
    await execFileAsync("mkfifo", ["-m", "600", f.archive], { timeout: 2_000 });
    const calls = f.calls.length;
    const child = `
      import { readFile, lstat, access } from "node:fs/promises";
      try {
      const [moduleUrl, configuration, attempt, sha256, archive] = process.argv.slice(1);
      let network = 0, explicitNetwork = 0;
      globalThis.fetch = async () => { network++; throw new Error("unexpected fixture network"); };
      const transport = async () => { explicitNetwork++; throw new Error("unexpected explicit network"); };
      const { recoverReview } = await import(moduleUrl);
      const request = JSON.parse(attempt);
      const before = await readFile(request.receipt);
      const original = await lstat(archive);
      let rejected = false;
      try { await recoverReview(JSON.parse(configuration), request, request.session, sha256, transport); }
      catch (error) { rejected = error?.category === "legacy-archive-invalid"; }
      const after = await lstat(archive);
      let locked = true;
      try { await access(request.receipt + ".lock"); } catch { locked = false; }
      console.log(JSON.stringify({ rejected, network, explicitNetwork, locked,
        unchanged: before.equals(await readFile(request.receipt)),
        fifo: after.isFIFO(), privateMode: (after.mode & 0o777) === 0o600,
        sameArchive: original.ino === after.ino && original.dev === after.dev && original.mode === after.mode }));
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    `;
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          "--import",
          fifoSourceLoader(),
          "--input-type=module",
          "-e",
          child,
          new URL("../../src/review-app.ts", import.meta.url).href,
          JSON.stringify(f.config),
          JSON.stringify(f.request),
          f.sha256,
          f.archive,
        ],
        { timeout: 2_000, killSignal: "SIGKILL" },
      );
      expect(result.stdout.trim()).toBe(
        JSON.stringify({
          rejected: true,
          network: 0,
          explicitNetwork: 0,
          locked: false,
          unchanged: true,
          fifo: true,
          privateMode: true,
          sameArchive: true,
        }),
      );
      expect(result.stderr).toBe("");
      expect(f.calls).toHaveLength(calls);
      expect(f.posts()).toBe(0);
    } finally {
      await rm(f.archive, { force: true });
    }
  },
);

test("lost readback retains known review ID and never repeats POST against empty history", async () => {
  const f = await lifecycleFixture();
  let failReadback = true,
    hideHistory = false;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (failReadback && path.endsWith("/reviews/1")) throw new Error("readback lost");
    if (hideHistory && path.endsWith("/reviews") && options?.method !== "POST")
      return Response.json([]);
    return f.transport(url, options);
  };
  expect(await publishReview(f.config, f.request, draft.session, transport)).toMatchObject({
    status: "BLOCKED",
    reviewId: 1,
    mutationStarted: true,
  });
  failReadback = false;
  hideHistory = true;
  expect(await publishReview(f.config, f.request, draft.session, transport)).toMatchObject({
    status: "BLOCKED",
    reviewId: 1,
  });
  expect(f.posts()).toBe(1);
});

test("final receipt save failure retains mutation and known ID for reconciliation-only retry", async () => {
  const f = await lifecycleFixture();
  faults.approvedWrite = true;
  expect(await publishReview(f.config, f.request, draft.session, f.transport)).toMatchObject({
    status: "BLOCKED",
    reason: "receipt-write",
    mutationStarted: true,
    reviewId: 1,
  });
  faults.approvedWrite = false;
  const transport: typeof fetch = async (url, options) => {
    if (new URL(String(url)).pathname.endsWith("/reviews") && options?.method !== "POST")
      return Response.json([]);
    return f.transport(url, options);
  };
  expect((await publishReview(f.config, f.request, draft.session, transport)).status).toBe(
    "BLOCKED",
  );
  expect(f.posts()).toBe(1);
  expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
    "APPROVED",
  );
  expect(f.posts()).toBe(1);
});

test("definitive rejected POST supports unchanged retry without permitting ambiguous retry", async () => {
  const f = await lifecycleFixture();
  f.deny();
  expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
    "BLOCKED",
  );
  expect(JSON.parse(await readFile(f.request.receipt, "utf8"))).toMatchObject({
    mutationStarted: false,
  });
  f.allow();
  expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
    "APPROVED",
  );
  expect(f.posts()).toBe(2);
  expect(f.history).toHaveLength(1);
});

test.each([
  "H",
  "B",
  "session",
  "contractDigest",
  "mutationStarted",
  "reviewId",
  "attempt",
  "reviewBlocked",
  "inputDigest",
  "supersededAttempts",
  "evidence",
  "coverage",
  "localVerdict",
  "reason",
  "appId",
])("prepare preserves malformed authority missing %s", async (field) => {
  const f = await lifecycleFixture();
  const stored = JSON.parse(await readFile(f.request.receipt, "utf8")) as Record<string, unknown>;
  const { [field]: removed, ...remaining } = stored;
  expect(removed).not.toBeUndefined();
  const bytes = JSON.stringify(remaining);
  await writeFile(f.request.receipt, bytes);
  await expect(
    prepareReview(f.config, { ...f.request, attempt: "new-attempt" }, draft.session),
  ).rejects.toThrow("receipt-state-invalid");
  expect(await readFile(f.request.receipt, "utf8")).toBe(bytes);
  expect(f.posts()).toBe(0);
});

test.each(["symlink", "hardlink", "readable"])(
  "exclusive staging ignores stale %s temp without following it",
  async (variant) => {
    const f = await lifecycleFixture();
    const request = { ...f.request, attempt: "stale-temp-test" };
    const sentinel = join(f.dir, "sentinel");
    await writeFile(sentinel, "SENTINEL", { mode: 0o600 });
    const stale = `${request.receipt}.${request.attempt}.tmp`;
    if (variant === "symlink") await symlink(sentinel, stale);
    else if (variant === "hardlink") await link(sentinel, stale);
    else await writeFile(stale, "STALE", { mode: 0o644 });
    expect((await prepareReview(f.config, request, draft.session)).status).toBe("PENDING");
    expect(await readFile(sentinel, "utf8")).toBe("SENTINEL");
    expect((await stat(request.receipt)).mode & 0o077).toBe(0);
  },
);

test("invalid same-actor history rejects before native mutation", async () => {
  const f = await lifecycleFixture();
  f.history.push({
    id: NaN,
    submitted_at: "2026-10-05T12:00:00Z",
    state: "APPROVED",
    body: "bad",
    commit_id: draft.H,
    user: { login: "code[bot]" },
  });
  expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
    "BLOCKED",
  );
  expect(f.posts()).toBe(0);
});

test("failed evidence invalidates stored APPROVED authority without overwriting bytes", async () => {
  const f = await lifecycleFixture();
  await publishReview(f.config, f.request, draft.session, f.transport);
  const prior = JSON.parse(await readFile(f.request.receipt, "utf8")) as Record<string, unknown>;
  const bytes = JSON.stringify({ ...prior, evidence: [{ status: "failed", evidence: "failure" }] });
  await writeFile(f.request.receipt, bytes);
  await expect(
    prepareReview(f.config, { ...f.request, attempt: "new" }, draft.session),
  ).rejects.toThrow("receipt-state-invalid");
  expect(await readFile(f.request.receipt, "utf8")).toBe(bytes);
});

test.each(["later-block", "later-approval", "missing", "tied"])(
  "native %s chronology uses submission time and blocks unknown ordering",
  async (mode) => {
    const f = await lifecycleFixture();
    await publishReview(f.config, f.request, draft.session, f.transport);
    const exact = f.history[0];
    if (!exact) throw new Error("missing fixture review");
    exact.id = mode === "later-approval" ? 50 : 100;
    if (mode === "later-approval") exact.submitted_at = "2026-10-05T12:00:00Z";
    if (mode === "missing") Reflect.deleteProperty(exact, "submitted_at");
    f.history.push({
      id: mode === "later-approval" ? 100 : 50,
      state: "CHANGES_REQUESTED",
      body: "blocking verdict",
      commit_id: draft.H,
      user: { login: "code[bot]" },
      submitted_at:
        mode === "later-approval"
          ? "2026-10-05T09:00:00Z"
          : mode === "tied"
            ? exact.submitted_at
            : "2026-10-05T12:00:00Z",
    });
    expect((await publishReview(f.config, f.request, draft.session, f.transport)).status).toBe(
      mode === "later-approval" ? "APPROVED" : "BLOCKED",
    );
    expect(f.posts()).toBe(1);
  },
);

test("readback token refresh cannot rotate App identity and persist approval", async () => {
  const f = await lifecycleFixture();
  let rotating = false;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/reviews/1") && !rotating) {
      rotating = true;
      return new Response("expired", { status: 401 });
    }
    if (rotating && path === "/app") return Response.json({ id: 1, slug: "rotated" });
    return f.transport(url, options);
  };
  expect(await publishReview(f.config, f.request, draft.session, transport)).toMatchObject({
    status: "BLOCKED",
    reason: "identity-changed",
    reviewId: 1,
    mutationStarted: true,
  });
  expect(f.posts()).toBe(1);
});

async function legacyRecoveryFixture() {
  const f = await lifecycleFixture();
  const legacy = {
    repository: "owner/repo",
    pr: 4,
    lane: "code",
    session: "old-reviewer",
    attempt: "old-attempt",
    previousAttempt: "older-attempt",
    H: draft.H,
    B: draft.B,
    contractDigest: draft.contractDigest,
    status: "BLOCKED",
    localVerdict: "FAIL",
    publicationVerdict: "BLOCKED",
    reviewId: null,
    evidence: [{ scenario: "historical failure", status: "BLOCKED" }],
    publication: { submitted: false, reason: "historical diagnostic" },
    wakeReconciliation: { newAttempt: false },
  };
  const raw = Buffer.from(JSON.stringify(legacy, null, 2) + "\n");
  await writeFile(f.request.receipt, raw);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const request = { ...f.request, session: "replacement-reviewer", attempt: "replacement-attempt" };
  const archive = `${request.receipt}.legacy-${sha256}`;
  const calls: string[] = [];
  const comments: { id: number; body: string; user: { login: string } }[] = [];
  let failReadback = false;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${options?.method ?? "GET"} ${path}`);
    if (path === "/repos/owner/repo/issues/4/comments") {
      if (options?.method !== "POST") return Response.json(comments);
      let payload: { body: string };
      try {
        payload = JSON.parse(String(options.body)) as { body: string };
      } catch (error) {
        throw new Error("Invalid recovery fixture comment payload", { cause: error });
      }
      const row = { id: comments.length + 1, body: payload.body, user: { login: "code[bot]" } };
      comments.push(row);
      return Response.json(row);
    }
    if (path.startsWith("/repos/owner/repo/issues/comments/"))
      return failReadback ? Response.json({}) : Response.json(comments.at(-1));
    return f.transport(url, options);
  };
  const actual = await vi.importActual<typeof ReviewState>("../../src/review-state.js");
  vi.mocked(publishLaneState).mockImplementation(actual.publishLaneState);
  return {
    ...f,
    legacy,
    raw,
    sha256,
    request,
    archive,
    calls,
    comments,
    transport,
    failReadback: () => {
      failReadback = true;
    },
    recover: () => recoverReview(f.config, request, request.session, sha256, transport),
  };
}

test("legacy recovery archives exact bytes and retires both attempts without a native review", async () => {
  const f = await legacyRecoveryFixture();
  const result = await f.recover();
  assert.ok("legacyRecovery" in result);
  expect(result).toMatchObject({
    status: "PENDING",
    localVerdict: null,
    evidence: [],
    coverage: null,
    reviewId: null,
    inputDigest: null,
    mutationStarted: false,
    reviewBlocked: false,
    supersededAttempts: ["old-attempt", "older-attempt"],
    legacyRecovery: {
      version: 1,
      digest: f.sha256,
      session: "old-reviewer",
      publication: "unknown",
      attempts: ["old-attempt", "older-attempt"],
    },
  });
  expect(await readFile(f.archive)).toEqual(f.raw);
  expect((await stat(f.archive)).mode & 0o077).toBe(0);
  expect(f.comments).toHaveLength(1);
  expect(f.comments[0]?.body).toContain('"status":"PENDING"');
  expect(f.posts()).toBe(0);
  expect(f.calls.filter((call) => call.includes("/reviews"))).toHaveLength(1);
  const next = { ...f.request, attempt: "next-attempt" };
  expect(await prepareReview(f.config, next, next.session, f.transport)).toMatchObject({
    status: "PENDING",
    supersededAttempts: ["old-attempt", "older-attempt", f.request.attempt],
    legacyRecovery: result.legacyRecovery,
  });
  for (const attempt of ["old-attempt", "older-attempt"]) {
    await expect(
      prepareReview(f.config, { ...next, attempt }, next.session, f.transport),
    ).rejects.toThrow("attempt-superseded");
    await expect(
      publishReview(f.config, { ...next, attempt }, next.session, f.transport),
    ).rejects.toThrow("attempt-superseded");
  }
  expect(await readFile(f.archive)).toEqual(f.raw);
});

test.each(["success", "announcement-failure"])(
  "legacy recovery G1 %s retains archive and reports feedback publication",
  async (mode) => {
    const f = await legacyRecoveryFixture();
    await f.recover();
    const current = await readFile(f.request.receipt);
    expect(createHash("sha256").update(current).digest("hex")).not.toBe(f.sha256);
    if (mode === "announcement-failure") {
      f.comments.splice(0);
      f.failReadback();
      await expect(f.recover()).rejects.toThrow("state-publication-mismatch");
    } else {
      expect(await f.recover()).toMatchObject({
        status: "PENDING",
        feedbackPublication: { status: "confirmed" },
      });
    }
    expect(await readFile(f.request.receipt)).toEqual(current);
    expect(await readFile(f.archive)).toEqual(f.raw);
    expect(f.posts()).toBe(0);
  },
);

test.each([
  "unknown-key",
  "authority-key",
  "bad-previous",
  "wrong-repo",
  "wrong-pr",
  "wrong-lane",
  "wrong-status",
  "wrong-verdict",
  "review-id",
  "malformed",
  "digest",
  "session",
  "path",
  "retired",
  "wake-lineage",
])("legacy recovery rejects %s before receipt writes or network", async (mode) => {
  const f = await legacyRecoveryFixture();
  const invalid: Record<string, unknown> = { ...f.legacy };
  if (mode === "unknown-key") invalid.retiredAttempts = ["hidden-attempt"];
  if (mode === "authority-key") invalid.PR = 4;
  if (mode === "bad-previous") invalid.previousAttempt = [];
  if (mode === "wrong-repo") invalid.repository = "other/repo";
  if (mode === "wrong-pr") invalid.pr = 5;
  if (mode === "wrong-lane") invalid.lane = "browser";
  if (mode === "wrong-status") invalid.status = "PENDING";
  if (mode === "wrong-verdict") invalid.localVerdict = "APPROVED";
  if (mode === "review-id") invalid.reviewId = 1;
  if (mode === "wake-lineage") invalid.wakeReconciliation = { newAttempt: "undeclared-attempt" };
  const raw = mode === "malformed" ? Buffer.from("{") : Buffer.from(JSON.stringify(invalid));
  await writeFile(f.request.receipt, raw);
  const sha256 =
    mode === "digest" ? "0".repeat(64) : createHash("sha256").update(raw).digest("hex");
  const request = {
    ...f.request,
    ...(mode === "path" ? { receipt: join(f.dir, "other.json") } : {}),
    ...(mode === "retired" ? { attempt: "older-attempt" } : {}),
  };
  const writes = faults.writes;
  await expect(
    recoverReview(
      f.config,
      request,
      mode === "session" ? "wrong-session" : request.session,
      sha256,
      f.transport,
    ),
  ).rejects.toThrow();
  expect(await readFile(f.request.receipt)).toEqual(raw);
  expect(faults.writes).toBe(writes);
  expect(f.calls).toEqual([]);
});

test.each(["archive-write", "archive-link", "directory-sync", "canonical-write"])(
  "legacy recovery %s fault preserves original and retries exact archive",
  async (mode) => {
    const f = await legacyRecoveryFixture();
    faults.recovery = mode;
    await expect(f.recover()).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(f.raw);
    expect(f.calls.some((call) => call.includes("/reviews"))).toBe(true);
    expect(f.calls.some((call) => call.startsWith("POST") && call.includes("/reviews"))).toBe(
      false,
    );
    expect(await f.recover()).toMatchObject({ status: "PENDING" });
    expect(await readFile(f.archive)).toEqual(f.raw);
  },
);

test.each(["wrong-bytes", "public-mode", "symlink"])(
  "legacy recovery refuses %s archive without overwrite",
  async (mode) => {
    const f = await legacyRecoveryFixture();
    if (mode === "symlink") await symlink(f.request.receipt, f.archive);
    else {
      await writeFile(f.archive, mode === "wrong-bytes" ? "wrong" : f.raw, { mode: 0o600 });
      if (mode === "public-mode") await chmod(f.archive, 0o644);
    }
    const original = await readFile(f.archive);
    const writes = faults.writes;
    await expect(f.recover()).rejects.toThrow("legacy-archive-invalid");
    expect(await readFile(f.request.receipt)).toEqual(f.raw);
    expect(await readFile(f.archive)).toEqual(original);
    expect(faults.writes).toBe(writes);
    expect(f.calls).toEqual([]);
  },
);

test.each([
  "session",
  "attempt",
  "H",
  "B",
  "contract",
  "app",
  "digest",
  "archive",
  "lineage",
  "malformed",
  "BLOCKED",
  "APPROVED",
  "CHANGES_REQUESTED",
])("legacy recovery rejects changed current %s without reset", async (mode) => {
  const f = await legacyRecoveryFixture();
  await f.recover();
  const request = { ...f.request };
  const config = { ...f.config, code: { ...f.config.code } };
  const current = (await readJson(request.receipt)) as Record<string, unknown>;
  if (mode === "session") request.session = "other-reviewer";
  if (mode === "attempt") request.attempt = "other-attempt";
  if (mode === "H") request.H = "d".repeat(40);
  if (mode === "B") request.B = "d".repeat(40);
  if (mode === "contract") request.contractDigest = "d".repeat(64);
  if (mode === "app") config.code.appId = 3;
  if (mode === "lineage") current.supersededAttempts = ["old-attempt"];
  if (mode === "malformed") delete current.mutationStarted;
  if (["BLOCKED", "APPROVED", "CHANGES_REQUESTED"].includes(mode)) current.status = mode;
  await writeFile(request.receipt, JSON.stringify(current));
  if (mode === "archive") await writeFile(f.archive, "wrong archive");
  const raw = await readFile(request.receipt);
  const archived = await readFile(f.archive);
  f.calls.splice(0);
  const writes = faults.writes;
  await expect(
    recoverReview(
      config,
      request,
      request.session,
      mode === "digest" ? "0".repeat(64) : f.sha256,
      f.transport,
    ),
  ).rejects.toThrow();
  expect(faults.writes).toBe(writes);
  expect(f.calls).toEqual([]);
  expect(await readFile(request.receipt)).toEqual(raw);
  expect(await readFile(f.archive)).toEqual(archived);
});

test("legacy recovery failed initial announcement stays BLOCKED until ordinary fresh prepare", async () => {
  const f = await legacyRecoveryFixture();
  f.failReadback();
  expect(await f.recover()).toMatchObject({ status: "BLOCKED", reviewBlocked: true });
  const current = await readFile(f.request.receipt);
  await expect(f.recover()).rejects.toThrow();
  expect(await readFile(f.request.receipt)).toEqual(current);
  vi.mocked(publishLaneState).mockResolvedValue(undefined);
  expect(
    await prepareReview(
      f.config,
      { ...f.request, attempt: "fresh-after-block" },
      f.request.session,
      f.transport,
    ),
  ).toMatchObject({
    status: "PENDING",
    legacyRecovery: { publication: "unknown" },
    supersededAttempts: ["old-attempt", "older-attempt", f.request.attempt],
  });
  expect(await readFile(f.archive)).toEqual(f.raw);
  expect(f.posts()).toBe(0);
});

test("legacy recovery canonical directory-sync fault retains owned BLOCKED and exact archive", async () => {
  const f = await legacyRecoveryFixture();
  faults.recovery = "canonical-sync";
  expect(await f.recover()).toMatchObject({
    status: "BLOCKED",
    reviewBlocked: true,
    legacyRecovery: { publication: "unknown" },
  });
  expect(await readFile(f.archive)).toEqual(f.raw);
  await expect(f.recover()).rejects.toThrow();
  expect(f.posts()).toBe(0);
});

test("legacy recovery matching a current receipt raw SHA never grants legacy authority", async () => {
  const f = await legacyRecoveryFixture();
  await f.recover();
  const current = await readFile(f.request.receipt);
  const writes = faults.writes;
  f.calls.splice(0);
  await expect(
    recoverReview(
      f.config,
      f.request,
      f.request.session,
      createHash("sha256").update(current).digest("hex"),
      f.transport,
    ),
  ).rejects.toThrow("legacy-receipt-invalid");
  expect(await readFile(f.request.receipt)).toEqual(current);
  expect(faults.writes).toBe(writes);
  expect(f.calls).toEqual([]);
});

test("legacy recovery realpath aliases share canonical lock and stale recovery cannot replace newer", async () => {
  const f = await legacyRecoveryFixture();
  const alias = `${f.dir}-alias`;
  await symlink(f.dir, alias);
  dirs.push(alias);
  let entered!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.pause(async () => {
    entered();
    await held;
  });
  const first = f.recover();
  await paused;
  try {
    const request = { ...f.request, receipt: join(alias, "owner", "repo", "4", "code.json") };
    await expect(
      recoverReview(
        { ...f.config, receiptRoot: alias },
        request,
        request.session,
        f.sha256,
        f.transport,
      ),
    ).rejects.toThrow("attempt-locked");
  } finally {
    release();
  }
  await first;
  await prepareReview(
    f.config,
    { ...f.request, attempt: "newer-attempt" },
    f.request.session,
    f.transport,
  );
  const newer = await readFile(f.request.receipt);
  await expect(f.recover()).rejects.toThrow();
  expect(await readFile(f.request.receipt)).toEqual(newer);
  expect(f.posts()).toBe(0);
});

test.each(["APPROVED", "CHANGES_REQUESTED"] as const)(
  "legacy recovery cannot reset genuinely published %s",
  async (verdict) => {
    const f = await legacyRecoveryFixture();
    await f.recover();
    expect(
      await publishReview(
        f.config,
        {
          ...f.request,
          verdict,
          feedback: verdict === "APPROVED" ? plan : defect,
          rows: [
            { status: verdict === "APPROVED" ? "passed" : "failed", evidence: "named attribution" },
          ],
        },
        f.request.session,
        f.transport,
      ),
    ).toMatchObject({ status: verdict });
    const current = await readFile(f.request.receipt);
    const posts = f.posts();
    f.calls.splice(0);
    await expect(f.recover()).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(current);
    expect(f.calls).toEqual([]);
    expect(f.posts()).toBe(posts);
  },
);

test.each([
  "evidence",
  "localVerdict",
  "coverage",
  "mutation",
  "recovery-metadata",
  "archive-missing",
])("legacy recovery rejects touched PENDING %s before save or network", async (mode) => {
  const f = await legacyRecoveryFixture();
  await f.recover();
  const current = (await readJson(f.request.receipt)) as Record<string, unknown>;
  if (mode === "evidence") current.evidence = [{ status: "passed", evidence: "already assessed" }];
  if (mode === "localVerdict") current.localVerdict = "APPROVED";
  if (mode === "coverage") current.coverage = draft.coverage;
  if (mode === "mutation") {
    current.mutationStarted = true;
    current.inputDigest = "a".repeat(64);
  }
  if (mode === "recovery-metadata")
    current.legacyRecovery = {
      version: 1,
      digest: f.sha256,
      attempts: ["old-attempt"],
      session: "old-reviewer",
      publication: "absent",
    };
  if (mode === "archive-missing") await rm(f.archive);
  await writeFile(f.request.receipt, JSON.stringify(current));
  const raw = await readFile(f.request.receipt);
  f.calls.splice(0);
  const writes = faults.writes;
  await expect(f.recover()).rejects.toThrow();
  expect(faults.writes).toBe(writes);
  expect(f.calls).toEqual([]);
  expect(await readFile(f.request.receipt)).toEqual(raw);
});

// Sanitized snapshots retain every observed key and row variant, not original bytes.
function lineageSnapshot(lane: "code" | "browser") {
  const common = {
    repository: "ashugaev/spur",
    pr: 887,
    lane,
    session: "historical-review",
    attempt: "historical-attempt",
    contractDigest: "379384c38ef273c111a2576abc5c090b3fe08a3bd68af35de0580b45897f030a",
    localVerdict: "APPROVED",
    status: "BLOCKED",
    reviewId: null,
  };
  if (lane === "code")
    return {
      ...common,
      H: "f0257be2e9ac82ff87bf29a6200ed76a1c155249",
      B: "31bf904dbfa8f08180baa0a1ebc7829f76b44b3a",
      evidence: ["PASS", "PASS", "NOTE", "PASS", "PASS", "RETAINED"].map((status, i) => ({
        id: `code-${i}`,
        requirement: "Historical requirement",
        action: "Historical check",
        result: "Historical result",
        status,
      })),
      prior: {
        attempt: "historical-prior",
        H: "8618c6c147da7c13fe4d0567fa357f4c18d539bf",
        B: "d89def94df9331605d90196570785951643fc196",
        localVerdict: "APPROVED",
        status: "BLOCKED",
      },
      requestNote: "Historical request",
      publication: {
        attempted: null,
        result: "Historical denial",
        appStatus: "Historical capability",
        prerequisite: "Historical prerequisite",
      },
      notification: "Historical notification",
      head: "26e11a6700f27dfa54ec0d17dfc0ae8df2b9eb23",
      base: "de90f1e2ffd2c74c887e404b86a3b01f2067614d",
      delta: {
        from: "Historical baseline",
        commits: ["Historical commit"],
        kind: "Historical delta",
        conflicts: "Historical conflicts",
        checks: "Historical checks",
      },
    };
  return {
    ...common,
    H: "db67b3855a3a36e00ea20976be3d547676b1ecb2",
    B: "a4a71c6bae94859e25e6c26dbf5f9f74142f7b77",
    reason: "Historical blocker",
    evidence: Array.from({ length: 7 }, (_, i) => ({
      id: `browser-${i}`,
      requirement: "Historical requirement",
      variant: "Historical variant",
      action: "Historical check",
      result: "Historical result",
      ...(i < 6 ? { artifact: "historical.png" } : { status: "PASS" }),
      ...(i < 4 ? { retainedFrom: "Historical baseline", rationale: "Historical rationale" } : {}),
    })),
    updatedAt: "2026-10-09T05:12:52Z",
  };
}

const legacyFamilies = ["fail", "diagnostic", "conclusion", "lineage", "reason"] as const;
type LegacyFamily = (typeof legacyFamilies)[number];

async function structuralFixture(
  lane: "code" | "browser" = "code",
  family: LegacyFamily = lane === "code" ? "diagnostic" : "conclusion",
  identity = { repo: "fixtures/recovery", pr: 73 },
) {
  const f = await lifecycleFixture();
  const request = parseAttempt({
    ...draft,
    repo: identity.repo,
    pr: identity.pr,
    lane,
    receipt: join(f.dir, ...identity.repo.split("/"), String(identity.pr), `${lane}.json`),
  });
  const config = { ...f.config, repositories: [request.repo] };
  const profile: Record<string, unknown> =
    family === "lineage" || family === "reason"
      ? lineageSnapshot(family === "lineage" ? "code" : "browser")
      : {
          repository: request.repo,
          pr: request.pr,
          lane,
          session: "historical-review",
          attempt: "historical-attempt",
          H: "f61a0b6f9eb437cdc84037ca4d8d9b54c6b400a9",
          B: "85c9d9e7487a6918fe6da0be1323107d0734e96d",
          contractDigest: "379384c38ef273c111a2576abc5c090b3fe08a3bd68af35de0580b45897f030a",
          status: "BLOCKED",
          reviewId: null,
          updatedAt: "2026-10-04T05:33:00Z",
          ...(family === "diagnostic" || family === "fail"
            ? {
                localVerdict: "APPROVED",
                publication: "Unrelated historical publication diagnostic",
                evidence: ["sanitized historical diagnostic"],
                notification: "SENT task",
                lastDeltaCheck: "2026-11-04T05:23:08Z",
                deltaNote: "historical delta",
              }
            : {
                localConclusion: "APPROVED",
                publicationBlockReason: "A different historical capability reason",
                evidence: [
                  {
                    id: "SC-01",
                    boundary: "Dashboard",
                    action: "Open dashboard",
                    expected: "Loads",
                    status: "PASS",
                    artifact: "dashboard.png",
                  },
                ],
                ownerNotification: "SENT task",
              }),
        };
  const legacy: Record<string, unknown> = {
    ...profile,
    repository: request.repo,
    pr: request.pr,
    lane,
    H: "1".repeat(40),
    B: "2".repeat(40),
    contractDigest: "3".repeat(64),
  };
  if (family === "fail") {
    Reflect.deleteProperty(legacy, "lastDeltaCheck");
    Reflect.deleteProperty(legacy, "deltaNote");
    legacy.localVerdict = "FAIL";
    legacy.publicationVerdict = "BLOCKED";
    legacy.previousAttempt = "historical-prior";
  }
  const raw = Buffer.from(JSON.stringify(legacy));
  await mkdir(join(f.dir, ...request.repo.split("/"), String(request.pr)), { recursive: true });
  await writeFile(request.receipt, raw);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const archive = `${request.receipt}.legacy-${sha256}`;
  const calls: string[] = [];
  const comments: { id: number; body: string; user: { login: string } }[] = [];
  const controls: {
    mode: string;
    intercept?: (url: URL, options?: RequestInit) => Promise<Response | undefined>;
  } = { mode: "" };
  let freshReads = 0;
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = options?.method ?? "GET";
    calls.push(`${method} ${path}${url.search}`);
    const intercepted = await controls.intercept?.(url, options);
    if (intercepted) return intercepted;
    const mode = controls.mode;
    if (method === "GET" && path === "/app")
      return Response.json({ id: mode === "wrong-app" ? 99 : config[lane].appId, slug: lane });
    if (method === "GET" && path === `/repos/${request.repo}/installation`)
      return Response.json({ id: 3, app_id: mode === "installation" ? 99 : config[lane].appId });
    if (method === "POST" && path === "/app/installations/3/access_tokens")
      return Response.json({
        token: "fixture-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: {
          pull_requests: mode === "permissions" ? "read" : "write",
          metadata: "read",
        },
      });
    if (method === "GET" && path === `/repos/${request.repo}`)
      return Response.json({
        id: 4,
        full_name: mode === "repository" ? "other/repo" : request.repo,
      });
    if (method === "GET" && path === `/repos/${request.repo}/pulls/${request.pr}`) {
      freshReads++;
      return Response.json({
        state: mode === "closed" ? "closed" : "open",
        head: {
          sha:
            mode === "H" || (mode === "second-fresh" && freshReads === 2)
              ? "d".repeat(40)
              : request.H,
        },
        base: { sha: mode === "B" ? "d".repeat(40) : request.B },
        user: { login: mode === "author" ? `${lane}[bot]` : "author" },
      });
    }
    if (method === "GET" && path === `/repos/${request.repo}/pulls/${request.pr}/reviews`) {
      if (mode === "malformed-history") return Response.json({ reviews: [] });
      if (mode === "history") return Response.json([{ state: "PENDING" }]);
      if (["later-page", "failed-page"].includes(mode)) {
        if (url.searchParams.get("page") === "1")
          return Response.json(Array(100).fill({ state: "COMMENTED" }));
        return mode === "failed-page"
          ? new Response("failed", { status: 503 })
          : Response.json([{ state: "APPROVED" }]);
      }
      return Response.json([]);
    }
    if (path === `/repos/${request.repo}/issues/${request.pr}/comments`) {
      if (method === "GET") return Response.json(comments);
      if (method === "POST") {
        let payload: { body: string };
        try {
          payload = JSON.parse(String(options?.body)) as { body: string };
        } catch {
          throw new Error("Invalid fixture body");
        }
        const row = {
          id: comments.length + 1,
          body: payload.body,
          user: { login: `${lane}[bot]` },
        };
        comments.push(row);
        return Response.json(row);
      }
    }
    if (method === "GET" && path === `/repos/${request.repo}/issues/comments/${comments.length}`)
      return Response.json(mode === "readback" ? {} : comments.at(-1));
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  };
  vi.mocked(publishLaneState).mockImplementation(
    (await vi.importActual<typeof ReviewState>("../../src/review-state.js")).publishLaneState,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected global network");
    }),
  );
  return {
    config,
    request,
    raw,
    legacy,
    sha256,
    archive,
    calls,
    comments,
    controls,
    recover: () => recoverReview(config, request, request.session, sha256, transport),
    transport,
  };
}

test.each(
  legacyFamilies.flatMap((family) =>
    (["code", "browser"] as const).map((lane) => ({ family, lane })),
  ),
)(
  "generic real-hash $family on $lane clears authority and replays without writes",
  async ({ family, lane }) => {
    const f = await structuralFixture(lane, family, {
      repo: lane === "code" ? "sample/first" : "different/second",
      pr: lane === "code" ? 419 : 823,
    });
    const legacy = {
      ...f.legacy,
      session: `origin-${family}-${lane}`,
      attempt: `source-${family}-${lane}`,
      H: "7".repeat(40),
      B: "8".repeat(40),
      contractDigest: "9".repeat(64),
    };
    const raw = Buffer.from(JSON.stringify(legacy));
    await writeFile(f.request.receipt, raw);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const archive = `${f.request.receipt}.legacy-${sha256}`;
    const recover = () =>
      recoverReview(f.config, f.request, f.request.session, sha256, f.transport);
    const attempts = [legacy.attempt];
    if (family === "lineage" || family === "fail") attempts.push("historical-prior");
    expect(await recover()).toMatchObject({
      status: "PENDING",
      H: f.request.H,
      B: f.request.B,
      session: f.request.session,
      attempt: f.request.attempt,
      localVerdict: null,
      evidence: [],
      coverage: null,
      reviewId: null,
      inputDigest: null,
      mutationStarted: false,
      supersededAttempts: attempts,
      legacyRecovery: {
        version: 1,
        digest: sha256,
        session: legacy.session,
        publication: "unknown",
        attempts,
      },
      feedbackPublication: { status: "confirmed" },
    });
    expect(await readFile(archive)).toEqual(raw);
    const pending = await readFile(f.request.receipt);
    const writes = faults.writes;
    expect(await recover()).toMatchObject({
      status: "PENDING",
      feedbackPublication: { status: "confirmed" },
    });
    expect(await readFile(f.request.receipt)).toEqual(pending);
    expect(faults.writes).toBe(writes);
    expect(f.calls.filter((row) => row.includes("/reviews?"))).toHaveLength(2);
    f.comments.splice(0);
    f.controls.mode = "readback";
    await expect(recover()).rejects.toThrow("state-publication-mismatch");
    expect(await readFile(f.request.receipt)).toEqual(pending);
    expect(await readFile(archive)).toEqual(raw);
    expect(faults.writes).toBe(writes);
    expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
  },
);

test.each(["code", "browser"] as const)(
  "lineage/reason %s resets authority and replays exact archives",
  async (lane) => {
    const f = await structuralFixture(lane, lane === "code" ? "lineage" : "reason");
    const attempts =
      lane === "code" ? ["historical-attempt", "historical-prior"] : ["historical-attempt"];
    expect(await f.recover()).toMatchObject({
      status: "PENDING",
      H: f.request.H,
      B: f.request.B,
      session: f.request.session,
      attempt: f.request.attempt,
      localVerdict: null,
      evidence: [],
      coverage: null,
      reviewId: null,
      inputDigest: null,
      mutationStarted: false,
      supersededAttempts: attempts,
      legacyRecovery: { digest: f.sha256, publication: "unknown", attempts },
      feedbackPublication: { status: "confirmed" },
    });
    expect(await readFile(f.archive)).toEqual(f.raw);
    const pending = await readFile(f.request.receipt);
    const writes = faults.writes;
    expect(await f.recover()).toMatchObject({ status: "PENDING" });
    expect(await readFile(f.request.receipt)).toEqual(pending);
    expect(faults.writes).toBe(writes);
    expect(f.comments).toHaveLength(1);
    expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(legacyFamilies)(
  "generic %s initial and replay refuse native history and revision conflicts",
  async (family) => {
    for (const mode of ["history", "H"]) {
      const f = await structuralFixture("browser", family);
      f.controls.mode = mode;
      await expect(f.recover()).rejects.toThrow();
      expect(await readFile(f.request.receipt)).toEqual(f.raw);
      await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.comments).toHaveLength(0);
      f.controls.mode = "";
      await f.recover();
      const pending = await readFile(f.request.receipt);
      const writes = faults.writes;
      f.controls.mode = mode;
      await expect(f.recover()).rejects.toThrow();
      expect(await readFile(f.request.receipt)).toEqual(pending);
      expect(await readFile(f.archive)).toEqual(f.raw);
      expect(faults.writes).toBe(writes);
      expect(f.calls.filter((row) => row === "GET /app").length).toBeGreaterThanOrEqual(3);
      expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
    }
  },
);

test.each(legacyFamilies)(
  "generic %s rejects partial modern authority with exact supplied bytes",
  async (family) => {
    const f = await structuralFixture("code", family);
    for (const key of [
      "PR",
      "appId",
      "inputDigest",
      "mutationStarted",
      "reviewBlocked",
      "supersededAttempts",
      "legacyRecovery",
    ]) {
      const raw = Buffer.from(JSON.stringify({ ...f.legacy, [key]: true }));
      const sha256 = createHash("sha256").update(raw).digest("hex");
      await writeFile(f.request.receipt, raw);
      const writes = faults.writes;
      await expect(
        recoverReview(f.config, f.request, f.request.session, sha256, f.transport),
      ).rejects.toThrow("legacy-receipt-invalid");
      expect(await readFile(f.request.receipt)).toEqual(raw);
      await expect(stat(`${f.request.receipt}.legacy-${sha256}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(faults.writes).toBe(writes);
    }
    expect(f.calls).toEqual([]);
  },
);

test.each(legacyFamilies)(
  "generic %s replays existing version1 archive metadata without registrations",
  async (family) => {
    const f = await structuralFixture("code", family);
    await rm(f.request.receipt);
    const pending = await prepareReview(f.config, f.request, f.request.session, f.transport);
    const attempts =
      family === "fail" || family === "lineage"
        ? ["historical-attempt", "historical-prior"]
        : ["historical-attempt"];
    await writeFile(f.archive, f.raw, { mode: 0o600 });
    await writeFile(
      f.request.receipt,
      JSON.stringify({
        ...pending,
        supersededAttempts: attempts,
        legacyRecovery: {
          version: 1,
          digest: f.sha256,
          attempts,
          session: "historical-review",
          publication: "unknown",
        },
      }),
    );
    const before = await readFile(f.request.receipt);
    const writes = faults.writes;
    expect(await f.recover()).toMatchObject({
      status: "PENDING",
      feedbackPublication: { status: "confirmed" },
    });
    expect(await readFile(f.request.receipt)).toEqual(before);
    expect(await readFile(f.archive)).toEqual(f.raw);
    expect(faults.writes).toBe(writes);
    await writeFile(f.archive, "corrupted archive", { mode: 0o600 });
    f.calls.splice(0);
    await expect(f.recover()).rejects.toThrow("legacy-archive-invalid");
    expect(await readFile(f.request.receipt)).toEqual(before);
    expect(f.calls).toEqual([]);
  },
);

test.each(["code", "browser"] as const)(
  "real-hash lineage/reason %s binds exact selected bytes",
  async (lane) => {
    const f = await structuralFixture(lane, lane === "code" ? "lineage" : "reason");
    expect(() =>
      recoverReview(f.config, f.request, f.request.session, "invalid-digest", f.transport),
    ).toThrow("invalid-hash");
    for (const sha256 of ["0".repeat(64)]) {
      await expect(
        recoverReview(f.config, f.request, f.request.session, sha256, f.transport),
      ).rejects.toThrow();
      expect(await readFile(f.request.receipt)).toEqual(f.raw);
      await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const changed = Buffer.concat([f.raw, Buffer.from("\n")]);
    await writeFile(f.request.receipt, changed);
    await expect(
      recoverReview(f.config, f.request, f.request.session, f.sha256, f.transport),
    ).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(changed);
    await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toEqual([]);
  },
);

test.each(["code", "browser"] as const)(
  "lineage/reason %s rejects unknown missing and malformed profile data",
  async (lane) => {
    const f = await structuralFixture(lane, lane === "code" ? "lineage" : "reason");
    const changes: Record<string, unknown>[] = [
      { extra: true },
      { repository: "other/repo" },
      { pr: 1061 },
      { lane: lane === "code" ? "browser" : "code" },
      { session: "invalid session" },
      { attempt: "invalid attempt" },
      { H: "bad" },
      { B: false },
      { contractDigest: "bad" },
      { status: "PENDING" },
      { localVerdict: "FAIL" },
      { reviewId: 8 },
      { publicationVerdict: "BLOCKED" },
      { mutationStarted: true },
      { inputDigest: "a".repeat(64) },
      { evidence: [] },
      { evidence: [{}] },
    ];
    if (lane === "code") {
      changes.push(
        { reason: "Mixed browser profile" },
        { head: "bad" },
        { base: false },
        { requestNote: "" },
        { notification: false },
      );
      for (const key of ["prior", "publication", "delta"] as const) {
        const nested = object(f.legacy[key]);
        changes.push({ [key]: { ...nested, extra: true } });
        for (const field of Object.keys(nested)) {
          const missing = { ...nested };
          Reflect.deleteProperty(missing, field);
          changes.push({ [key]: missing });
        }
      }
      const prior = object(f.legacy.prior);
      const publication = object(f.legacy.publication);
      const delta = object(f.legacy.delta);
      changes.push(
        { prior: { ...prior, attempt: "invalid prior" } },
        { prior: { ...prior, H: "bad" } },
        { prior: { ...prior, B: false } },
        { prior: { ...prior, status: "APPROVED" } },
        { prior: { ...prior, localVerdict: "FAIL" } },
        { publication: { ...publication, attempted: true } },
        { publication: { ...publication, result: "" } },
        { publication: { ...publication, appStatus: false } },
        { publication: { ...publication, prerequisite: "" } },
        { delta: { ...delta, commits: [] } },
        { delta: { ...delta, commits: [false] } },
        { delta: { ...delta, from: "" } },
        { delta: { ...delta, kind: false } },
        { delta: { ...delta, conflicts: "" } },
        { delta: { ...delta, checks: false } },
      );
    } else {
      changes.push(
        { publication: { attempted: null } },
        { updatedAt: "bad time" },
        { updatedAt: false },
        { reason: "" },
      );
    }
    assert(Array.isArray(f.legacy.evidence));
    for (const value of f.legacy.evidence) {
      const row = object(value);
      const rows: Record<string, unknown>[] = [{ ...row, extra: true }];
      for (const key of Object.keys(row)) {
        const missing = { ...row };
        Reflect.deleteProperty(missing, key);
        rows.push(missing, { ...row, [key]: false });
      }
      rows.push({ ...row, status: "FAIL" }, { ...row, result: "" });
      if (lane === "browser") rows.push({ ...row, status: "PASS", artifact: "mixed.png" });
      changes.push(...rows.map((row) => ({ evidence: [row] })));
    }
    const variants = changes.map((change) => ({ ...f.legacy, ...change }));
    for (const key of Object.keys(f.legacy)) {
      const missing = { ...f.legacy };
      Reflect.deleteProperty(missing, key);
      variants.push(missing);
    }
    for (const variant of variants) {
      const raw = Buffer.from(JSON.stringify(variant));
      await writeFile(f.request.receipt, raw);
      const writes = faults.writes;
      const sha256 = createHash("sha256").update(raw).digest("hex");
      await expect(
        recoverReview(f.config, f.request, f.request.session, sha256, f.transport),
      ).rejects.toThrow();
      expect(faults.writes).toBe(writes);
      expect(await readFile(f.request.receipt)).toEqual(raw);
      await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(`${f.request.receipt}.legacy-${sha256}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(f.calls).toEqual([]);
  },
);

test.each(["code", "browser"] as const)(
  "lineage/reason %s preserves request identity and retires lineage",
  async (lane) => {
    const f = await structuralFixture(lane, lane === "code" ? "lineage" : "reason");
    const retired =
      lane === "code" ? ["historical-attempt", "historical-prior"] : ["historical-attempt"];
    const otherLane = lane === "code" ? ("browser" as const) : ("code" as const);
    const requests = [
      { ...f.request, repo: "other/repo" },
      { ...f.request, pr: 1061 },
      { ...f.request, lane: otherLane },
      { ...f.request, session: "other-session" },
      ...retired.map((attempt) => ({ ...f.request, attempt })),
    ];
    for (const request of requests) {
      await expect(
        recoverReview(f.config, request, f.request.session, f.sha256, f.transport),
      ).rejects.toThrow();
      expect(await readFile(f.request.receipt)).toEqual(f.raw);
      await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(f.calls).toEqual([]);
    await f.recover();
    const pending = await readFile(f.request.receipt);
    f.calls.splice(0);
    for (const attempt of retired) {
      await expect(
        prepareReview(f.config, { ...f.request, attempt }, f.request.session, f.transport),
      ).rejects.toThrow("attempt-superseded");
      expect(await readFile(f.request.receipt)).toEqual(pending);
    }
    expect(f.calls).toEqual([]);
  },
);

test.each(["code", "browser"] as const)(
  "lineage/reason %s retains preflight and readback checks",
  async (lane) => {
    const f = await structuralFixture(lane, lane === "code" ? "lineage" : "reason");
    for (const mode of ["history", "H"]) {
      f.controls.mode = mode;
      await expect(f.recover()).rejects.toThrow();
      expect(await readFile(f.request.receipt)).toEqual(f.raw);
      await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
    }
    f.controls.mode = "readback";
    expect(await f.recover()).toMatchObject({ status: "BLOCKED", reviewBlocked: true });
    expect(await readJson(f.request.receipt)).toMatchObject({
      status: "BLOCKED",
      localVerdict: null,
      reviewId: null,
      feedbackPublication: { status: "failed" },
    });
    expect(await readFile(f.archive)).toEqual(f.raw);
    const blocked = await readFile(f.request.receipt);
    f.controls.mode = "";
    await expect(f.recover()).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(blocked);
    expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
  },
);

test.each(["code", "browser"] as const)(
  "diagnostic/conclusion %s resets authority and replays exact archives",
  async (lane) => {
    const f = await structuralFixture(lane);
    expect(await f.recover()).toMatchObject({
      status: "PENDING",
      localVerdict: null,
      evidence: [],
      coverage: null,
      reviewId: null,
      inputDigest: null,
      mutationStarted: false,
      supersededAttempts: ["historical-attempt"],
      legacyRecovery: { digest: f.sha256, publication: "unknown" },
      feedbackPublication: { status: "confirmed" },
    });
    expect(await readFile(f.archive)).toEqual(f.raw);
    expect((await stat(f.archive)).mode & 0o077).toBe(0);
    const pending = await readFile(f.request.receipt);
    const writes = faults.writes;
    expect(await f.recover()).toMatchObject({
      status: "PENDING",
      feedbackPublication: { status: "confirmed" },
    });
    expect(faults.writes).toBe(writes);
    expect(await readFile(f.request.receipt)).toEqual(pending);
    expect(f.comments).toHaveLength(1);
    expect(f.calls.filter((row) => row.includes("/reviews?"))).toHaveLength(2);
    f.calls.splice(0);
    const next = { ...f.request, attempt: "next-attempt" };
    expect(await prepareReview(f.config, next, next.session, f.transport)).toMatchObject({
      status: "PENDING",
    });
    expect(f.calls.some((row) => row.includes("/reviews"))).toBe(false);
    await expect(f.recover()).rejects.toThrow();
    expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([undefined, capability, {}])(
  "legacy recovery refuses invalid fresh plan %j before transport",
  async (feedback) => {
    const f = await structuralFixture();
    const writes = faults.writes;
    await expect(
      recoverReview(
        f.config,
        { ...f.request, feedback } as typeof f.request,
        f.request.session,
        f.sha256,
        f.transport,
      ),
    ).rejects.toThrow(feedback === undefined ? "invalid-response" : "invalid-review-feedback");
    expect(await readFile(f.request.receipt)).toEqual(f.raw);
    expect(faults.writes).toBe(writes);
    expect(f.calls).toEqual([]);
  },
);

test("legacy replay confirms feedback transiently and refuses a different prepared plan", async () => {
  const f = await structuralFixture();
  await f.recover();
  const current = (await readJson(f.request.receipt)) as Record<string, unknown>;
  current.feedbackPublication = { status: "unconfirmed" };
  await writeFile(f.request.receipt, JSON.stringify(current));
  const pending = await readFile(f.request.receipt);
  const writes = faults.writes;
  expect(await f.recover()).toMatchObject({
    status: "PENDING",
    feedbackPublication: { status: "confirmed" },
  });
  expect(await readFile(f.request.receipt)).toEqual(pending);
  expect(faults.writes).toBe(writes);
  f.request.feedback = { ...plan, reason: "Different fresh plan" };
  f.calls.splice(0);
  await expect(f.recover()).rejects.toThrow("attempt-conflict");
  expect(await readFile(f.request.receipt)).toEqual(pending);
  expect(await readFile(f.archive)).toEqual(f.raw);
  expect(faults.writes).toBe(writes);
  expect(f.calls).toEqual([]);
});

test.each(["code", "browser"] as const)(
  "real-hash %s accepts changed diagnostic text with a freshly selected digest",
  async (lane) => {
    const f = await structuralFixture(lane);
    const changed = Buffer.from(
      JSON.stringify({
        ...f.legacy,
        ...(lane === "code"
          ? { publication: "New unrelated diagnostic text" }
          : { publicationBlockReason: "Another reason without actor-specific wording" }),
      }),
    );
    await writeFile(f.request.receipt, changed);
    await expect(f.recover()).rejects.toThrow();
    expect(f.calls).toEqual([]);
    const sha256 = createHash("sha256").update(changed).digest("hex");
    expect(
      await recoverReview(f.config, f.request, f.request.session, sha256, f.transport),
    ).toMatchObject({
      status: "PENDING",
      feedbackPublication: { status: "confirmed" },
    });
    expect(await readFile(`${f.request.receipt}.legacy-${sha256}`)).toEqual(changed);
  },
);

test.each(["code", "browser"] as const)(
  "diagnostic/conclusion %s profile independently refuses malformed authority",
  async (lane) => {
    const f = await structuralFixture(lane);
    for (const change of [
      { extra: true },
      { repository: "other/repo" },
      { pr: 7 },
      { lane: lane === "code" ? "browser" : "code" },
      { H: "bad" },
      { B: false },
      { contractDigest: "bad" },
      { reviewId: 8 },
      { status: "PENDING" },
      { mutationStarted: true },
      { inputDigest: "a".repeat(64) },
      { publication: false },
      { evidence: [lane === "code" ? {} : { status: "PASS" }] },
      { updatedAt: false },
      lane === "code" ? { localVerdict: "FAIL" } : { localConclusion: "FAIL" },
      lane === "code" ? { publication: "" } : { publicationBlockReason: "" },
    ]) {
      const raw = Buffer.from(JSON.stringify({ ...f.legacy, ...change }));
      await writeFile(f.request.receipt, raw);
      const sha256 = createHash("sha256").update(raw).digest("hex");
      await expect(
        recoverReview(f.config, f.request, f.request.session, sha256, f.transport),
      ).rejects.toThrow();
      expect(await readFile(f.request.receipt)).toEqual(raw);
      await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(`${f.request.receipt}.legacy-${sha256}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(f.calls).toEqual([]);
  },
);

test.each([
  "wrong-app",
  "installation",
  "permissions",
  "repository",
  "author",
  "closed",
  "H",
  "B",
  "history",
  "malformed-history",
  "later-page",
  "failed-page",
  "second-fresh",
])("legacy preflight %s preserves original and replay bytes", async (mode) => {
  const f = await structuralFixture();
  f.controls.mode = mode;
  await expect(f.recover()).rejects.toThrow();
  expect(await readFile(f.request.receipt)).toEqual(f.raw);
  await expect(stat(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.comments).toHaveLength(0);
  if (["later-page", "failed-page"].includes(mode))
    expect(f.calls.some((row) => row.includes("page=2"))).toBe(true);
  f.controls.mode = "";
  await f.recover();
  const pending = await readFile(f.request.receipt);
  f.controls.mode = mode === "second-fresh" ? "H" : mode;
  const writes = faults.writes;
  await expect(f.recover()).rejects.toThrow();
  expect(await readFile(f.request.receipt)).toEqual(pending);
  expect(faults.writes).toBe(writes);
  expect(await readFile(f.archive)).toEqual(f.raw);
  expect(f.comments).toHaveLength(1);
  expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
});

test.each(["wrong-bytes", "public-mode", "symlink"])(
  "legacy %s archive rejects before network",
  async (mode) => {
    const f = await structuralFixture();
    if (mode === "symlink") await symlink(f.request.receipt, f.archive);
    else {
      await writeFile(f.archive, mode === "wrong-bytes" ? "conflict" : f.raw, {
        mode: 0o600,
      });
      if (mode === "public-mode") {
        await chmod(f.archive, 0o644);
        expect((await stat(f.archive)).mode & 0o777).toBe(0o644);
      }
    }
    const archived = await readFile(f.archive);
    await expect(f.recover()).rejects.toThrow("legacy-archive-invalid");
    expect(await readFile(f.request.receipt)).toEqual(f.raw);
    expect(await readFile(f.archive)).toEqual(archived);
    expect(f.calls).toEqual([]);
  },
);

test.each(["authentication", "history", "fresh", "archive", "stage", "delete"])(
  "legacy detects canonical drift during %s and releases lock",
  async (phase) => {
    const f = await structuralFixture();
    const external = Buffer.from("external owner bytes");
    let changed = false;
    const change = async () => {
      if (changed) return;
      changed = true;
      if (phase === "delete") await rm(f.request.receipt);
      else await writeFile(f.request.receipt, external);
    };
    if (phase === "archive" || phase === "stage") {
      faults.afterWrite = async (path) => {
        if (path.endsWith(phase === "archive" ? "legacy.json" : "receipt.json")) await change();
      };
    } else {
      let reads = 0;
      f.controls.intercept = async (url) => {
        if (url.pathname.endsWith(`/pulls/${f.request.pr}`)) reads++;
        if (
          (phase === "authentication" && url.pathname === "/app") ||
          (["history", "delete"].includes(phase) && url.pathname.endsWith("/reviews")) ||
          (phase === "fresh" && reads === 2)
        )
          await change();
        return undefined;
      };
    }
    await expect(f.recover()).rejects.toThrow();
    expect(changed).toBe(true);
    if (phase === "delete")
      await expect(readFile(f.request.receipt)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(f.request.receipt)).toEqual(external);
    await expect(stat(`${f.request.receipt}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.comments).toHaveLength(0);
    if (["archive", "stage"].includes(phase)) expect(await readFile(f.archive)).toEqual(f.raw);
  },
);

test.each(
  ["confirmed", "failed"].flatMap((outcome) =>
    ["await-replace", "await-delete", "stage-replace", "stage-delete"].map((phase) => ({
      outcome,
      phase,
    })),
  ),
)(
  "legacy conversion $outcome feedback save preserves $phase external state",
  async ({ outcome, phase }) => {
    const f = await structuralFixture();
    const external = Buffer.from("external owner after first rename");
    let changed = false;
    const change = async () => {
      if (changed) return;
      changed = true;
      if (phase.endsWith("delete")) await rm(f.request.receipt);
      else await writeFile(f.request.receipt, external);
    };
    if (outcome === "failed") f.controls.mode = "readback";
    if (phase.startsWith("stage")) {
      let stages = 0;
      faults.afterWrite = async (path) => {
        if (path.endsWith("receipt.json") && ++stages === 2) await change();
      };
    } else
      f.controls.intercept = async (url) => {
        if (url.pathname.includes("/issues/comments/")) await change();
        return undefined;
      };
    await expect(f.recover()).rejects.toThrow("receipt-write");
    expect(changed).toBe(true);
    if (phase.endsWith("delete"))
      await expect(readFile(f.request.receipt)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(f.request.receipt)).toEqual(external);
    expect(await readFile(f.archive)).toEqual(f.raw);
    await expect(stat(`${f.request.receipt}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
  },
);

test.each(["preflight-drift", "announce-drift", "readback"])(
  "legacy replay %s never saves canonical",
  async (mode) => {
    const f = await structuralFixture();
    await f.recover();
    const before = await readFile(f.request.receipt);
    const external = Buffer.from("external replay state");
    let changed = false;
    if (mode === "readback") {
      f.controls.mode = "readback";
      f.comments.splice(0);
    } else
      f.controls.intercept = async (url) => {
        if (
          !changed &&
          (mode === "preflight-drift"
            ? url.pathname.endsWith("/reviews")
            : url.pathname.endsWith("/comments"))
        ) {
          changed = true;
          await writeFile(f.request.receipt, external);
        }
        return undefined;
      };
    const writes = faults.writes;
    await expect(f.recover()).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(mode === "readback" ? before : external);
    expect(faults.writes).toBe(writes + (changed ? 1 : 0));
    expect(await readFile(f.archive)).toEqual(f.raw);
  },
);

test.each([
  "archive-write",
  "archive-link",
  "directory-sync",
  "canonical-write",
  "canonical-sync",
  "readback",
])("legacy %s fault retains archive and ownership rules", async (mode) => {
  const f = await structuralFixture();
  if (mode === "readback" || mode === "canonical-sync") {
    if (mode === "readback") f.controls.mode = mode;
    else faults.recovery = "profile-canonical-sync";
    expect(await f.recover()).toMatchObject({ status: "BLOCKED", reviewBlocked: true });
    await expect(f.recover()).rejects.toThrow();
  } else {
    faults.recovery = mode;
    if (mode === "directory-sync") faults.recovery = "profile-sync";
    await expect(f.recover()).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(f.raw);
    expect(await f.recover()).toMatchObject({ status: "PENDING" });
  }
  expect(await readFile(f.archive)).toEqual(f.raw);
  expect(f.calls.some((row) => row.startsWith("POST") && row.includes("/reviews"))).toBe(false);
});

test.each(["conversion", "replay"])("legacy %s refuses unsafe configured key", async (phase) => {
  const f = await structuralFixture();
  if (phase === "replay") await f.recover();
  const before = await readFile(f.request.receipt);
  f.calls.splice(0);
  await chmod(f.config.code.keyPath, 0o644);
  await expect(f.recover()).rejects.toThrow("unsafe-key-permissions");
  expect(await readFile(f.request.receipt)).toEqual(before);
  expect(f.calls).toEqual([]);
});

test("legacy holds canonical alias lock during preflight and refuses stale owner", async () => {
  const f = await structuralFixture();
  const alias = `${f.config.receiptRoot}-alias`;
  await symlink(f.config.receiptRoot, alias);
  dirs.push(alias);
  let entered!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let didPause = false;
  f.controls.intercept = async (url) => {
    if (!didPause && url.pathname.endsWith("/reviews")) {
      didPause = true;
      entered();
      await held;
    }
    return undefined;
  };
  const first = f.recover();
  await paused;
  try {
    const request = {
      ...f.request,
      receipt: join(alias, ...f.request.repo.split("/"), String(f.request.pr), "code.json"),
    };
    await expect(
      recoverReview(
        { ...f.config, receiptRoot: alias },
        request,
        request.session,
        f.sha256,
        f.transport,
      ),
    ).rejects.toThrow("attempt-locked");
    expect(await readFile(f.request.receipt)).toEqual(f.raw);
  } finally {
    release();
  }
  expect(await first).toMatchObject({ status: "PENDING" });
  const next = { ...f.request, attempt: "next-attempt" };
  await prepareReview(f.config, next, next.session, f.transport);
  const newer = await readFile(f.request.receipt);
  f.calls.splice(0);
  await expect(f.recover()).rejects.toThrow();
  expect(await readFile(f.request.receipt)).toEqual(newer);
  expect(f.calls).toEqual([]);
});

test.each(["evidence", "verdict", "mutation", "review-id", "lineage", "unknown", "raw-current"])(
  "legacy refuses touched PENDING %s before network",
  async (mode) => {
    const f = await structuralFixture();
    await f.recover();
    const current = (await readJson(f.request.receipt)) as Record<string, unknown>;
    if (mode === "evidence")
      current.evidence = [{ status: "passed", evidence: "already assessed" }];
    if (mode === "verdict") current.localVerdict = "APPROVED";
    if (mode === "mutation" || mode === "review-id") {
      current.mutationStarted = true;
      current.inputDigest = "d".repeat(64);
    }
    if (mode === "review-id") current.reviewId = 1;
    if (mode === "lineage") current.supersededAttempts = [];
    if (mode === "unknown") current.status = "UNKNOWN";
    const raw = Buffer.from(JSON.stringify(current));
    await writeFile(f.request.receipt, raw);
    f.calls.splice(0);
    const hash = mode === "raw-current" ? createHash("sha256").update(raw).digest("hex") : f.sha256;
    await expect(
      recoverReview(f.config, f.request, f.request.session, hash, f.transport),
    ).rejects.toThrow();
    expect(await readFile(f.request.receipt)).toEqual(raw);
    expect(await readFile(f.archive)).toEqual(f.raw);
    expect(f.calls).toEqual([]);
  },
);
