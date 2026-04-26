import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";

type PrState = "draft" | "open" | "merged" | "closed";
type CiStatus = "success" | "failure" | "pending" | null;
type ReviewProvider = "github" | "gitlab";

interface PrStatusResponse {
  state: PrState;
  ciStatus: CiStatus;
  totalThreads: number;
  unresolvedThreads: number;
}

interface CacheEntry {
  response: PrStatusResponse | null;
  error?: string;
  expiresAt: number;
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

const execFileAsync = promisify(execFile);
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 120_000;
const ERROR_CACHE_TTL_MS = 60_000;
let githubRateLimitResetAt = 0;

const GITHUB_GQL_QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft merged
      reviewThreads(first:100) { nodes { isResolved } }
      commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

function githubCoords(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return match?.[1] && match?.[2] && match?.[3]
    ? { owner: match[1], repo: match[2], number: match[3] }
    : null;
}

function gitlabCoords(
  url: string,
): { host: string; projectPath: string; mergeRequestIid: string } | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!match?.[1] || !match?.[2]) return null;
    return {
      host: parsed.origin,
      projectPath: match[1],
      mergeRequestIid: match[2],
    };
  } catch {
    return null;
  }
}

function detectProvider(url: string): ReviewProvider | null {
  return githubCoords(url) ? "github" : gitlabCoords(url) ? "gitlab" : null;
}

let resolvedGithubToken: string | null = null;
let githubTokenResolved = false;
const resolvedGitlabTokens = new Map<string, string | null>();

async function resolveGithubToken(): Promise<string | null> {
  if (githubTokenResolved) return resolvedGithubToken;
  githubTokenResolved = true;
  resolvedGithubToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? null;
  if (resolvedGithubToken) return resolvedGithubToken;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    resolvedGithubToken = stdout.trim() || null;
  } catch {
    resolvedGithubToken = null;
  }
  return resolvedGithubToken;
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
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const token = lines.at(-1) ?? null;
    resolvedGitlabTokens.set(hostname, token);
    return token;
  } catch {
    resolvedGitlabTokens.set(hostname, null);
    return null;
  }
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

async function fetchGithubStatus(url: string): Promise<{ cacheKey: string; response: PrStatusResponse }> {
  const coords = githubCoords(url);
  if (!coords) {
    throw new Error("invalid GitHub PR URL");
  }
  if (Date.now() < githubRateLimitResetAt) {
    const wait = Math.ceil((githubRateLimitResetAt - Date.now()) / 1000);
    throw new Error(`GitHub rate limit — retry in ${wait}s`);
  }

  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const token = await resolveGithubToken();
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      query: GITHUB_GQL_QUERY,
      variables: { owner: coords.owner, repo: coords.repo, number: Number(coords.number) },
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const reset = response.headers.get("x-ratelimit-reset");
      githubRateLimitResetAt = reset ? Number(reset) * 1000 : Date.now() + 60_000;
    }
    throw new Error(`GitHub API ${response.status}`);
  }
  const gql = (await response.json()) as GitHubGraphQLResponse;
  const pr = gql.data?.repository?.pullRequest;
  if (!pr) {
    throw new Error("PR not found");
  }

  let state: PrState;
  if (pr.isDraft) state = "draft";
  else if (pr.merged) state = "merged";
  else if (pr.state === "CLOSED") state = "closed";
  else state = "open";

  let ciStatus: CiStatus = null;
  const rollupState = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (rollupState === "SUCCESS") ciStatus = "success";
  else if (rollupState === "FAILURE" || rollupState === "ERROR") ciStatus = "failure";
  else if (rollupState === "PENDING" || rollupState === "EXPECTED") ciStatus = "pending";

  return {
    cacheKey: `github:${coords.owner}/${coords.repo}/${coords.number}`,
    response: {
      state,
      ciStatus,
      totalThreads: pr.reviewThreads.nodes.length,
      unresolvedThreads: pr.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    },
  };
}

async function fetchGitlabStatus(url: string): Promise<{ cacheKey: string; response: PrStatusResponse }> {
  const coords = gitlabCoords(url);
  if (!coords) {
    throw new Error("invalid GitLab merge request URL");
  }
  const token = await resolveGitlabToken(new URL(coords.host).hostname);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers["PRIVATE-TOKEN"] = token;
  }
  const projectPath = encodeURIComponent(coords.projectPath);
  const mrBase = `${coords.host}/api/v4/projects/${projectPath}/merge_requests/${coords.mergeRequestIid}`;
  const [mrResponse, discussionsResponse, pipelinesResponse] = await Promise.all([
    fetch(mrBase, { headers, cache: "no-store" }),
    fetch(`${mrBase}/discussions?per_page=100`, { headers, cache: "no-store" }),
    fetch(`${mrBase}/pipelines?per_page=20`, { headers, cache: "no-store" }),
  ]);
  if (!mrResponse.ok) {
    throw new Error(`GitLab API ${mrResponse.status}`);
  }
  if (!discussionsResponse.ok) {
    throw new Error(`GitLab API ${discussionsResponse.status}`);
  }
  if (!pipelinesResponse.ok) {
    throw new Error(`GitLab API ${pipelinesResponse.status}`);
  }

  const mergeRequest = (await mrResponse.json()) as GitLabMergeRequestResponse;
  const discussions = (await discussionsResponse.json()) as GitLabDiscussion[];
  const pipelines = (await pipelinesResponse.json()) as GitLabPipeline[];
  const threadCount = discussions.filter((discussion) =>
    discussion.notes.some((note) => note.resolvable === true),
  );
  const unresolvedThreads = threadCount.filter((discussion) =>
    discussion.notes.some((note) => note.resolvable === true && note.resolved !== true),
  ).length;

  return {
    cacheKey: `gitlab:${coords.host}:${coords.projectPath}:${coords.mergeRequestIid}`,
    response: {
      state: normalizeGitlabState(mergeRequest),
      ciStatus: normalizeGitlabCiStatus(pipelines[0]?.status),
      totalThreads: threadCount.length,
      unresolvedThreads,
    },
  };
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

  const cacheKeyPrefix = provider === "github" ? githubCoords(url) : gitlabCoords(url);
  const provisionalKey = `${provider}:${JSON.stringify(cacheKeyPrefix)}`;
  const cached = cache.get(provisionalKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) {
      return NextResponse.json(
        { error: cached.error },
        { status: cached.error.includes("not found") ? 404 : cached.error.includes("rate limit") ? 429 : 502 },
      );
    }
    return NextResponse.json(cached.response);
  }

  try {
    const resolved =
      provider === "github" ? await fetchGithubStatus(url) : await fetchGitlabStatus(url);
    cache.set(provisionalKey, {
      response: resolved.response,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return NextResponse.json(resolved.response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : provider === "github"
          ? "GitHub API request failed"
          : "GitLab API request failed";
    cache.set(provisionalKey, {
      response: null,
      error: message,
      expiresAt: Date.now() + ERROR_CACHE_TTL_MS,
    });
    const status = message.includes("not found") ? 404 : message.includes("rate limit") ? 429 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
