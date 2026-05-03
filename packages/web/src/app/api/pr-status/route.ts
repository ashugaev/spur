import { type NextRequest, NextResponse } from "next/server";
import { getGitHubRateLimitError, ghHeaders, handleGitHubRateLimit } from "@/lib/github-api";
import { type CiStatus, type PrState, parseReviewDecision } from "@/lib/pr-status-shape";
import {
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

interface GithubGraphQLResponse {
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
  errors?: Array<{ message?: string }>;
}

const GQL_QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft merged mergeable mergeStateStatus reviewDecision
      reviewThreads(first:100) { nodes { isResolved } }
      commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

function normalizeGitHubState(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url parameter is required" }, { status: 400 });
  }

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

    const gql = (await ghResponse.json()) as GithubGraphQLResponse;
    const pr = gql.data?.repository?.pullRequest;
    const gqlError = gql.errors
      ?.map((entry) => entry.message?.trim())
      .filter(Boolean)
      .join("; ");

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
    const canMerge =
      state === "open" &&
      normalizeGitHubState(pr.mergeable) === "MERGEABLE" &&
      normalizeGitHubState(pr.mergeStateStatus) === "CLEAN";

    let ciStatus: CiStatus = null;
    const rollupState = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
    if (rollupState === "SUCCESS") ciStatus = "success";
    else if (rollupState === "FAILURE" || rollupState === "ERROR") ciStatus = "failure";
    else if (rollupState === "PENDING" || rollupState === "EXPECTED") ciStatus = "pending";

    const response = recordSuccessfulPrStatus(cacheKey, {
      state,
      reviewDecision: parseReviewDecision(pr.reviewDecision),
      ciStatus,
      canMerge,
      totalThreads,
      unresolvedThreads,
    });
    cachePrStatusResponse(cacheKey, response, cacheTtlMs());
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    const response = errorResponse(cacheKey, message);
    cachePrStatusResponse(cacheKey, response, errorCacheTtlMs());
    return NextResponse.json(response);
  }
}

if (process.env["NODE_ENV"] === "test") {
  (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"] = (): void => {
    resetPrStatusCacheForTests();
  };
}
