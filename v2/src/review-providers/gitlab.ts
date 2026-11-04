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
  sha?: string | null;
  target_branch?: string | null;
  diff_refs?: { base_sha?: string | null } | null;
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

// Current target branch tip. diff_refs.base_sha is the merge-base, which a
// target-only push never moves, so it cannot key a conflict change.
async function fetchBranchTip(
  worktreePath: string,
  projectPath: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const raw = await glab(
      worktreePath,
      "api",
      `projects/${encodeProjectPath(projectPath)}/repository/branches/${encodeURIComponent(branch)}`,
      "--output",
      "json",
    );
    const parsed = JSON.parse(raw) as { commit?: { id?: string | null } | null } | null;
    return parsed?.commit?.id ?? undefined;
  } catch {
    return undefined;
  }
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
  const [request] = await fetchMergeRequestsByBranch(worktreePath, branch);
  return request ? toSummary(request) : null;
}

function toSummary(request: GitLabMergeRequest): ReviewRequestSummary {
  return {
    number: request.iid,
    title: request.title,
    url: request.web_url,
    reviewDecision: request.blocking_discussions_resolved === false ? "changes_requested" : "none",
    repo: projectPathFromUrl(request.web_url),
    mergeable: request.has_conflicts ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: request.detailed_merge_status ?? "",
    ...(request.sha ? { headSha: request.sha } : {}),
    ...(request.diff_refs?.base_sha ? { baseSha: request.diff_refs.base_sha } : {}),
  };
}

function failingPipelineIds(pipelines: GitLabPipeline[]): string[] {
  return pipelines
    .filter((pipeline) => summarizeFailingCi([{ name: "pipeline", state: pipeline.status ?? "" }]))
    .map((pipeline) => String(pipeline.id ?? ""))
    .sort();
}

async function collectCommentSignals(
  worktreePath: string,
  projectPath: string,
  mergeRequestIid: number,
): Promise<{ signals: ReviewSignal[]; unresolvedDiscussions: number; maxNoteId?: string }> {
  const discussions = await fetchDiscussions(worktreePath, projectPath, mergeRequestIid);
  const signals: ReviewSignal[] = [];
  let unresolvedDiscussions = 0;
  let maxNote = 0;
  for (const discussion of discussions) {
    const lastNote = discussion.notes.filter((note) => !note.system).at(-1);
    const threadChangeKey = lastNote
      ? `${String(lastNote.id)}:${String(discussion.notes.every((note) => note.resolvable !== true || note.resolved === true))}`
      : undefined;
    for (const note of discussion.notes) {
      if (!note.system) maxNote = Math.max(maxNote, note.id);
    }
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
              ...(threadChangeKey !== undefined ? { changeKey: threadChangeKey } : {}),
            }),
      };
      signals.push(signal);
    }
  }
  return {
    signals: signals.map((signal) =>
      signal.providerThreadTarget || maxNote === 0
        ? signal
        : { ...signal, changeKey: String(maxNote) },
    ),
    unresolvedDiscussions,
    ...(maxNote > 0 ? { maxNoteId: String(maxNote) } : {}),
  };
}

async function collectSignals(
  session: SessionRecord,
  _dataDir: string,
  _projectId: string,
  _sourceId: string,
): Promise<{ data: ReviewEventData; snapshot: Map<string, ReviewSignal> } | null> {
  const [mergeRequest] = await fetchMergeRequestsByBranch(session.worktreePath, session.branch);
  if (!mergeRequest) return null;
  const request = toSummary(mergeRequest);
  if (!request.repo) return null;

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
      ...(discussionData.maxNoteId !== undefined ? { changeKey: discussionData.maxNoteId } : {}),
    });
  }
  if (ciText) {
    const sha = request.headSha;
    snapshot.set("ci_failed", {
      key: "ci_failed",
      kind: "ci_failed",
      text: ciText,
      ...(sha
        ? { changeKey: sha, revision: `${sha}:${failingPipelineIds(pipelines).join(",")}` }
        : {}),
    });
  }
  if (hasMergeConflict(request)) {
    const targetTip =
      request.headSha && mergeRequest.target_branch
        ? await fetchBranchTip(session.worktreePath, request.repo, mergeRequest.target_branch)
        : undefined;
    // Tip lookup failed: fall back to the merge-base so the key stays stable
    // across polls instead of going key-less.
    const baseKey = targetTip ?? request.baseSha;
    const revision = request.headSha && baseKey ? `${request.headSha}:${baseKey}` : undefined;
    snapshot.set("merge_conflict", {
      key: "merge_conflict",
      kind: "merge_conflict",
      text: "Merge conflicts are blocking this merge request.",
      ...(revision ? { changeKey: revision, revision } : {}),
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
