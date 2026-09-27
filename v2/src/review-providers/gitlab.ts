import { glab } from "../glab.js";
import type {
  AutoPingThreadTarget,
  ReviewCheck,
  ReviewEventData,
  ReviewRequestSummary,
  ReviewSignal,
  SessionRecord,
} from "../types.js";
import { hasMergeConflict, shortText, summarizeFailingCi } from "./shared.js";
import type { ReviewProvider } from "./types.js";

type GitLabMergeRequest = {
  iid: number;
  title: string;
  web_url: string;
  has_conflicts?: boolean | null;
  detailed_merge_status?: string | null;
  blocking_discussions_resolved?: boolean | null;
};

type GitLabPipeline = {
  id?: number;
  status?: string | null;
};

type GitLabDiscussionNote = {
  id: number;
  body: string;
  system?: boolean;
  resolved?: boolean | null;
  resolvable?: boolean | null;
  author?: { username?: string | null; name?: string | null } | null;
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
};

type GitLabDiscussion = {
  id: string;
  individual_note?: boolean;
  notes: GitLabDiscussionNote[];
};

type ReviewSignalWithThreadTarget = ReviewSignal & {
  providerThreadTarget?: AutoPingThreadTarget;
};

function encodeProjectPath(projectPath: string): string {
  return encodeURIComponent(projectPath);
}

function projectPathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const marker = parsed.pathname.match(/^\/(.+?)(?:\/-)?\/merge_requests\/\d+/);
    return marker?.[1] ?? "";
  } catch {
    return "";
  }
}

async function fetchMergeRequestsByBranch(
  worktreePath: string,
  branch: string,
): Promise<GitLabMergeRequest[]> {
  const endpoint = `projects/:fullpath/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&per_page=1`;
  const raw = await glab(worktreePath, "api", endpoint, "--output", "json");
  return JSON.parse(raw) as GitLabMergeRequest[];
}

async function fetchPipelines(
  worktreePath: string,
  projectPath: string,
  mergeRequestIid: number,
): Promise<GitLabPipeline[]> {
  try {
    const raw = await glab(
      worktreePath,
      "api",
      `projects/${encodeProjectPath(projectPath)}/merge_requests/${String(mergeRequestIid)}/pipelines?per_page=20`,
      "--output",
      "json",
    );
    return JSON.parse(raw) as GitLabPipeline[];
  } catch {
    return [];
  }
}

async function fetchDiscussions(
  worktreePath: string,
  projectPath: string,
  mergeRequestIid: number,
): Promise<GitLabDiscussion[]> {
  const discussions: GitLabDiscussion[] = [];
  for (let page = 1; ; page += 1) {
    const raw = await glab(
      worktreePath,
      "api",
      `projects/${encodeProjectPath(projectPath)}/merge_requests/${String(mergeRequestIid)}/discussions?per_page=100&page=${String(page)}`,
      "--output",
      "json",
    );
    const next = JSON.parse(raw) as GitLabDiscussion[];
    discussions.push(...next);
    if (next.length < 100) return discussions;
  }
}

function summarizePipelines(pipelines: GitLabPipeline[]): string | null {
  const checks: ReviewCheck[] = pipelines.map((pipeline) => ({
    name: pipeline.id ? `pipeline ${String(pipeline.id)}` : "pipeline",
    state: pipeline.status ?? "",
  }));
  return summarizeFailingCi(checks);
}

export async function resolveMergeRequestSummary(
  worktreePath: string,
  branch: string,
): Promise<ReviewRequestSummary | null> {
  const requests = await fetchMergeRequestsByBranch(worktreePath, branch);
  const request = requests[0];
  if (!request) return null;
  return {
    number: request.iid,
    title: request.title,
    url: request.web_url,
    reviewDecision: request.blocking_discussions_resolved === false ? "changes_requested" : "none",
    repo: projectPathFromUrl(request.web_url),
    mergeable: request.has_conflicts ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: request.detailed_merge_status ?? "",
  };
}

async function collectCommentSignals(
  worktreePath: string,
  projectPath: string,
  mergeRequestIid: number,
): Promise<{ signals: ReviewSignal[]; unresolvedDiscussions: number }> {
  const discussions = await fetchDiscussions(worktreePath, projectPath, mergeRequestIid);
  const signals: ReviewSignal[] = [];
  let unresolvedDiscussions = 0;
  for (const discussion of discussions) {
    const unresolved = discussion.notes.some(
      (note) => note.resolvable === true && note.resolved !== true,
    );
    if (unresolved) {
      unresolvedDiscussions += 1;
    }
    for (const note of discussion.notes) {
      if (note.system) continue;
      const author = note.author?.username ?? note.author?.name ?? "unknown";
      const path = note.position?.new_path ?? note.position?.old_path;
      const line = note.position?.new_line ?? note.position?.old_line;
      const location = path ? ` on ${path}${line ? `:${String(line)}` : ""}` : "";
      const signal: ReviewSignalWithThreadTarget = {
        key: discussion.individual_note
          ? `comment:${String(note.id)}`
          : `discussion:${discussion.id}:${String(note.id)}`,
        kind: "comment",
        text: `New merge request comment from ${author}${location}: "${shortText(note.body)}"`,
        ...(discussion.individual_note
          ? {}
          : {
              providerThreadTarget: {
                kind: "gitlab-discussion",
                mergeRequestIid,
                discussionId: discussion.id,
              },
            }),
      };
      signals.push(signal);
    }
  }
  return { signals, unresolvedDiscussions };
}

async function collectSignals(
  session: SessionRecord,
  _dataDir: string,
  _projectId: string,
  _sourceId: string,
): Promise<{ data: ReviewEventData; snapshot: Map<string, ReviewSignal> } | null> {
  const request = await resolveMergeRequestSummary(session.worktreePath, session.branch);
  if (!request || !request.repo) return null;

  const [pipelines, discussionData] = await Promise.all([
    fetchPipelines(session.worktreePath, request.repo, request.number),
    collectCommentSignals(session.worktreePath, request.repo, request.number),
  ]);

  const ciText = summarizePipelines(pipelines);
  const snapshot = new Map<string, ReviewSignal>();
  if (discussionData.unresolvedDiscussions > 0 || request.reviewDecision === "changes_requested") {
    snapshot.set("changes_requested", {
      key: "changes_requested",
      kind: "changes_requested",
      text: "Unresolved review discussions need changes.",
    });
  }
  if (ciText) {
    snapshot.set("ci_failed", {
      key: "ci_failed",
      kind: "ci_failed",
      text: ciText,
    });
  }
  if (hasMergeConflict(request)) {
    snapshot.set("merge_conflict", {
      key: "merge_conflict",
      kind: "merge_conflict",
      text: "Merge conflicts are blocking this merge request.",
    });
  }

  for (const signal of discussionData.signals) {
    snapshot.set(signal.key, signal);
  }

  return {
    data: {
      sessionId: session.id,
      prNumber: request.number,
      prTitle: request.title,
      signals: [],
    },
    snapshot,
  };
}

export const gitlabReviewProvider: ReviewProvider = {
  id: "gitlab",
  displayName: "GitLab",
  requestLabel: "merge request",
  requestLabelPlural: "merge requests",
  instructionsLine: "Review the latest GitLab updates on the active merge request and act on them.",
  commandLine:
    "Use `glab mr view --comments` and `glab ci status`, then fix, push, and reply if needed.",
  async findReviewUrlByBranch(worktreePath, branch) {
    const request = await resolveMergeRequestSummary(worktreePath, branch);
    return request?.url ?? null;
  },
  collectSignals,
};
