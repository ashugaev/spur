import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { archiveSessions, listSessions, readSession } from "./metadata.js";
import { listOpenPullRequests, resolveRepoSlug } from "./session-pr.js";
import { workspaceIdOf } from "./session-desk.js";
import {
  hasUncommittedChanges,
  hasUnpushedCommits,
  pruneRepoWorktrees,
  removeWorktree,
  resolveRepoPathFromWorktree,
} from "./workspace.js";
import {
  hasRetainedSessionError,
  isStaleParked,
  type AppConfig,
  type ProjectConfig,
  type SessionGcStatus,
  type SessionRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);

// Moved from session-service.ts (cleanupIgnoredPaths / resolveCleanupContext):
// terminal-cleanup (complete/kill) and session GC both need the same repo
// path + ignored-paths resolution for a session, so it lives in one place.
// session-service.ts's private resolveCleanupContext now delegates here.
export function cleanupIgnoredPaths(
  session: Pick<SessionRecord, "agent">,
  symlinks: string[],
): string[] {
  if (session.agent !== "cursor") {
    return symlinks;
  }
  return [...symlinks, ".cursor/.workspace-trusted"];
}

export interface SessionCleanupContext {
  repoPath: string;
  symlinks: string[];
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function findProjectByRepoPath(
  projects: Record<string, ProjectConfig>,
  repoPath: string,
): ProjectConfig | undefined {
  const resolvedRepoPath = tryRealpath(repoPath);
  return Object.values(projects).find((project) => tryRealpath(project.path) === resolvedRepoPath);
}

export async function resolveSessionCleanupContext(
  projects: Record<string, ProjectConfig>,
  session: SessionRecord,
): Promise<SessionCleanupContext> {
  const currentProject = projects[session.project];
  if (currentProject) {
    return {
      repoPath: currentProject.path,
      symlinks: cleanupIgnoredPaths(session, currentProject.symlinks),
    };
  }
  if (!session.worktree || !session.worktreePath) {
    throw new Error(`Unknown project: ${session.project}`);
  }
  const repoPath = await resolveRepoPathFromWorktree(session.worktreePath);
  if (!repoPath) {
    throw new Error(
      `Cannot resolve repository root for ${session.id} after project rename: ${session.worktreePath}`,
    );
  }
  return {
    repoPath,
    symlinks: cleanupIgnoredPaths(
      session,
      findProjectByRepoPath(projects, repoPath)?.symlinks ?? [],
    ),
  };
}

// ---------------------------------------------------------------------------
// Planning (pure, no IO)
// ---------------------------------------------------------------------------

export type GcAction = "reclaim" | "archive" | "partial" | "blocked";

export interface GcGroupPlan {
  key: string;
  project: string;
  sessionIds: string[];
  workspaceIds: string[];
  worktreePath: string;
  ageDays: number;
  newestUpdatedAt: string;
  action: GcAction;
  blockReasons: string[];
  // Members this plan archives: all for reclaim/archive, the eligible subset
  // for partial, empty for blocked.
  archiveSessionIds: string[];
  // Distinct member paths of worktrees that exist at plan time; each keeps one
  // non-archived record while its worktree stays on disk.
  ownedWorktreePaths: string[];
  members: SessionRecord[];
}

export interface GcPlan {
  olderThanDays: number;
  statuses: SessionGcStatus[];
  limit: number;
  scanned: { sessions: number; groups: number };
  groups: GcGroupPlan[];
}

export interface PlanSessionGcInput {
  sessions: readonly SessionRecord[];
  protectedSessionIds?: ReadonlySet<string>;
  worktreeDir: string;
  now: Date;
  olderThanDays: number;
  statuses: readonly SessionGcStatus[];
  limit: number;
  projectFilter?: string;
  // Injected instead of calling node:fs directly, so the planner stays a
  // pure function of its input (session-gc.test.ts drives it with fakes).
  pathExists: (path: string) => boolean;
}

interface RawGroup {
  key: string;
  members: SessionRecord[];
}

function groupByProjectAndWorkspace(sessions: readonly SessionRecord[]): RawGroup[] {
  const byKey = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const key = `${session.project}::${workspaceIdOf(session)}`;
    const list = byKey.get(key);
    if (list) {
      list.push(session);
    } else {
      byKey.set(key, [session]);
    }
  }
  return [...byKey.entries()].map(([key, members]) => ({ key, members }));
}

