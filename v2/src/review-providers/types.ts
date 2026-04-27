import type {
  ReviewEventData,
  ReviewProviderId,
  ReviewSignal,
  SessionRecord,
} from "../types.js";

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
  ): Promise<{ data: ReviewEventData; snapshot: Map<string, ReviewSignal> } | null>;
}
