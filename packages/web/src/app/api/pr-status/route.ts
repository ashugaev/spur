import { type NextRequest, NextResponse } from "next/server";
import {
  type GitHubGraphQLError,
  getGitHubRateLimitError,
  ghHeaders,
  handleGitHubRateLimit,
} from "@/lib/github-api";
import { glabHeaders, resolveGlabToken } from "@/lib/gitlab-api";
import { type CiStatus, type PrState, parseReviewDecision } from "@/lib/pr-status-shape";
import {
  type PrStatusResponse,
  cacheKeyForCoords,
  cachePrStatusResponse,
  cacheTtlMs,
  errorCacheTtlMs,
  errorResponse,
  extractPrCoords,
  readCachedPrStatus,
  recordSuccessfulPrStatus,
  resetPrStatusCacheForTests,
} from "@/lib/pr-status-store";

type ReviewProvider = "github" | "gitlab";

interface GitHubGraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: {
        state: string;
        isDraft: boolean;
        merged: boolean;
        mergeable: string | null;
        mergeStateStatus: string | null;
        reviewDecision: string | null;
        reviewThreads: { nodes: { isResolved: boolean }[] };
        commits: { nodes: { commit: { statusCheckRollup?: { state: string } } }[] };
      };
    };
  };
  errors?: GitHubGraphQLError[];
}

interface GitLabMergeRequestResponse {
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merged_at?: string | null;
}

interface GitLabDiscussionNote {
  resolvable?: boolean | null;
  resolved?: boolean | null;
}

interface GitLabDiscussion {
  notes: GitLabDiscussionNote[];
}

interface GitLabPipeline {
  status?: string | null;
}

interface GitLabCacheEntry {
  response: PrStatusResponse;
  expiresAt: number;
}

type GitLabLastGoodEntry = {
  state: PrState | null;
  reviewDecision: null;
  ciStatus: CiStatus;
  canMerge: boolean;
  mergeConflict: boolean;
  totalThreads: number;
  unresolvedThreads: number;
  fetchedAt: number;
};

const GQL_QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft merged mergeable mergeStateStatus reviewDecision
      reviewThreads(first:100) { nodes { isResolved } }
      commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

const GITLAB_CACHE_TTL_MS = 120_000;
const GITLAB_ERROR_CACHE_TTL_MS = 60_000;
const gitlabCache = new Map<string, GitLabCacheEntry>();
const gitlabLastGoodCache = new Map<string, GitLabLastGoodEntry>();

function normalizeGitHubState(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function normalizeGitHubCiStatus(rollupState: string | undefined): CiStatus {
  if (rollupState === "SUCCESS") return "success";
  if (rollupState === "FAILURE" || rollupState === "ERROR") return "failure";
  if (rollupState === "PENDING" || rollupState === "EXPECTED") return "pending";
  return null;
}

function gitlabCoords(
  url: string,
): { host: string; hostname: string; projectPath: string; mergeRequestIid: string } | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!match?.[1] || !match?.[2]) return null;
    return {
      host: parsed.origin,
      hostname: parsed.hostname,
      projectPath: match[1],
      mergeRequestIid: match[2],
    };
  } catch {
    return null;
  }
}

function detectProvider(url: string): ReviewProvider | null {
  if (extractPrCoords(url)) return "github";
  if (gitlabCoords(url)) return "gitlab";
  return null;
}

function gitlabCacheKey(coords: {
  host: string;
  projectPath: string;
  mergeRequestIid: string;
}): string {
  return `gitlab:${coords.host}:${coords.projectPath}:${coords.mergeRequestIid}`;
}

function readCachedGitLabStatus(key: string): PrStatusResponse | null {
  const cached = gitlabCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.response;
}

function cacheGitLabStatusResponse(key: string, response: PrStatusResponse, ttlMs: number): void {
  gitlabCache.set(key, { response, expiresAt: Date.now() + ttlMs });
}

function recordSuccessfulGitLabStatus(
  key: string,
  snapshot: Omit<GitLabLastGoodEntry, "fetchedAt">,
): PrStatusResponse {
  const entry: GitLabLastGoodEntry = {
    ...snapshot,
    fetchedAt: Date.now(),
  };
  gitlabLastGoodCache.set(key, entry);
  return {
    state: entry.state,
    reviewDecision: entry.reviewDecision,
    ciStatus: entry.ciStatus,
    canMerge: entry.canMerge,
    mergeConflict: false,
    totalThreads: entry.totalThreads,
    unresolvedThreads: entry.unresolvedThreads,
    fetchedAt: entry.fetchedAt,
    stale: false,
  };
}

