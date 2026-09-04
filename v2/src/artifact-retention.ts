import { AGENT_HISTORY_ARTIFACT_PREFIX } from "./agent-history-delta.js";
import {
  deleteSessionArtifactById,
  listSessionArtifacts,
  readSessionArtifact,
} from "./session-artifacts.js";
import { workspaceIdOf } from "./session-desk.js";
import type { AppConfig, SessionArtifact, SessionGcStatus, SessionRecord } from "./types.js";

// Retention prunes agent-history artifacts only. It never touches worktrees or
// session records — that is session-gc's scope, and duplicating it here would
// give one destructive decision two owners.

/**
 * The only statuses whose age alone makes an artifact reclaimable. Same set as
 * `SessionGcStatus` (types.ts): a `running`, `spawning`, `paused`, `errored`, or
 * `rate_limited` session is still producing history, so age must never select it.
 * The byte and file caps deliberately apply regardless of status — the measured mass
 * is under a week old, so a status-gated cap would reclaim almost nothing.
 */
export function isReclaimSafeStatus(status: SessionRecord["status"]): status is SessionGcStatus {
  return status === "completed" || status === "killed" || status === "stopped";
}

/**
 * E0 eligibility. All three clauses are required. `origin: "automatic"` is written by
 * exactly one call site (the state-transition capture), and an untracked file defaults to
 * `"intentional"` (session-artifacts.ts artifactOrigin), so a user upload and a startup
 * attachment sharing the anchor dir can never match. Deleting a startup attachment id
 * breaks that session's respawn permanently (session-service.ts preservedStartupIds).
 */
export function isEvictableArtifact(artifact: SessionArtifact): boolean {
  return (
    artifact.origin === "automatic" &&
    artifact.id.startsWith(AGENT_HISTORY_ARTIFACT_PREFIX) &&
    artifact.addedByUser !== true
  );
}

export interface ArtifactRetentionCandidate {
  anchorId: string;
  artifactId: string;
  sizeBytes: number;
  updatedAt: string;
  reason: "age" | "byte_cap" | "count_cap";
}

export interface ArtifactRetentionAnchorPlan {
  anchorId: string;
  sessionIds: string[];
  statuses: SessionRecord["status"][];
  ageEligible: boolean;
  totalBytes: number;
  totalFiles: number;
  automaticBytes: number;
  automaticFiles: number;
  evict: ArtifactRetentionCandidate[];
  evictBytes: number;
  blockReasons: string[];
}

export interface ArtifactRetentionPlan {
  olderThanDays: number;
  maxBytesPerSession: number;
  maxFilesPerSession: number;
  limit: number;
  scanned: { anchors: number; files: number };
  anchors: ArtifactRetentionAnchorPlan[];
  totals: { evictFiles: number; evictBytes: number };
}

export interface PlanArtifactRetentionInput {
  sessions: readonly SessionRecord[];
  now: Date;
  olderThanDays: number;
  maxBytesPerSession: number;
  maxFilesPerSession: number;
  limit: number;
  projectFilter?: string;
  // Injected the same way session-gc's planner takes `pathExists`: the decision stays
  // deterministic given the probe, and the walk itself stays out of the planner.
  listArtifacts: (anchorId: string) => { artifacts: SessionArtifact[]; truncated: boolean };
}

interface AnchorGroup {
  anchorId: string;
  sessionIds: string[];
  statuses: SessionRecord["status"][];
}

function groupByAnchor(sessions: readonly SessionRecord[]): AnchorGroup[] {
  const groups = new Map<string, AnchorGroup>();
  for (const session of sessions) {
    // Desk siblings share ONE artifacts dir (session-desk.ts workspaceIdOf), so the anchor
    // is the workspace id, never the session id.
    const anchorId = workspaceIdOf(session);
    const existing = groups.get(anchorId);
    if (existing) {
      existing.sessionIds.push(session.id);
      existing.statuses.push(session.status);
      continue;
    }
    groups.set(anchorId, {
      anchorId,
      sessionIds: [session.id],
      statuses: [session.status],
    });
  }
  return [...groups.values()];
}

function oldestFirst(left: SessionArtifact, right: SessionArtifact): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}

