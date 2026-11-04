// @vitest-environment node
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({
  realpathSync: (path: string) => path,
  readFileSync: () => {
    throw new Error("owned cache absent");
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock("../../server/spur-instance", () => ({
  readSpurInstanceRuntimeConfig: () => ({ configPath: "/owned/config.yaml" }),
}));
import { GET } from "@/app/api/pr-status/route";
import {
  recordGitHubPrAbsent,
  recordGitHubPrError,
  recordGitHubPrNode,
  type GitHubPrNode,
} from "@/lib/github-pr-status";
import { resetPrStatusCacheForTests } from "@/lib/pr-status-store";

afterEach(() => {
  resetPrStatusCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const instance = createHash("sha256").update("/owned/config.yaml").digest("hex");
const request = (identity = instance) =>
  new NextRequest(
    `http://localhost/api/pr-status?${new URLSearchParams({ cacheOnly: "1", instance: identity, url: "https://github.com/acme/repo/pull/1" })}`,
  );
const node: GitHubPrNode = {
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  reviewThreads: { nodes: [{ isResolved: true }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
};

it("reads unknown without fetching and rejects an unrelated instance before cache access", async () => {
  const fetch = vi.fn(() => {
    throw new Error("external fetch forbidden");
  });
  vi.stubGlobal("fetch", fetch);
  expect(await (await GET(request())).json()).toMatchObject({
    status: "unknown",
    info: null,
    ready: null,
    stale: null,
    refreshed: false,
    source: "spur-web-pr-status-cache",
  });
  expect((await GET(request("wrong"))).status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [{}, "open", "approved", true, false],
  [{ isDraft: true }, "draft", "approved", false, false],
  [{ merged: true }, "merged", "approved", false, false],
  [{ state: "CLOSED" }, "closed", "approved", false, false],
  [{ reviewDecision: "CHANGES_REQUESTED" }, "open", "changes_requested", false, false],
  [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, "open", "approved", false, true],
] as const)(
  "exposes existing extraction and icon semantics: %j",
  async (change, state, reviewDecision, ready, mergeConflict) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    recordGitHubPrNode("acme/repo/1", { ...node, ...change });
    const response = await (await GET(request())).json();
    expect(response).toMatchObject({
      status: "available",
      info: {
        state,
        reviewDecision,
        mergeConflict,
        ciStatus: "success",
        totalThreads: 1,
        unresolvedThreads: 0,
        fetchedAt: expect.any(Number),
      },
      ready,
      stale: false,
      ageMs: expect.any(Number),
      refreshed: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("exposes last-good staleness and provider errors without refreshing or losing fetchedAt", async () => {
  vi.useFakeTimers();
  const snapshot = recordGitHubPrNode("acme/repo/1", node);
  vi.advanceTimersByTime(120001);
  expect(await (await GET(request())).json()).toMatchObject({
    status: "available",
    stale: true,
    info: { fetchedAt: snapshot.fetchedAt },
    ageMs: 120001,
  });
  recordGitHubPrError("acme/repo/1", "provider unavailable");
  expect(await (await GET(request())).json()).toMatchObject({
    stale: true,
    info: { error: "provider unavailable", fetchedAt: snapshot.fetchedAt },
  });
});
it("preserves extracted absent PR and unknown fields", async () => {
  recordGitHubPrAbsent("acme/repo/1");
  expect(await (await GET(request())).json()).toMatchObject({
    status: "unknown",
    info: { state: null, ciStatus: null, reviewDecision: null },
    ready: null,
  });
});

it.each([
  ["SUCCESS", "success"],
  ["FAILURE", "failure"],
  ["PENDING", "pending"],
  ["UNKNOWN", null],
] as const)("preserves extracted CI rollup %s", async (state, ciStatus) => {
  recordGitHubPrNode("acme/repo/1", {
    ...node,
    commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
    reviewThreads: { nodes: [{ isResolved: false }] },
  });
  expect(await (await GET(request())).json()).toMatchObject({
    info: { ciStatus, totalThreads: 1, unresolvedThreads: 1 },
    ready: false,
    refreshed: false,
  });
});

it("inspects GitLab's existing process-local cache without credentials or fetch", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const gitlab = new NextRequest(
    `http://localhost/api/pr-status?${new URLSearchParams({ cacheOnly: "1", instance, url: "https://gitlab.example/acme/repo/-/merge_requests/1" })}`,
  );
  expect(await (await GET(gitlab)).json()).toMatchObject({
    provider: "gitlab",
    status: "unknown",
    info: null,
    refreshed: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});