// Coalesces any two groups that share a non-empty identical worktreePath,
// across projects too — strictly more conservative than grouping alone,
// mirroring hasActiveWorktreePathPeers (session-service.ts).
function coalesceByWorktreePath(groups: RawGroup[]): RawGroup[] {
  const parent = groups.map((_, index) => index);
  function find(index: number): number {
    let root = index;
    for (;;) {
      const next = parent[root];
      if (next === undefined || next === root) break;
      root = next;
    }
    // Path compression: point every visited node straight at the root.
    let current = index;
    while (current !== root) {
      const next = parent[current];
      if (next === undefined) break;
      parent[current] = root;
      current = next;
    }
    return root;
  }
  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootA] = rootB;
    }
  }

  const pathOwner = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const member of group.members) {
      const path = member.worktreePath.trim();
      if (!path) continue;
      const owner = pathOwner.get(path);
      if (owner !== undefined) {
        union(owner, index);
      } else {
        pathOwner.set(path, index);
      }
    }
  });

  const merged = new Map<number, SessionRecord[]>();
  groups.forEach((group, index) => {
    const root = find(index);
    const existing = merged.get(root);
    if (existing) {
      existing.push(...group.members);
    } else {
      merged.set(root, [...group.members]);
    }
  });

  return [...merged.values()].map((members) => {
    const sorted = [...members].sort((left, right) => left.id.localeCompare(right.id));
    return { key: sorted.map((member) => member.id).join("+"), members: sorted };
  });
}

function ageInDays(updatedAt: string, now: Date): number {
  const ms = now.getTime() - new Date(updatedAt).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

// Every group built by groupByProjectAndWorkspace/coalesceByWorktreePath has
// at least one member; this turns that invariant into a checked failure at
// the one place it could ever be violated, instead of a non-null assertion
// at every `[0]` access.
function firstMember(members: readonly SessionRecord[], context: string): SessionRecord {
  const first = members[0];
  if (!first) {
    throw new Error(`${context}: group has no members`);
  }
  return first;
}

function memberPath(member: SessionRecord): string {
  return member.worktreePath.trim();
}

// Grows a retained set until no archived record is the desk anchor of a
// retained one (a missing anchor breaks the survivor) and every owned worktree
// path that stays on disk keeps one visible record (PR #652: a record-driven
// sweep never sees an archived record's worktree again). keeperIds are the
// retained records an acted (non-retained) record depends on; the executor
// re-reads them right before archiving.
export function retainClosure(
  members: readonly SessionRecord[],
  initiallyRetained: ReadonlySet<string>,
  ownedPaths: readonly string[],
): { retainedIds: Set<string>; keeperIds: string[] } {
  const retained = new Set(initiallyRetained);
  let changed = true;
  while (changed) {
    changed = false;
    const anchorIds = new Set(
      members.filter((member) => retained.has(member.id)).map((member) => workspaceIdOf(member)),
    );
    for (const member of members) {
      if (anchorIds.has(member.id) && !retained.has(member.id)) {
        retained.add(member.id);
        changed = true;
      }
    }
    for (const path of ownedPaths) {
      const withPath = members.filter((member) => memberPath(member) === path);
      if (withPath.some((member) => retained.has(member.id))) continue;
      const newest = [...withPath].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      )[0];
      if (newest) {
        retained.add(newest.id);
        changed = true;
      }
    }
  }
  const acted = members.filter((member) => !retained.has(member.id));
  const actedAnchorIds = new Set(acted.map((member) => workspaceIdOf(member)));
  const actedPaths = new Set(acted.map(memberPath));
  const keeperIds = members
    .filter(
      (member) =>
        retained.has(member.id) &&
        (actedAnchorIds.has(member.id) ||
          (ownedPaths.includes(memberPath(member)) && actedPaths.has(memberPath(member)))),
    )
    .map((member) => member.id);
  return { retainedIds: retained, keeperIds };
}

function stoppedIds(members: readonly SessionRecord[], ids: readonly string[]): string[] {
  return members
    .filter((member) => member.status === "stopped" && ids.includes(member.id))
    .map((member) => member.id);
}