function planAnchor(
  group: AnchorGroup,
  artifacts: SessionArtifact[],
  truncated: boolean,
  input: PlanArtifactRetentionInput,
): ArtifactRetentionAnchorPlan {
  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  const eligible = artifacts.filter(isEvictableArtifact).sort(oldestFirst);
  const automaticBytes = eligible.reduce((sum, artifact) => sum + artifact.size, 0);
  const base = {
    anchorId: group.anchorId,
    sessionIds: group.sessionIds,
    statuses: group.statuses,
    totalBytes,
    totalFiles: artifacts.length,
    automaticBytes,
    automaticFiles: eligible.length,
  };

  // E1. A truncated listing means the anchor's real contents are unknown. Blocking the whole
  // anchor is the second brake behind explicit-id deletion, not the only one.
  if (truncated) {
    return {
      ...base,
      ageEligible: false,
      evict: [],
      evictBytes: 0,
      blockReasons: ["listing_truncated"],
    };
  }

  const ageEligible = group.statuses.every(isReclaimSafeStatus);
  const cutoffMs = input.now.getTime() - input.olderThanDays * 86_400_000;
  const evict: ArtifactRetentionCandidate[] = [];
  const evicted = new Set<string>();
  let remainingBytes = automaticBytes;
  let remainingFiles = eligible.length;

  const take = (artifact: SessionArtifact, reason: ArtifactRetentionCandidate["reason"]): void => {
    evicted.add(artifact.id);
    remainingBytes -= artifact.size;
    remainingFiles -= 1;
    evict.push({
      anchorId: group.anchorId,
      artifactId: artifact.id,
      sizeBytes: artifact.size,
      updatedAt: artifact.updatedAt,
      reason,
    });
  };

  // E2. Age, and only for an anchor whose every member is reclaim-safe.
  if (ageEligible) {
    for (const artifact of eligible) {
      const updatedMs = Date.parse(artifact.updatedAt);
      if (Number.isFinite(updatedMs) && updatedMs < cutoffMs) {
        take(artifact, "age");
      }
    }
  }

  // E3 then E4, oldest first. Both apply to every anchor regardless of status: the measured
  // mass is under a week old, so age carries almost none of the reclaim.
  for (const artifact of eligible) {
    if (remainingBytes <= input.maxBytesPerSession) break;
    if (evicted.has(artifact.id)) continue;
    take(artifact, "byte_cap");
  }
  for (const artifact of eligible) {
    if (remainingFiles <= input.maxFilesPerSession) break;
    if (evicted.has(artifact.id)) continue;
    take(artifact, "count_cap");
  }

  return {
    ...base,
    ageEligible,
    evict,
    evictBytes: evict.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    blockReasons: [],
  };
}

