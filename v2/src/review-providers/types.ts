import type { ReviewEventData, ReviewProviderId, ReviewSignal, SessionRecord } from "../types.js";

export interface ReviewProvider {
  id: ReviewProviderId;
  displayName: string;
  requestLabel: string;
  requestLabelPlural: string;
  instructionsLine: string;
  commandLine: string;
  findReviewUrlByBranch(worktreePath: string, branch: string): Promise<string | null>;
  collectSignals(
    session: SessionRecord,
    dataDir: string,
    projectId: string,
    sourceId: string,
  ): Promise<{
    data: ReviewEventData;
    snapshot: Map<string, ReviewSignal>;
    ciActive?: boolean;
    // True when the provider's own CI-check fetch failed (as opposed to genuinely
    // observing zero active checks). Callers that track CI-active hysteresis across
    // cycles must not count this session as a "clean" observation when true.
    ciCheckFetchFailed?: boolean;
  } | null>;
}