function gitlabErrorResponse(key: string, error: string): PrStatusResponse {
  const last = gitlabLastGoodCache.get(key);
  if (last) {
    return {
      state: last.state,
      reviewDecision: last.reviewDecision,
      ciStatus: last.ciStatus,
      canMerge: last.canMerge,
      mergeConflict: false,
      totalThreads: last.totalThreads,
      unresolvedThreads: last.unresolvedThreads,
      fetchedAt: last.fetchedAt,
      stale: true,
      error,
    };
  }
  return {
    state: null,
    reviewDecision: null,
    ciStatus: null,
    canMerge: false,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
    stale: false,
    error,
  };
}

function normalizeGitLabCiStatus(status: string | null | undefined): CiStatus {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "canceled" ||
    normalized === "cancelled" ||
    normalized === "skipped"
  ) {
    return "failure";
  }
  if (
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "created" ||
    normalized === "preparing" ||
    normalized === "waiting_for_resource"
  ) {
    return "pending";
  }
  return null;
}

function normalizeGitLabState(mergeRequest: GitLabMergeRequestResponse): PrState {
  if (mergeRequest.draft === true || mergeRequest.work_in_progress === true) return "draft";
  if (mergeRequest.merged_at) return "merged";
  if (mergeRequest.state === "closed") return "closed";
  return "open";
}

