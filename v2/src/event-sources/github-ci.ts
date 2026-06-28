import { gh } from "../gh.js";
import {
  GITHUB_CI_RUN_COMPLETED_EVENT,
  type GitHubCiSourceConfig,
  type WorkItemEventData,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import {
  emitWorkItemBacklog,
  startWorkItemPoller,
  type WorkItemCandidate,
} from "./work-item-backlog.js";

const RUN_LIST_LIMIT = 100;

interface GitHubRunItem {
  databaseId: number;
  conclusion: string | null;
  headBranch: string;
  workflowName: string;
  url: string;
  status: string;
}

function isGitHubRunItem(value: unknown): value is GitHubRunItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item["databaseId"] === "number" &&
    (item["conclusion"] === null || typeof item["conclusion"] === "string") &&
    typeof item["headBranch"] === "string" &&
    typeof item["workflowName"] === "string" &&
    typeof item["url"] === "string" &&
    typeof item["status"] === "string"
  );
}

function parseGitHubRunItems(raw: string): GitHubRunItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("gh run list returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("gh run list returned a non-array payload");
  }
  return parsed.filter(isGitHubRunItem);
}

async function pollRuns(
  deps: SourceStartDeps<GitHubCiSourceConfig>,
  seen: Set<string>,
): Promise<void> {
  const out = await gh(
    process.cwd(),
    "run",
    "list",
    "--repo",
    deps.config.repo,
    "--json",
    "databaseId,conclusion,headBranch,workflowName,url,status",
    "--limit",
    String(RUN_LIST_LIMIT),
  );
  const runs = parseGitHubRunItems(out);
  const repo = deps.config.repo;
  const candidates: WorkItemCandidate<WorkItemEventData>[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    if (deps.config.conclusion === "success" && run.conclusion !== "success") continue;
    if (deps.config.branch !== undefined && run.headBranch !== deps.config.branch) continue;
    const data: WorkItemEventData = {
      externalId: `${repo}#run-${run.databaseId}`,
      url: run.url,
      number: run.databaseId,
      title: run.workflowName,
      repo,
    };
    candidates.push({ repo, externalId: data.externalId, data });
  }
  emitWorkItemBacklog(deps, GITHUB_CI_RUN_COMPLETED_EVENT, seen, candidates);
}

function startGitHubCiSource(deps: SourceStartDeps<GitHubCiSourceConfig>): Promise<SourceHandle> {
  return startWorkItemPoller(
    deps,
    { warn: "run poll failed", event: "GitHub CI run poll failed" },
    pollRuns,
  );
}

export const githubCiSourceModule: SourceModule<GitHubCiSourceConfig> = {
  type: "github-ci",
  start: startGitHubCiSource,
};
