import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile, symlink, link, stat } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  parseConfig,
  parseRequest,
  prepareReview,
  blockReview,
  publishReview,
} from "../../src/review-app.js";

const dirs: string[] = [];
const faults = vi.hoisted(() => ({ approvedWrite: false }));
vi.mock("../../src/review-state.js", () => ({ publishLaneState: vi.fn(async () => undefined) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (
        faults.approvedWrite &&
        typeof args[1] === "string" &&
        args[1].includes('"status": "APPROVED"')
      )
        throw new Error("fixture final save denied");
      return actual.writeFile(...args);
    },
  };
});
afterEach(async () => {
  faults.approvedWrite = false;
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
test("blocks absent independent challenge and failed approval rows", () => {
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

async function lifecycleFixture() {
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
  let deny = false,
    posts = 0;
  let pause: (() => Promise<void>) | undefined;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
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
    if (options?.method === "POST") {
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
    return Response.json(history.find((review) => String(review.id) === path.split("/").at(-1)));
  };
  return {
    dir,
    config,
    request,
    history,
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
