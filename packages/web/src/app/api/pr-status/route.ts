import { type NextRequest, NextResponse } from "next/server";

export type PrState = "draft" | "open" | "merged" | "closed";

interface PrStatusResponse {
  state: PrState;
}

interface GithubPullResponse {
  state: string;
  draft?: boolean;
  merged?: boolean;
}

const cache = new Map<string, { state: PrState; expiresAt: number }>();
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
    return NextResponse.json({ state: cached.state } satisfies PrStatusResponse);
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

    cache.set(cacheKey, { state, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ state } satisfies PrStatusResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