function classifyGroup(
  members: SessionRecord[],
  protectedSessionIds: ReadonlySet<string>,
  worktreeDir: string,
  olderThanDays: number,
  statuses: readonly SessionGcStatus[],
  now: Date,
  pathExists: (path: string) => boolean,
): {
  action: GcAction;
  blockReasons: string[];
  worktreePath: string;
  ageDays: number;
  newestUpdatedAt: string;
  archiveSessionIds: string[];
  ownedWorktreePaths: string[];
} {
  const newestUpdatedAt = members.reduce(
    (latest, member) => (member.updatedAt > latest ? member.updatedAt : latest),
    firstMember(members, "classifyGroup").updatedAt,
  );
  const ageDays = ageInDays(newestUpdatedAt, now);
  const worktreePath =
    members.find((member) => member.worktreePath.trim())?.worktreePath.trim() ?? "";
  const ownedWorktreePaths = [
    ...new Set(
      members
        .filter((member) => member.worktree && memberPath(member) && pathExists(memberPath(member)))
        .map(memberPath),
    ),
  ];
  const allIds = members.map((member) => member.id);

  const blockReasons: string[] = [];
  const statusSet = new Set<string>(statuses);
  // A stale-parked record is an in-progress task that fell idle, not an
  // abandoned one: it counts live at plan time as it does at execution.
  const isLive = (member: SessionRecord): boolean =>
    protectedSessionIds.has(member.id) || isStaleParked(member);
  if (members.some(isLive)) {
    blockReasons.push("live_session");
  }
  if (members.some((member) => hasRetainedSessionError(member))) {
    blockReasons.push("retained_error");
  }
  if (members.some((member) => !statusSet.has(member.status))) {
    blockReasons.push("not_eligible_status");
  }
  if (ageDays < olderThanDays) {
    blockReasons.push("too_recent");
  }
  if (blockReasons.length > 0) {
    // Member-level blockers keep only the offending records; the rest of the
    // group is archived individually, never with its worktree.
    const retained = new Set(
      members
        .filter(
          (member) =>
            isLive(member) ||
            hasRetainedSessionError(member) ||
            !statusSet.has(member.status) ||
            ageInDays(member.updatedAt, now) < olderThanDays,
        )
        .map((member) => member.id),
    );
    const { retainedIds } = retainClosure(members, retained, ownedWorktreePaths);
    const archiveSessionIds = allIds.filter((id) => !retainedIds.has(id));
    if (archiveSessionIds.length === 0) {
      return {
        action: "blocked",
        blockReasons,
        worktreePath,
        ageDays,
        newestUpdatedAt,
        archiveSessionIds,
        ownedWorktreePaths,
      };
    }
    const archiveSet = new Set(archiveSessionIds);
    const archived = members.filter((member) => archiveSet.has(member.id));
    const archivedNewest = archived.reduce(
      (latest, member) => (member.updatedAt > latest ? member.updatedAt : latest),
      firstMember(archived, "classifyGroup").updatedAt,
    );
    return {
      action: "partial",
      blockReasons,
      worktreePath,
      ageDays: ageInDays(archivedNewest, now),
      newestUpdatedAt: archivedNewest,
      archiveSessionIds,
      ownedWorktreePaths,
    };
  }

  const whole = (action: GcAction, reasons: string[] = []) => ({
    action,
    blockReasons: reasons,
    worktreePath,
    ageDays,
    newestUpdatedAt,
    archiveSessionIds: action === "blocked" ? [] : allIds,
    ownedWorktreePaths,
  });

  // An archive group never removes a worktree, so an existing owned one (a
  // worktree:true member whose path exists) keeps one visible record.
  const archiveKeepingWorktrees = () => {
    const { retainedIds } = retainClosure(members, new Set(), ownedWorktreePaths);
    if (retainedIds.size === 0) return whole("archive");
    const archiveSessionIds = allIds.filter((id) => !retainedIds.has(id));
    if (archiveSessionIds.length === 0) return whole("blocked", ["owned_worktree"]);
    return { ...whole("partial", ["owned_worktree"]), archiveSessionIds };
  };

  if (members.some((member) => !member.worktree)) {
    return archiveKeepingWorktrees();
  }

  if (!worktreePath) {
    return archiveKeepingWorktrees();
  }

  const rel = relative(worktreeDir, worktreePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return whole("blocked", ["path_outside_worktree_dir"]);
  }

  if (!pathExists(worktreePath)) {
    return archiveKeepingWorktrees();
  }

  return whole("reclaim");
}

