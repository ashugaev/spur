import { recordWorkItem } from "../metadata.js";
import type { SourceConfig } from "../types.js";
import type { SourceStartDeps } from "./types.js";

// First-poll emits for a repo absent from the registry are capped so a backlog
// of existing work items cannot spawn an unbounded burst of agents. Every
// returned item is still recorded as seen regardless of the cap.
export const WORK_ITEM_FIRST_POLL_EMIT_CAP = 10;

export interface WorkItemCandidate<TData> {
  repo: string;
  externalId: string;
  data: TData;
}

// Records each unseen candidate and emits it as `eventName`, except for a
// repo's first-poll backlog (a repo with no prior seen entries). Such backlog
// items are recorded but suppressed unless `emitExisting` is set, in which case
// they are emitted up to WORK_ITEM_FIRST_POLL_EMIT_CAP per repo.
export function emitWorkItemBacklog<TData>(
  deps: SourceStartDeps<Extract<SourceConfig, { emitExisting: boolean }>>,
  eventName: string,
  seen: Set<string>,
  candidates: Iterable<WorkItemCandidate<TData>>,
): void {
  const reposWithSeenEntries = new Set([...seen].map((id) => id.split("#")[0]));
  const firstPollEmitCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.externalId)) continue;
    recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, candidate.externalId);
    seen.add(candidate.externalId);
    if (!reposWithSeenEntries.has(candidate.repo)) {
      if (!deps.config.emitExisting) continue;
      const emitted = firstPollEmitCounts.get(candidate.repo) ?? 0;
      if (emitted >= WORK_ITEM_FIRST_POLL_EMIT_CAP) continue;
      firstPollEmitCounts.set(candidate.repo, emitted + 1);
    }
    deps.emit<TData>(eventName, candidate.data);
  }
}