export function planArtifactRetention(input: PlanArtifactRetentionInput): ArtifactRetentionPlan {
  const sessions = input.projectFilter
    ? input.sessions.filter((session) => session.project === input.projectFilter)
    : input.sessions;

  let scannedFiles = 0;
  const anchors = groupByAnchor(sessions).map((group) => {
    const listing = input.listArtifacts(group.anchorId);
    scannedFiles += listing.artifacts.length;
    return planAnchor(group, listing.artifacts, listing.truncated, input);
  });

  const actionable = anchors
    .filter((anchor) => anchor.evict.length > 0 || anchor.blockReasons.length > 0)
    .sort(
      (left, right) =>
        right.evictBytes - left.evictBytes || left.anchorId.localeCompare(right.anchorId),
    )
    .slice(0, input.limit);

  return {
    olderThanDays: input.olderThanDays,
    maxBytesPerSession: input.maxBytesPerSession,
    maxFilesPerSession: input.maxFilesPerSession,
    limit: input.limit,
    scanned: { anchors: anchors.length, files: scannedFiles },
    anchors: actionable,
    totals: {
      evictFiles: actionable.reduce((sum, anchor) => sum + anchor.evict.length, 0),
      evictBytes: actionable.reduce((sum, anchor) => sum + anchor.evictBytes, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Execution (IO via injected deps)
// ---------------------------------------------------------------------------

export interface ArtifactRetentionDeps {
  /**
   * Deletes the named ids and returns the ids actually removed. Must re-check eligibility
   * at the deletion boundary and must never delete an id it was not handed — deleting the
   * complement of a keep set is what makes a lossy listing a user-data-deletion path.
   */
  deleteArtifacts: (anchorId: string, evictArtifactIds: readonly string[]) => string[];
}

export interface ArtifactRetentionAnchorReport {
  anchorId: string;
  sessionIds: string[];
  totalFiles: number;
  totalBytes: number;
  evictFiles: number;
  evictBytes: number;
  deletedFiles: number;
  freedBytes: number;
  blockReasons: string[];
  error?: string;
}

export interface ArtifactRetentionReport {
  dryRun: boolean;
  olderThanDays: number;
  maxBytesPerSession: number;
  maxFilesPerSession: number;
  limit: number;
  scanned: { anchors: number; files: number };
  anchors: ArtifactRetentionAnchorReport[];
  totals: {
    anchors: number;
    evictFiles: number;
    evictBytes: number;
    freedBytes: number;
    errors: number;
  };
}

export function executeArtifactRetention(
  plan: ArtifactRetentionPlan,
  deps: ArtifactRetentionDeps,
  options: { dryRun: boolean },
): ArtifactRetentionReport {
  const anchors: ArtifactRetentionAnchorReport[] = [];
  let errors = 0;
  let freedTotal = 0;

  for (const anchor of plan.anchors) {
    const row: ArtifactRetentionAnchorReport = {
      anchorId: anchor.anchorId,
      sessionIds: anchor.sessionIds,
      totalFiles: anchor.totalFiles,
      totalBytes: anchor.totalBytes,
      evictFiles: anchor.evict.length,
      evictBytes: anchor.evictBytes,
      deletedFiles: 0,
      // A dry run reports the bytes a reclaim would free, mirroring session-gc.
      freedBytes: options.dryRun ? anchor.evictBytes : 0,
      blockReasons: anchor.blockReasons,
    };
    if (anchor.blockReasons.length > 0 || anchor.evict.length === 0) {
      anchors.push(row);
      continue;
    }
    if (options.dryRun) {
      freedTotal += anchor.evictBytes;
      anchors.push(row);
      continue;
    }
    const sizeById = new Map(
      anchor.evict.map((candidate) => [candidate.artifactId, candidate.sizeBytes]),
    );
    try {
      const deleted = deps.deleteArtifacts(
        anchor.anchorId,
        anchor.evict.map((candidate) => candidate.artifactId),
      );
      row.deletedFiles = deleted.length;
      row.freedBytes = deleted.reduce((sum, id) => sum + (sizeById.get(id) ?? 0), 0);
      freedTotal += row.freedBytes;
      // A skipped id means the boundary re-check rejected it; that is a real anomaly, not
      // a silent no-op.
      errors += anchor.evict.length - deleted.length;
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      errors += 1;
    }
    anchors.push(row);
  }

  return {
    dryRun: options.dryRun,
    olderThanDays: plan.olderThanDays,
    maxBytesPerSession: plan.maxBytesPerSession,
    maxFilesPerSession: plan.maxFilesPerSession,
    limit: plan.limit,
    scanned: plan.scanned,
    anchors,
    totals: {
      anchors: anchors.length,
      evictFiles: anchors.reduce((sum, anchor) => sum + anchor.evictFiles, 0),
      evictBytes: anchors.reduce((sum, anchor) => sum + anchor.evictBytes, 0),
      freedBytes: freedTotal,
      errors,
    },
  };
}

export function createArtifactRetentionDeps(config: AppConfig): ArtifactRetentionDeps {
  return {
    deleteArtifacts: (anchorId, evictArtifactIds) => {
      const deleted: string[] = [];
      for (const artifactId of evictArtifactIds) {
        // Re-checked here, at the deletion boundary, against what is on disk right now:
        // the plan was built from a listing that may be seconds old, and a file that
        // stopped being an eligible automatic in the meantime must not be deleted.
        const artifact = readSessionArtifact(config.dataDir, anchorId, artifactId);
        if (!artifact || !isEvictableArtifact(artifact)) {
          continue;
        }
        if (deleteSessionArtifactById(config.dataDir, anchorId, artifactId)) {
          deleted.push(artifactId);
        }
      }
      return deleted;
    },
  };
}

export function listAnchorArtifacts(
  dataDir: string,
): (anchorId: string) => { artifacts: SessionArtifact[]; truncated: boolean } {
  return (anchorId) => listSessionArtifacts(dataDir, anchorId);
}