export function planSessionGc(input: PlanSessionGcInput): GcPlan {
  const sessions = input.projectFilter
    ? input.sessions.filter((session) => session.project === input.projectFilter)
    : input.sessions;

  const rawGroups = coalesceByWorktreePath(groupByProjectAndWorkspace(sessions));

  const groups: GcGroupPlan[] = rawGroups.map((raw) => {
    const members = raw.members;
    const classification = classifyGroup(
      members,
      input.protectedSessionIds ?? new Set(),
      input.worktreeDir,
      input.olderThanDays,
      input.statuses,
      input.now,
      input.pathExists,
    );
    return {
      key: raw.key,
      project: firstMember(members, "planSessionGc").project,
      sessionIds: members.map((member) => member.id),
      workspaceIds: [...new Set(members.map((member) => workspaceIdOf(member)))],
      worktreePath: classification.worktreePath,
      ageDays: classification.ageDays,
      newestUpdatedAt: classification.newestUpdatedAt,
      action: classification.action,
      blockReasons: classification.blockReasons,
      archiveSessionIds: classification.archiveSessionIds,
      ownedWorktreePaths: classification.ownedWorktreePaths,
      members,
    };
  });

  const sorted = [...groups].sort(
    (left, right) => right.ageDays - left.ageDays || left.key.localeCompare(right.key),
  );

  // Not sliced here: the limit counts groups that act, which only the
  // executor knows (a planned group can still block at execution).
  return {
    olderThanDays: input.olderThanDays,
    statuses: [...input.statuses],
    limit: input.limit,
    scanned: { sessions: sessions.length, groups: groups.length },
    groups: sorted,
  };
}

// ---------------------------------------------------------------------------
// Execution (IO via injected deps)
// ---------------------------------------------------------------------------

export interface GcOpenPrIndex {
  // Repo-qualified (`owner/name#123`): a bound PR number is only meaningful in
  // its own repo.
  numbers: Set<string>;
  branches: Set<string>;
}

function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export interface SessionGcExecutorDeps {
  cwd: string;
  readGroupMembers: (sessionIds: readonly string[]) => (SessionRecord | null)[];
  // Execution-time service state can make a planning-time terminal record
  // live (restore/recovery warmup). This synchronous check sits directly at
  // each destructive boundary so no awaited probe can stale its answer.
  checkGroupLiveness: (sessionIds: readonly string[]) => "inactive" | "live" | "unknown";
  // Every current record, read synchronously at the destructive boundary to
  // catch a spawn that joined the group (reused a workspace) after planning.
  listSessionRecords: () => readonly SessionRecord[];
  // Uncommitted/unpushed checks only — the PR probe is `openPrIndex` below.
  // Returns block reasons (empty when guards pass); any probe throw inside
  // must be translated to ["probe_failed"], never rethrown.
  probeGuards: (group: GcGroupPlan, freshMembers: readonly SessionRecord[]) => Promise<string[]>;
  // Throws on any failure (bad JSON, non-array, saturated limit, gh error) —
  // callers must treat a throw as "probe_failed", never as "no open PR".
  openPrIndex: (
    group: GcGroupPlan,
    freshMembers: readonly SessionRecord[],
  ) => Promise<GcOpenPrIndex>;
  measureSize: (worktreePath: string) => Promise<number | null>;
  removeWorktree: (group: GcGroupPlan, freshMembers: readonly SessionRecord[]) => Promise<void>;
  archiveGroup: (members: readonly Pick<SessionRecord, "id" | "project">[]) => {
    archivedIds: string[];
  };
  pruneRepo: (group: GcGroupPlan, freshMembers: readonly SessionRecord[]) => Promise<void>;
}

export interface GcGroupReport {
  key: string;
  project: string;
  sessionIds: string[];
  workspaceIds: string[];
  worktreePath: string;
  ageDays: number;
  newestUpdatedAt: string;
  sizeBytes: number | null;
  action: GcAction;
  blockReasons: string[];
  // Final acted records; empty when blocked.
  archiveSessionIds: string[];
  restoreLossSessionIds: string[];
  removed: boolean;
  archived: boolean;
  error?: string;
}

export interface GcReport {
  dryRun: boolean;
  olderThanDays: number;
  statuses: SessionGcStatus[];
  limit: number;
  scanned: { sessions: number; groups: number };
  groups: GcGroupReport[];
  totals: {
    groups: number;
    records: number;
    worktreesRemoved: number;
    recordsArchived: number;
    freedBytes: number | null;
    errors: number;
  };
}

