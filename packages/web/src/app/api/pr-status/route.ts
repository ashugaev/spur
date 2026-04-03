import { type NextRequest, NextResponse } from "next/server";

type PrState = "draft" | "open" | "merged" | "closed";
type CiStatus = "success" | "failure" | "pending" | null;

interface PrStatusResponse {
  state: PrState;
  ciStatus: CiStatus;
  reviewComments: number;
}

interface GithubPullResponse {
  state: string;
  draft?: boolean;
  merged?: boolean;
  review_comments?: number;
  head?: { sha?: string };
}

interface GithubCombinedStatus {
  state?: string;
}

interface CacheEntry {
  response: PrStatusResponse | null;
  error?: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 120_000; // 2 min
const ERROR_CACHE_TTL_MS = 60_000; // cache errors for 1 min to avoid hammering

let rateLimitResetAt = 0;

function extractPrCoords(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const ghToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (ghToken) {
    headers["authorization"] = `Bearer ${ghToken}`;
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
    const apiUrl = `https://api.github.com/repos/${coords.owner}/${coords.repo}/pulls/${coords.number}`;
    const ghResponse = await fetch(apiUrl, { headers, cache: "no-store" });

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

    const data = (await ghResponse.json()) as GithubPullResponse;
    let state: PrState;
    if (data.draft) state = "draft";
    else if (data.merged) state = "merged";
    else if (data.state === "closed") state = "closed";
    else state = "open";

    const reviewComments = typeof data.review_comments === "number" ? data.review_comments : 0;

    let ciStatus: CiStatus = null;
    const headSha = data.head?.sha;
    if (headSha) {
      try {
        const statusUrl = `https://api.github.com/repos/${coords.owner}/${coords.repo}/commits/${headSha}/status`;
        const statusRes = await fetch(statusUrl, { headers, cache: "no-store" });
        if (statusRes.ok) {
          const statusData = (await statusRes.json()) as GithubCombinedStatus;
          if (statusData.state === "success") ciStatus = "success";
          else if (statusData.state === "failure" || statusData.state === "error")
            ciStatus = "failure";
          else if (statusData.state === "pending") ciStatus = "pending";
        } else {
          handleRateLimit(statusRes);
        }
      } catch {
        // Non-critical
      }
    }

    const response: PrStatusResponse = { state, ciStatus, reviewComments };
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
