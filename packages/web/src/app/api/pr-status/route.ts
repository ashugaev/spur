import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";
import { getGitHubRateLimitError, ghHeaders, handleGitHubRateLimit } from "@/lib/github-api";
import { type CiStatus, type PrInfo, type PrState, isPrInfoShape } from "@/lib/pr-status-shape";

type ReviewProvider = "github" | "gitlab";

interface PrStatusResponse extends PrInfo {
  error?: string;
}

interface GitHubGraphQLResponse {
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

interface CacheEntry {
  response: PrStatusResponse;
  expiresAt: number;
}

type LastGoodEntry = Omit<PrInfo, "stale"> & { fetchedAt: number };

const execFileAsync = promisify(execFile);
const cache = new Map<string, CacheEntry>();
const lastGoodCache = new Map<string, LastGoodEntry>();
const resolvedGitlabTokens = new Map<string, string | null>();
const CACHE_TTL_MS = 120_000;
const ERROR_CACHE_TTL_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 1_000;
const GITHUB_QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
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
      /* best effort */
    }
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
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

function githubCoords(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match?.[1] || !match?.[2] || !match?.[3]) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
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
  if (githubCoords(url)) return "github";
  if (gitlabCoords(url)) return "gitlab";
  return null;
}

function normalizeGitHubCiStatus(rollupState: string | undefined): CiStatus {
  if (rollupState === "SUCCESS") return "success";
  if (rollupState === "FAILURE" || rollupState === "ERROR") return "failure";
  if (rollupState === "PENDING" || rollupState === "EXPECTED") return "pending";
  return null;
}

function normalizeGitlabCiStatus(status: string | null | undefined): CiStatus {
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

function normalizeGitlabState(mergeRequest: GitLabMergeRequestResponse): PrState {
  if (mergeRequest.draft === true || mergeRequest.work_in_progress === true) return "draft";
  if (mergeRequest.merged_at) return "merged";
  if (mergeRequest.state === "closed") return "closed";
  return "open";
}

async function resolveGitlabToken(hostname: string): Promise<string | null> {
  if (resolvedGitlabTokens.has(hostname)) {
    return resolvedGitlabTokens.get(hostname) ?? null;
  }
  const envToken = process.env["GITLAB_TOKEN"] ?? process.env["GLAB_TOKEN"] ?? null;
  if (envToken) {
    resolvedGitlabTokens.set(hostname, envToken);
    return envToken;
  }
  try {
    const { stdout } = await execFileAsync(
      "glab",
      ["auth", "status", "--show-token", "--hostname", hostname],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const token = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    resolvedGitlabTokens.set(hostname, token ?? null);
    return token ?? null;
  } catch {
    resolvedGitlabTokens.set(hostname, null);
    return null;
  }
}

async function fetchGitHubStatus(
  url: string,
): Promise<{ cacheKey: string; response: PrStatusResponse }> {
  const coords = githubCoords(url);
  if (!coords) {
    throw new Error("invalid GitHub PR URL");
  }
  const cacheKey = `github:${coords.owner}/${coords.repo}/${coords.number}`;
  const rateLimitError = getGitHubRateLimitError();
  if (rateLimitError) {
    return { cacheKey, response: errorResponse(cacheKey, rateLimitError) };
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      query: GITHUB_QUERY,
      variables: { owner: coords.owner, repo: coords.repo, number: Number(coords.number) },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    handleGitHubRateLimit(response);
    return { cacheKey, response: errorResponse(cacheKey, `GitHub API ${response.status}`) };
  }

  const gql = (await response.json()) as GitHubGraphQLResponse;
  const pr = gql.data?.repository?.pullRequest;
  const gqlError = gql.errors
    ?.map((entry) => entry.message?.trim())
    .filter(Boolean)
    .join("; ");
  if (!pr) {
    if (gqlError) {
      return { cacheKey, response: errorResponse(cacheKey, gqlError) };
    }
    const entry = recordLastGood(cacheKey, EMPTY_PR_STATUS);
    return { cacheKey, response: freshFromEntry(entry) };
  }

  const entry = recordLastGood(cacheKey, {
    state: pr.isDraft ? "draft" : pr.merged ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    ciStatus: normalizeGitHubCiStatus(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
    totalThreads: pr.reviewThreads.nodes.length,
    unresolvedThreads: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
  });
  return { cacheKey, response: freshFromEntry(entry) };
}

async function fetchGitlabStatus(
  url: string,
): Promise<{ cacheKey: string; response: PrStatusResponse }> {
  const coords = gitlabCoords(url);
  if (!coords) {
    throw new Error("invalid GitLab merge request URL");
  }
  const cacheKey = `gitlab:${coords.host}:${coords.projectPath}:${coords.mergeRequestIid}`;
  const token = await resolveGitlabToken(coords.hostname);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers["PRIVATE-TOKEN"] = token;
  }
  const projectPath = encodeURIComponent(coords.projectPath);
  const base = `${coords.host}/api/v4/projects/${projectPath}/merge_requests/${coords.mergeRequestIid}`;
  const [mrResponse, discussionsResponse, pipelinesResponse] = await Promise.all([
    fetch(base, { headers, cache: "no-store" }),
    fetch(`${base}/discussions?per_page=100`, { headers, cache: "no-store" }),
    fetch(`${base}/pipelines?per_page=20`, { headers, cache: "no-store" }),
  ]);
  if (!mrResponse.ok) {
    return { cacheKey, response: errorResponse(cacheKey, `GitLab API ${mrResponse.status}`) };
  }
  if (!discussionsResponse.ok) {
    return {
      cacheKey,
      response: errorResponse(cacheKey, `GitLab API ${discussionsResponse.status}`),
    };
  }
  if (!pipelinesResponse.ok) {
    return {
      cacheKey,
      response: errorResponse(cacheKey, `GitLab API ${pipelinesResponse.status}`),
    };
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
  const entry = recordLastGood(cacheKey, {
    state: normalizeGitlabState(mergeRequest),
    ciStatus: normalizeGitlabCiStatus(pipelines[0]?.status),
    totalThreads,
    unresolvedThreads,
  });
  return { cacheKey, response: freshFromEntry(entry) };
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

  const resolved = provider === "github" ? githubCoords(url) : gitlabCoords(url);
  const provisionalKey = `${provider}:${JSON.stringify(resolved)}`;
  const cached = cache.get(provisionalKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.response);
  }

  try {
    const result =
      provider === "github" ? await fetchGitHubStatus(url) : await fetchGitlabStatus(url);
    cache.set(provisionalKey, {
      response: result.response,
      expiresAt: Date.now() + (result.response.error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS),
    });
    return NextResponse.json(result.response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : provider === "github"
          ? "GitHub API request failed"
          : "GitLab API request failed";
    const fallbackKey =
      provider === "github"
        ? `github:${JSON.stringify(githubCoords(url))}`
        : `gitlab:${JSON.stringify(gitlabCoords(url))}`;
    const response = errorResponse(fallbackKey, message);
    cache.set(provisionalKey, { response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(response);
  }
}

if (process.env["NODE_ENV"] === "test") {
  (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"] = (): void => {
    cache.clear();
    lastGoodCache.clear();
    resolvedGitlabTokens.clear();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  };
}