async function handleGitHubStatus(url: string) {
  const coords = extractPrCoords(url);
  if (!coords) {
    return NextResponse.json({ error: "invalid GitHub PR URL" }, { status: 400 });
  }

  const cacheKey = cacheKeyForCoords(coords);
  const cached = readCachedPrStatus(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const rateLimitError = getGitHubRateLimitError();
  if (rateLimitError) {
    return NextResponse.json(errorResponse(cacheKey, rateLimitError));
  }

  try {
    const ghResponse = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...ghHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        query: GQL_QUERY,
        variables: { owner: coords.owner, repo: coords.repo, number: Number(coords.number) },
      }),
      cache: "no-store",
    });

    if (!ghResponse.ok) {
      handleGitHubRateLimit(ghResponse);
      const response = errorResponse(cacheKey, `GitHub API ${ghResponse.status}`);
      cachePrStatusResponse(cacheKey, response, errorCacheTtlMs());
      return NextResponse.json(response);
    }

    const gql = (await ghResponse.json()) as GitHubGraphQLResponse;
    const pr = gql.data?.repository?.pullRequest;
    const gqlError = gql.errors?.length
      ? gql.errors
          .map((entry) => entry.message?.trim())
          .filter(Boolean)
          .join("; ") || "GitHub GraphQL error"
      : undefined;
    handleGitHubRateLimit(ghResponse, gql.errors);

    if (!pr) {
      if (gqlError) {
        const response = errorResponse(cacheKey, gqlError);
        cachePrStatusResponse(cacheKey, response, errorCacheTtlMs());
        return NextResponse.json(response);
      }

      const response = recordSuccessfulPrStatus(cacheKey, {
        state: null,
        reviewDecision: null,
        ciStatus: null,
        canMerge: false,
        mergeConflict: false,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
      cachePrStatusResponse(cacheKey, response, cacheTtlMs());
      return NextResponse.json(response);
    }

    let state: PrState;
    if (pr.isDraft) state = "draft";
    else if (pr.merged) state = "merged";
    else if (pr.state === "CLOSED") state = "closed";
    else state = "open";

    const totalThreads = pr.reviewThreads.nodes.length;
    const unresolvedThreads = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
    const mergeable = normalizeGitHubState(pr.mergeable);
    const mergeStateStatus = normalizeGitHubState(pr.mergeStateStatus);
    const canMerge = state === "open" && mergeable === "MERGEABLE" && mergeStateStatus === "CLEAN";
    const mergeConflict =
      mergeable === "CONFLICTING" ||
      mergeStateStatus === "DIRTY" ||
      mergeStateStatus === "CANNOT_BE_MERGED";

    const response = recordSuccessfulPrStatus(cacheKey, {
      state,
      reviewDecision: parseReviewDecision(pr.reviewDecision),
      ciStatus: normalizeGitHubCiStatus(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
      canMerge,
      mergeConflict,
      totalThreads,
      unresolvedThreads,
    });
    const payload = gqlError ? { ...response, error: gqlError } : response;
    cachePrStatusResponse(cacheKey, payload, gqlError ? errorCacheTtlMs() : cacheTtlMs());
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    const response = errorResponse(cacheKey, message);
    cachePrStatusResponse(cacheKey, response, errorCacheTtlMs());
    return NextResponse.json(response);
  }
}

async function handleGitLabStatus(url: string) {
  const coords = gitlabCoords(url);
  if (!coords) {
    return NextResponse.json({ error: "invalid GitLab merge request URL" }, { status: 400 });
  }

  const cacheKey = gitlabCacheKey(coords);
  const cached = readCachedGitLabStatus(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  if (!resolveGlabToken(coords.hostname)) {
    const response = gitlabErrorResponse(cacheKey, "GitLab auth unavailable");
    cacheGitLabStatusResponse(cacheKey, response, GITLAB_ERROR_CACHE_TTL_MS);
    return NextResponse.json(response);
  }

  try {
    const headers = glabHeaders(coords.hostname);
    const projectPath = encodeURIComponent(coords.projectPath);
    const base = `${coords.host}/api/v4/projects/${projectPath}/merge_requests/${coords.mergeRequestIid}`;
    const [mrResponse, discussionsResponse, pipelinesResponse] = await Promise.all([
      fetch(base, { headers, cache: "no-store" }),
      fetch(`${base}/discussions?per_page=100`, { headers, cache: "no-store" }),
      fetch(`${base}/pipelines?per_page=20`, { headers, cache: "no-store" }),
    ]);

    if (!mrResponse.ok) {
      const response = gitlabErrorResponse(cacheKey, `GitLab API ${mrResponse.status}`);
      cacheGitLabStatusResponse(cacheKey, response, GITLAB_ERROR_CACHE_TTL_MS);
      return NextResponse.json(response);
    }
    if (!discussionsResponse.ok) {
      const response = gitlabErrorResponse(cacheKey, `GitLab API ${discussionsResponse.status}`);
      cacheGitLabStatusResponse(cacheKey, response, GITLAB_ERROR_CACHE_TTL_MS);
      return NextResponse.json(response);
    }
    if (!pipelinesResponse.ok) {
      const response = gitlabErrorResponse(cacheKey, `GitLab API ${pipelinesResponse.status}`);
      cacheGitLabStatusResponse(cacheKey, response, GITLAB_ERROR_CACHE_TTL_MS);
      return NextResponse.json(response);
    }

    const mergeRequest = (await mrResponse.json()) as GitLabMergeRequestResponse;
    const discussions = (await discussionsResponse.json()) as GitLabDiscussion[];
    const pipelines = (await pipelinesResponse.json()) as GitLabPipeline[];
    const totalThreads = discussions.filter((discussion) =>
      discussion.notes.some((note) => note.resolvable === true),
    ).length;
    const unresolvedThreads = discussions.filter((discussion) =>
      discussion.notes.some((note) => note.resolvable === true && note.resolved !== true),
    ).length;

    const response = recordSuccessfulGitLabStatus(cacheKey, {
      state: normalizeGitLabState(mergeRequest),
      reviewDecision: null,
      ciStatus: normalizeGitLabCiStatus(pipelines[0]?.status),
      canMerge: false,
      mergeConflict: false,
      totalThreads,
      unresolvedThreads,
    });
    cacheGitLabStatusResponse(cacheKey, response, GITLAB_CACHE_TTL_MS);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitLab API request failed";
    const response = gitlabErrorResponse(cacheKey, message);
    cacheGitLabStatusResponse(cacheKey, response, GITLAB_ERROR_CACHE_TTL_MS);
    return NextResponse.json(response);
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url parameter is required" }, { status: 400 });
  }

  const provider = detectProvider(url);
  if (!provider) {
    return NextResponse.json({ error: "invalid review URL" }, { status: 400 });
  }

  return provider === "github" ? handleGitHubStatus(url) : handleGitLabStatus(url);
}

if (process.env["NODE_ENV"] === "test") {
  (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"] = (): void => {
    resetPrStatusCacheForTests();
    gitlabCache.clear();
    gitlabLastGoodCache.clear();
  };
}
