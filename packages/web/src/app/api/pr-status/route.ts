import { type NextRequest, NextResponse } from "next/server";

type PrState = "draft" | "open" | "merged" | "closed";
type CiStatus = "success" | "failure" | "pending" | null;

interface PrStatusResponse {
  state: PrState;
  ciStatus: CiStatus;
  unresolvedThreads: number;
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
}

interface CacheEntry {
  response: PrStatusResponse | null;
  error?: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 120_000;
const ERROR_CACHE_TTL_MS = 60_000;

let rateLimitResetAt = 0;

const GQL_QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft merged
      reviewThreads(first:100) { nodes { isResolved } }
      commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

function extractPrCoords(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

let resolvedToken: string | null = null;
let tokenResolved = false;

function resolveGhToken(): string | null {
  if (tokenResolved) return resolvedToken;
  tokenResolved = true;
  resolvedToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? null;
  if (resolvedToken) return resolvedToken;
  // Fallback: read from gh CLI auth
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("node:child_process") as {
      execSync: (cmd: string, opts: { encoding: string }) => string;
    };
    resolvedToken = cp.execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim() || null;
  } catch {
    resolvedToken = null;
  }
  return resolvedToken;
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const token = resolveGhToken();
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function handleRateLimit(response: Response): void {
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset) {
      rateLimitResetAt = Number(reset) * 1000;
    } else {
      rateLimitResetAt = Date.now() + 60_000;
    }
  }
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
    if (cached.error) {
      return NextResponse.json({ error: cached.error }, { status: 502 });
    }
    return NextResponse.json(cached.response);
  }

  // Rate limit backoff
  if (Date.now() < rateLimitResetAt) {
    const wait = Math.ceil((rateLimitResetAt - Date.now()) / 1000);
    return NextResponse.json({ error: `GitHub rate limit — retry in ${wait}s` }, { status: 429 });
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
      handleRateLimit(ghResponse);
      const errorMsg = `GitHub API ${ghResponse.status}`;
      cache.set(cacheKey, {
        response: null,
        error: errorMsg,
        expiresAt: Date.now() + ERROR_CACHE_TTL_MS,
      });
      return NextResponse.json({ error: errorMsg }, { status: 502 });
    }

    const gql = (await ghResponse.json()) as GithubGraphQLResponse;
    const pr = gql.data?.repository?.pullRequest;
    if (!pr) {
      cache.set(cacheKey, {
        response: null,
        error: "PR not found",
        expiresAt: Date.now() + ERROR_CACHE_TTL_MS,
      });
      return NextResponse.json({ error: "PR not found" }, { status: 404 });
    }

    let state: PrState;
    if (pr.isDraft) state = "draft";
    else if (pr.merged) state = "merged";
    else if (pr.state === "CLOSED") state = "closed";
    else state = "open";

    const unresolvedThreads = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length;

    let ciStatus: CiStatus = null;
    const rollupState = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
    if (rollupState === "SUCCESS") ciStatus = "success";
    else if (rollupState === "FAILURE" || rollupState === "ERROR") ciStatus = "failure";
    else if (rollupState === "PENDING" || rollupState === "EXPECTED") ciStatus = "pending";

    const response: PrStatusResponse = { state, ciStatus, unresolvedThreads };
    cache.set(cacheKey, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    cache.set(cacheKey, {
      response: null,
      error: message,
      expiresAt: Date.now() + ERROR_CACHE_TTL_MS,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
