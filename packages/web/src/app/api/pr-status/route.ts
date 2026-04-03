import { type NextRequest, NextResponse } from "next/server";

export type PrState = "draft" | "open" | "merged" | "closed";
export type CiStatus = "success" | "failure" | "pending" | null;

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
  state: PrState;
  ciStatus: CiStatus;
  reviewComments: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

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
    return NextResponse.json({
      state: cached.state,
      ciStatus: cached.ciStatus,
      reviewComments: cached.reviewComments,
    } satisfies PrStatusResponse);
  }

  const apiUrl = `https://api.github.com/repos/${coords.owner}/${coords.repo}/pulls/${coords.number}`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const ghToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (ghToken) {
    headers["authorization"] = `Bearer ${ghToken}`;
  }

  try {
    const ghResponse = await fetch(apiUrl, { headers, cache: "no-store" });
    if (!ghResponse.ok) {
      return NextResponse.json(
        { error: `GitHub API returned ${ghResponse.status}` },
        { status: 502 },
      );
    }

    const data = (await ghResponse.json()) as GithubPullResponse;
    let state: PrState;
    if (data.draft) {
      state = "draft";
    } else if (data.merged) {
      state = "merged";
    } else if (data.state === "closed") {
      state = "closed";
    } else {
      state = "open";
    }

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
        }
      } catch {
        // Non-critical — leave ciStatus as null.
      }
    }

    cache.set(cacheKey, {
      state,
      ciStatus,
      reviewComments,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return NextResponse.json({
      state,
      ciStatus,
      reviewComments,
    } satisfies PrStatusResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