export interface ExecuteSessionGcOptions {
  dryRun: boolean;
  sizes: boolean;
}

// Compares every field a guard or the removal itself reads, not just
// status/updatedAt: a concurrent writer that changes worktreePath, worktree,
// branch, or the PR binding without bumping updatedAt would otherwise let the
// run act on stale plan data (wrong path removed, wrong branch probed).
function isPlanStillFresh(planned: SessionRecord, fresh: SessionRecord): boolean {
  return (
    fresh.status === planned.status &&
    fresh.error === planned.error &&
    fresh.updatedAt === planned.updatedAt &&
    fresh.worktree === planned.worktree &&
    fresh.worktreePath === planned.worktreePath &&
    fresh.branch === planned.branch &&
    fresh.pr?.number === planned.pr?.number &&
    fresh.pr?.repo === planned.pr?.repo
  );
}

function isCwdInsideOrEqual(cwd: string, worktreePath: string): boolean {
  if (!worktreePath) {
    return false;
  }
  const rel = relative(worktreePath, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function currentLivenessBlockReason(
  deps: Pick<SessionGcExecutorDeps, "checkGroupLiveness">,
  sessionIds: readonly string[],
): string | undefined {
  try {
    const liveness = deps.checkGroupLiveness(sessionIds);
    if (liveness === "live") return "live_session";
    if (liveness === "unknown") return "liveness_check_failed";
    return undefined;
  } catch {
    return "liveness_check_failed";
  }
}

function currentRecordsBlockReason(
  readGroupMembers: SessionGcExecutorDeps["readGroupMembers"],
  sessionIds: readonly string[],
  plannedMembers: readonly SessionRecord[],
): string | undefined {
  const members = readGroupMembers(sessionIds);
  if (members.some((member) => member && hasRetainedSessionError(member))) {
    return "retained_error";
  }
  if (
    plannedMembers.some((planned, index) => {
      const fresh = members[index];
      return !fresh || !isPlanStillFresh(planned, fresh);
    })
  ) {
    return "changed_during_run";
  }
  return undefined;
}

// A spawn that reuses a workspace after planning joins the group (same
// workspace id) or its worktree path; archiving or removing under it would
// dangle the new record's anchor or path.
function newMemberBlockReason(
  deps: Pick<SessionGcExecutorDeps, "listSessionRecords">,
  group: GcGroupPlan,
): string | undefined {
  const known = new Set(group.sessionIds);
  const workspaceIds = new Set(group.workspaceIds);
  const paths = new Set(group.members.map(memberPath).filter(Boolean));
  const joined = deps
    .listSessionRecords()
    .some(
      (record) =>
        !known.has(record.id) &&
        (workspaceIds.has(workspaceIdOf(record)) || paths.has(memberPath(record))),
    );
  return joined ? "changed_during_run" : undefined;
}

export async function executeSessionGc(
  plan: GcPlan,
  deps: SessionGcExecutorDeps,
  options: ExecuteSessionGcOptions,
): Promise<GcReport> {
  const groupReports: GcGroupReport[] = [];
  let worktreesRemoved = 0;
  let recordsArchived = 0;
  let freedBytes = 0;
  let errors = 0;
  let actingGroups = 0;
  let probedGroups = 0;
  let planBlockedReported = 0;

  for (const group of plan.groups) {
    if (actingGroups >= plan.limit) break;
    if (group.action === "blocked") {
      // No IO and no slot; reported only up to `limit` for diagnostics.
      if (planBlockedReported >= plan.limit) continue;
      planBlockedReported += 1;
    } else {
      // Groups blocked at execution still cost du/probe/gh calls, so the
      // walk past them is bounded.
      if (probedGroups >= plan.limit * 2) break;
      probedGroups += 1;
    }
    const plannedAction = group.action;
    let action: GcAction = group.action;
    let blockReasons = [...group.blockReasons];
    let removed = false;
    let archived = false;
    let error: string | undefined;
    let sizeBytes: number | null = null;
    let archiveSessionIds: string[] = [];

    try {
      // Sized before anything is removed: du on an already-deleted worktree
      // reports nothing, which would zero out every freed-byte total.
      if (options.sizes && plannedAction === "reclaim") {
        sizeBytes = await deps.measureSize(group.worktreePath);
      }

      if (action !== "blocked") {
        // Rechecks cover only the acted records: a kept running member's
        // updatedAt changes constantly and must not block a partial run.
        const plannedActed = group.members.filter((member) =>
          group.archiveSessionIds.includes(member.id),
        );
        const freshRaw = deps.readGroupMembers(plannedActed.map((member) => member.id));
        const freshMembers: SessionRecord[] = [];
        let changed = false;
        for (let index = 0; index < plannedActed.length; index += 1) {
          const fresh = freshRaw[index];
          const planned = plannedActed[index];
          if (!fresh || !planned || !isPlanStillFresh(planned, fresh)) {
            changed = true;
            break;
          }
          freshMembers.push(fresh);
        }

        // Narrows the acted set to what survives retaining `seed` plus its
        // closure; the group then archives individually and keeps its worktree.
        let acted: SessionRecord[] = freshMembers;
        const narrow = (seed: ReadonlySet<string>, reason: string[]): void => {
          const { retainedIds } = retainClosure(group.members, seed, group.ownedWorktreePaths);
          acted = acted.filter((member) => !retainedIds.has(member.id));
          for (const entry of reason) {
            if (!blockReasons.includes(entry)) blockReasons.push(entry);
          }
        };
        const notActed = (): Set<string> =>
          new Set(
            group.members
              .map((member) => member.id)
              .filter((id) => !acted.some((member) => member.id === id)),
          );

        if (changed) {
          action = "blocked";
          blockReasons = ["changed_during_run"];
        } else if (action === "reclaim" && freshMembers.some((member) => !member.worktree)) {
          action = "blocked";
          blockReasons = ["shared_workspace_path"];
        } else if (action === "reclaim" && isCwdInsideOrEqual(deps.cwd, group.worktreePath)) {
          action = "blocked";
          blockReasons = ["path_is_cwd_or_ancestor"];
        } else {
          // Guards protect `git worktree remove --force`; archive and partial
          // never remove a worktree.
          const guardReasons =
            action === "reclaim" ? await deps.probeGuards(group, freshMembers) : [];
          const dirtyReasons = guardReasons.filter(
            (reason) => reason === "uncommitted_changes" || reason === "unpushed_commits",
          );
          if (dirtyReasons.length < guardReasons.length) {
            action = "blocked";
            blockReasons = guardReasons;
          } else {
            if (dirtyReasons.length > 0) {
              narrow(new Set(), dirtyReasons);
            }
            try {
              // Nothing left to act on after dirty narrowing: no gh call.
              const prIndex = acted.length > 0 ? await deps.openPrIndex(group, acted) : undefined;
              const openIds = prIndex
                ? acted
                    .filter(
                      (member) =>
                        (member.pr &&
                          prIndex.numbers.has(prKey(member.pr.repo, member.pr.number))) ||
                        prIndex.branches.has(member.branch),
                    )
                    .map((member) => member.id)
                : [];
              if (openIds.length > 0) {
                narrow(new Set([...notActed(), ...openIds]), ["open_pr"]);
              }
            } catch {
              action = "blocked";
              blockReasons = ["probe_failed"];
            }
            if (action !== "blocked") {
              if (acted.length === 0) {
                action = "blocked";
              } else if (acted.length < freshMembers.length) {
                action = "partial";
              }
            }
          }
        }

        if (action !== "blocked") {
          const actedIds = acted.map((member) => member.id);
          const keeperIds =
            acted.length < group.members.length
              ? retainClosure(group.members, notActed(), group.ownedWorktreePaths).keeperIds
              : [];
          const plannedFinal = plannedActed.filter((member) => actedIds.includes(member.id));
          archiveSessionIds = actedIds;
          // Worktree first, records second — deliberately, not incidentally.
          // If archival then fails, the record survives in sessions/ pointing
          // at a deleted path, and the next run reclassifies that group as
          // "archive" (its path no longer exists) and finishes the job. The
          // reverse order has no such recovery: an archived record whose
          // worktree removal failed leaves a worktree no record-driven sweep
          // can ever see again.
          if (action === "reclaim" && !options.dryRun) {
            const livenessBlock =
              currentLivenessBlockReason(deps, actedIds) ??
              currentRecordsBlockReason(deps.readGroupMembers, actedIds, plannedFinal) ??
              newMemberBlockReason(deps, group);
            if (livenessBlock) {
              action = "blocked";
              blockReasons = [livenessBlock];
            } else {
              await deps.removeWorktree(group, freshMembers);
              await deps.pruneRepo(group, freshMembers);
              removed = true;
              worktreesRemoved += 1;
            }
          }
          if (action !== "blocked" && !options.dryRun) {
            // Kept anchors and path keepers: existence only, no freshness
            // compare (a concurrent run may have archived them).
            const livenessBlock =
              currentLivenessBlockReason(deps, actedIds) ??
              currentRecordsBlockReason(deps.readGroupMembers, actedIds, plannedFinal) ??
              (keeperIds.length > 0 && deps.readGroupMembers(keeperIds).some((member) => !member)
                ? "changed_during_run"
                : undefined) ??
              newMemberBlockReason(deps, group);
            if (livenessBlock) {
              action = "blocked";
              blockReasons = [livenessBlock];
            } else {
              const result = deps.archiveGroup(
                acted.map((member) => ({ id: member.id, project: member.project })),
              );
              // The receipt, not the plan, is what actually moved.
              archiveSessionIds = result.archivedIds;
              archived = result.archivedIds.length > 0;
              recordsArchived += result.archivedIds.length;
            }
          }
        }
      }
    } catch (executionError) {
      error = executionError instanceof Error ? executionError.message : String(executionError);
      errors += 1;
    }

    // A dry run reports the bytes a reclaim would free; an execute run counts
    // only worktrees actually removed. A group whose measurement failed keeps
    // sizeBytes: null in its own report, so the gap in the total is visible.
    if (sizeBytes !== null && (removed || (options.dryRun && action === "reclaim"))) {
      freedBytes += sizeBytes;
    }

    if (action !== "blocked") actingGroups += 1;
    const finalArchiveIds = action === "blocked" ? [] : archiveSessionIds;

    groupReports.push({
      key: group.key,
      project: group.project,
      sessionIds: group.sessionIds,
      workspaceIds: group.workspaceIds,
      worktreePath: group.worktreePath,
      ageDays: group.ageDays,
      newestUpdatedAt: group.newestUpdatedAt,
      sizeBytes,
      action,
      blockReasons,
      archiveSessionIds: finalArchiveIds,
      // Restore (not reopen) is the one-way loss: only "stopped" members
      // (the sole restorable status among GC's completed|killed|stopped
      // allow-list) had a live restore path before this run.
      restoreLossSessionIds: stoppedIds(group.members, finalArchiveIds),
      removed,
      archived,
      ...(error ? { error } : {}),
    });
  }

  return {
    dryRun: options.dryRun,
    olderThanDays: plan.olderThanDays,
    statuses: plan.statuses,
    limit: plan.limit,
    scanned: plan.scanned,
    groups: groupReports,
    totals: {
      groups: groupReports.length,
      records: groupReports.reduce((acc, entry) => acc + entry.sessionIds.length, 0),
      worktreesRemoved,
      recordsArchived,
      freedBytes: options.sizes ? freedBytes : null,
      errors,
    },
  };
}

// ---------------------------------------------------------------------------
// Real dependency wiring
// ---------------------------------------------------------------------------

const DU_TIMEOUT_MS = 120_000;

// `du -s --block-size=1`, not `du -sb`: apparent size (`-b`) undercounts a
// worktree by orders of magnitude (it ignores directory and block overhead),
// and freed disk is what the caller cares about. A file hardlinked into
// several worktrees (pnpm store) still counts once per worktree, so a total
// across many groups can overstate the disk actually returned.
async function measureWorktreeSize(worktreePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-s", "--block-size=1", "--", worktreePath], {
      timeout: DU_TIMEOUT_MS,
    });
    const match = /^(\d+)/.exec(stdout);
    const digits = match?.[1];
    return digits ? Number.parseInt(digits, 10) : null;
  } catch {
    return null;
  }
}

