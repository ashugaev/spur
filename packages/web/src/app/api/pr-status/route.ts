import { type NextRequest, NextResponse } from "next/server";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { type CiStatus, type PrInfo, type PrState, isPrInfoShape } from "@/lib/pr-status-shape";

interface PrStatusResponse extends PrInfo {
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

type LastGoodEntry = Omit<PrInfo, "stale"> & { fetchedAt: number };

const cache = new Map<string, CacheEntry>();
const lastGoodCache = new Map<string, LastGoodEntry>();
const CACHE_TTL_MS = 120_000;
const ERROR_CACHE_TTL_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 1_000;

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

const EMPTY_PR_STATUS: Omit<PrStatusResponse, "error"> = {
  state: null,
  ciStatus: null,
  totalThreads: 0,
  unresolvedThreads: 0,
};

function persistFilePath(): string {
  const stateDir = process.env["SPUR_STATE_DIR"];
  if (stateDir) {
    return path.join(stateDir, "spur-pr-status-cache.json");
  }
  return path.join(os.tmpdir(), "spur-pr-status-cache.json");
}

let persistTimer: NodeJS.Timeout | null = null;

function isLastGoodEntry(value: unknown): value is LastGoodEntry {
  return isPrInfoShape(value) && typeof (value as { fetchedAt?: unknown }).fetchedAt === "number";
}

function loadPersistedLastGood(): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(persistFilePath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isLastGoodEntry(value)) lastGoodCache.set(key, value);
    }
  } catch {
    /* file missing, unreadable, or malformed */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const filePath = persistFilePath();
      mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      const data = Object.fromEntries(lastGoodCache.entries());
      writeFileSync(tmp, JSON.stringify(data), "utf-8");
      renameSync(tmp, filePath);
    } catch {
      /* best-effort */
    }
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer && typeof persistTimer.unref === "function") persistTimer.unref();
}

loadPersistedLastGood();

function recordLastGood(key: string, snapshot: Omit<LastGoodEntry, "fetchedAt">): LastGoodEntry {
  const entry: LastGoodEntry = { ...snapshot, fetchedAt: Date.now() };
  lastGoodCache.set(key, entry);
  schedulePersist();
  return entry;
}

function freshFromEntry(entry: LastGoodEntry): PrStatusResponse {
  return {
    state: entry.state,
    ciStatus: entry.ciStatus,
    totalThreads: entry.totalThreads,
    unresolvedThreads: entry.unresolvedThreads,
    fetchedAt: entry.fetchedAt,
    stale: false,
  };
}

function errorResponse(key: string, error: string): PrStatusResponse {
  const last = lastGoodCache.get(key);
  if (last) return { ...freshFromEntry(last), stale: true, error };
  return { ...EMPTY_PR_STATUS, stale: false, error };
}

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
    resolvedToken = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim() || null;
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
    return NextResponse.json(cached.response);
  }

  // Rate limit backoff
  if (Date.now() < rateLimitResetAt) {
    const wait = Math.ceil((rateLimitResetAt - Date.now()) / 1000);
    const response = errorResponse(cacheKey, `GitHub rate limit — retry in ${wait}s`);
    return NextResponse.json(response);
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
      const response = errorResponse(cacheKey, `GitHub API ${ghResponse.status}`);
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
      if (gqlError) {
        const response = errorResponse(cacheKey, gqlError);
        cache.set(cacheKey, { response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
        return NextResponse.json(response);
      }
      const entry = recordLastGood(cacheKey, EMPTY_PR_STATUS);
      const response = freshFromEntry(entry);
      cache.set(cacheKey, { response, expiresAt: Date.now() + CACHE_TTL_MS });
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

    const entry = recordLastGood(cacheKey, { state, ciStatus, totalThreads, unresolvedThreads });
    const response = freshFromEntry(entry);
    cache.set(cacheKey, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    const response = errorResponse(cacheKey, message);
    cache.set(cacheKey, { response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(response);
  }
}

if (process.env["NODE_ENV"] === "test") {
  (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"] = (): void => {
    cache.clear();
    lastGoodCache.clear();
    rateLimitResetAt = 0;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  };
}
