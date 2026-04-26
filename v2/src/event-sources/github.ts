import { createReviewSourceModule } from "./review-source.js";

export {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolvePrSummary,
} from "../review-providers/github.js";

export type { GitHubCheck, GitHubPrSummary } from "../types.js";

export const githubSourceModule = createReviewSourceModule("github");
