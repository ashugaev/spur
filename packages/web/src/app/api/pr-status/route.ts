import { type NextRequest, NextResponse } from "next/server";
import { getGitHubRateLimitError, ghHeaders, handleGitHubRateLimit } from "@/lib/github-api";

type PrState = "draft" | "open" | "merged" | "closed";
type CiStatus = "success" | "failure" | "pending" | null;

interface PrStatusResponse {
  state: PrState | null;
  ciStatus: CiStatus;
  totalThreads: number;
  unresolvedThreads: number;
  error?: string;
}

interface GithubGraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: {
        state: string;
        isDraft: boolean;
        merged: boolean;
        reviewThreads: { nodes: { isResolved: boolean }[] };
        commits: { nodes: { commit: { statusCheckRollup?: { state: string } } }[] };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

interface CacheEntry {
  response: PrStatusResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 120_000;
const ERROR_CACHE_TTL_MS = 60_000;

const GQL_QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft merged
      reviewThreads(first:100) { nodes { isResolved } }
      commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

const EMPTY_PR_STATUS: Omit<PrStatusResponse, "error"> = {
  state: null,
  ciStatus: null,
  totalThreads: 0,
  unresolvedThreads: 0,
};

function errorResponse(error: string): PrStatusResponse {
  return { ...EMPTY_PR_STATUS, error };
}

function extractPrCoords(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
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

  const cacheKey = `${coords.owner}/${coords.repo}/${coords.number}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.response);
  }

  // Rate limit backoff
  const rateLimitError = getGitHubRateLimitError();
  if (rateLimitError) {
    return NextResponse.json(errorResponse(rateLimitError));
  }

  const headers = ghHeaders();

  try {
    const ghResponse = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        query: GQL_QUERY,
        variables: { owner: coords.owner, repo: coords.repo, number: Number(coords.number) },
      }),
      cache: "no-store",
    });

    if (!ghResponse.ok) {
      handleGitHubRateLimit(ghResponse);
      const response = errorResponse(`GitHub API ${ghResponse.status}`);
      cache.set(cacheKey, { response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
      return NextResponse.json(response);
    }

    const gql = (await ghResponse.json()) as GithubGraphQLResponse;
    const pr = gql.data?.repository?.pullRequest;
    const gqlError = gql.errors
      ?.map((entry) => entry.message?.trim())
      .filter(Boolean)
      .join("; ");
    if (!pr) {
      const response = gqlError ? errorResponse(gqlError) : EMPTY_PR_STATUS;
      cache.set(cacheKey, {
        response,
        expiresAt: Date.now() + (gqlError ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS),
      });
      return NextResponse.json(response);
    }

    let state: PrState;
    if (pr.isDraft) state = "draft";
    else if (pr.merged) state = "merged";
    else if (pr.state === "CLOSED") state = "closed";
    else state = "open";

    const totalThreads = pr.reviewThreads.nodes.length;
    const unresolvedThreads = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length;

    let ciStatus: CiStatus = null;
    const rollupState = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
    if (rollupState === "SUCCESS") ciStatus = "success";
    else if (rollupState === "FAILURE" || rollupState === "ERROR") ciStatus = "failure";
    else if (rollupState === "PENDING" || rollupState === "EXPECTED") ciStatus = "pending";

    const response: PrStatusResponse = { state, ciStatus, totalThreads, unresolvedThreads };
    cache.set(cacheKey, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    const response = errorResponse(message);
    cache.set(cacheKey, { response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(response);
  }
}
