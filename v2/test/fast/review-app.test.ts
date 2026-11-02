import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, writeFile, rm, readFile, symlink, link, stat } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import type * as ReviewState from "../../src/review-state.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  parseConfig,
  parseRequest,
  prepareReview,
  blockReview,
  publishReview,
  recoverReview,
} from "../../src/review-app.js";
import { publishLaneState } from "../../src/review-state.js";
import { execFileAsync } from "../helpers/common.js";
import { readJson } from "../../src/github-app.js";

const dirs: string[] = [];
const faults = vi.hoisted(() => ({ approvedWrite: false, recovery: "", writes: 0 }));
vi.mock("../../src/review-state.js", () => ({ publishLaneState: vi.fn(async () => undefined) }));
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
        typeof args[1] === "string" &&
        args[1].includes('"status": "APPROVED"')
      )
        throw new Error("fixture final save denied");
      return actual.writeFile(...args);
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
test("publishes and reconciles completed approval without a challenger", async () => {
  const f = await lifecycleFixture();
  const { coverage: _coverage, ...input } = f.request;
  const request = parseRequest(input);
  expect(await publishReview(f.config, request, draft.session, f.transport)).toMatchObject({
    status: "APPROVED",
    coverage: null,
  });
  expect(JSON.parse(await readFile(request.receipt, "utf8"))).toMatchObject({
    status: "APPROVED",
    coverage: null,
  });
  expect((await publishReview(f.config, request, draft.session, f.transport)).status).toBe(
    "APPROVED",
  );
  expect(f.posts()).toBe(1);
});
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
    rows: [
      { status: verdict === "APPROVED" ? "passed" : "failed", evidence: "targeted-check.txt" },
    ],
  });
  const result = await publishReview(f.config, request, draft.session, f.transport);
  expect(result.status).toBe(verdict);
  expect(result.localVerdict).toBe(verdict);
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
  const newer = { ...f.request, attempt: "attempt-2", verdict: "CHANGES_REQUESTED" as const };
  await prepareReview(f.config, newer, draft.session);
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
  await expect(blockReview(f.config, f.request, draft.session)).rejects.toThrow(
    "attempt-superseded",
  );
  expect(await blockReview(f.config, newer, draft.session)).toMatchObject({
    status: "BLOCKED",
    reviewBlocked: true,
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
          status: "BLOCKED",
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

test.skipIf(process.platform === "win32").each(["legacy", "pending"])(
  "legacy recovery rejects FIFO archive during %s without hanging the canonical lock",
  async (mode) => {
    const f = await legacyRecoveryFixture();
    if (mode === "pending") {
      await f.recover();
      await rm(f.archive);
    }
    await execFileAsync("mkfifo", ["-m", "600", f.archive], { timeout: 2_000 });
    const child = `
      import { readFile, lstat, access } from "node:fs/promises";
      try {
      const [moduleUrl, configuration, attempt, sha256, archive] = process.argv.slice(1);
      let network = 0;
      globalThis.fetch = async () => { network++; throw new Error("unexpected fixture network"); };
      const { recoverReview } = await import(moduleUrl);
      const request = JSON.parse(attempt);
      const before = await readFile(request.receipt);
      const original = await lstat(archive);
      let rejected = false;
      try { await recoverReview(JSON.parse(configuration), request, request.session, sha256); }
      catch (error) { rejected = error?.category === "legacy-archive-invalid"; }
      const after = await lstat(archive);
      let locked = true;
      try { await access(request.receipt + ".lock"); } catch { locked = false; }
      console.log(JSON.stringify({ rejected, network, locked,
        unchanged: before.equals(await readFile(request.receipt)),
        fifo: after.isFIFO(), sameArchive: original.ino === after.ino && original.dev === after.dev }));
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    `;
    const result = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        child,
        new URL("../../dist/review-app.js", import.meta.url).href,
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
        locked: false,
        unchanged: true,
        fifo: true,
        sameArchive: true,
      }),
    );
    expect(f.posts()).toBe(0);
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
  expect(f.calls.some((call) => call.includes("/reviews"))).toBe(false);
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
  "legacy recovery G1 %s preserves converted PENDING bytes",
  async (mode) => {
    const f = await legacyRecoveryFixture();
    await f.recover();
    const current = await readFile(f.request.receipt);
    expect(createHash("sha256").update(current).digest("hex")).not.toBe(f.sha256);
    const writes = faults.writes;
    if (mode === "announcement-failure") {
      f.comments.splice(0);
      f.failReadback();
      await expect(f.recover()).rejects.toThrow("state-publication-mismatch");
    } else expect(await f.recover()).toMatchObject({ status: "PENDING" });
    expect(faults.writes).toBe(writes);
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
    expect(f.calls).toEqual([]);
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
      await publishReview(f.config, { ...f.request, verdict }, f.request.session, f.transport),
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