export function createGcDeps(
  config: AppConfig,
  // A stale-parked session (isStaleParked) is an in-progress task that fell
  // idle, not an abandoned one — session-service.ts wakes it silently on any
  // event. Counting it live here keeps its worktree out of GC candidacy;
  // reclaiming it would surface as "workspace is missing" on that wake.
  isLiveSession: (session: SessionRecord) => boolean = (session) =>
    session.status === "running" || session.status === "spawning" || isStaleParked(session),
): SessionGcExecutorDeps {
  // One `gh pr list` per repo per run, cached for the whole run. A PR opened
  // after a repo's first probe is invisible to later groups of that same run;
  // the window is one run and the next run re-lists. Kept per-run on purpose:
  // per-group refresh multiplies gh calls by group count, and exhausting the
  // GraphQL quota would turn every later probe into probe_failed.
  const openPrIndexCache = new Map<string, Promise<GcOpenPrIndex>>();
  const readGroupMembers: SessionGcExecutorDeps["readGroupMembers"] = (sessionIds) =>
    sessionIds.map((id) => readSession(config.dataDir, id));
  const checkGroupLiveness: SessionGcExecutorDeps["checkGroupLiveness"] = (sessionIds) => {
    try {
      for (const session of readGroupMembers(sessionIds)) {
        if (!session) return "unknown";
        if (isLiveSession(session)) return "live";
      }
      return "inactive";
    } catch {
      return "unknown";
    }
  };

  async function repoPathForGroup(freshMembers: readonly SessionRecord[]): Promise<string> {
    const representative = freshMembers[0];
    if (!representative) {
      throw new Error("Cannot resolve repository path for an empty group");
    }
    const context = await resolveSessionCleanupContext(config.projects, representative);
    return context.repoPath;
  }

  return {
    cwd: process.cwd(),
    readGroupMembers,
    checkGroupLiveness,
    listSessionRecords: () => listSessions(config.dataDir),
    probeGuards: async (group, freshMembers) => {
      if (!group.worktreePath || !existsSync(group.worktreePath)) {
        return [];
      }
      const ignoredPaths = [
        ...new Set(
          freshMembers.flatMap((member) =>
            cleanupIgnoredPaths(member, config.projects[member.project]?.symlinks ?? []),
          ),
        ),
      ];
      try {
        if (await hasUncommittedChanges(group.worktreePath, ignoredPaths)) {
          return ["uncommitted_changes"];
        }
      } catch {
        return ["probe_failed"];
      }
      try {
        if (await hasUnpushedCommits(group.worktreePath)) {
          return ["unpushed_commits"];
        }
      } catch {
        return ["probe_failed"];
      }
      return [];
    },
    openPrIndex: async (group, freshMembers) => {
      // Every repo a member is bound to, plus the checkout's repo when some
      // member has no binding (its branch is matched there). A repo that
      // cannot be resolved or listed throws, which blocks the whole group.
      const repos = new Set(freshMembers.flatMap((member) => (member.pr ? [member.pr.repo] : [])));
      const hasCheckout = Boolean(group.worktreePath) && existsSync(group.worktreePath);
      if (hasCheckout && (repos.size === 0 || freshMembers.some((member) => !member.pr))) {
        repos.add(await resolveRepoSlug(group.worktreePath));
      }
      const index: GcOpenPrIndex = { numbers: new Set(), branches: new Set() };
      const listings = await Promise.all(
        [...repos].map((repoSlug) => {
          let cached = openPrIndexCache.get(repoSlug);
          if (!cached) {
            cached = listOpenPullRequests(repoSlug).then((items) => ({
              numbers: new Set(items.map((item) => prKey(repoSlug, item.number))),
              branches: new Set(items.map((item) => item.headRefName)),
            }));
            openPrIndexCache.set(repoSlug, cached);
          }
          return cached;
        }),
      );
      for (const listing of listings) {
        for (const key of listing.numbers) index.numbers.add(key);
        for (const branch of listing.branches) index.branches.add(branch);
      }
      return index;
    },
    measureSize: measureWorktreeSize,
    removeWorktree: async (group, freshMembers) => {
      const repoPath = await repoPathForGroup(freshMembers);
      await removeWorktree(repoPath, group.worktreePath, () => {
        const blockReason =
          currentLivenessBlockReason({ checkGroupLiveness }, group.sessionIds) ??
          currentRecordsBlockReason(readGroupMembers, group.sessionIds, group.members);
        if (blockReason) throw new Error(`Session GC blocked: ${blockReason}`);
      });
    },
    archiveGroup: (members) => archiveSessions(config.dataDir, members),
    pruneRepo: async (_group, freshMembers) => {
      const repoPath = await repoPathForGroup(freshMembers);
      await pruneRepoWorktrees(repoPath);
    },
  };
}
