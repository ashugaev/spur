import { createReviewSourceModule } from "./review-source.js";

export { resolveMergeRequestSummary } from "../review-providers/gitlab.js";

export const gitlabSourceModule = createReviewSourceModule("gitlab");
