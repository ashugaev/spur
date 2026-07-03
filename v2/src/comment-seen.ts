import { recordCommentSeen } from "./metadata.js";
import { reviewCommentSeenKey } from "./review-providers/github.js";
import type { AppConfig } from "./types.js";

export function recordReviewCommentsSeen(
  config: Pick<AppConfig, "dataDir" | "projects">,
  projectId: string,
  ids: readonly (number | string)[],
): void {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const keys = ids.map(reviewCommentSeenKey);
  for (const [sourceId, source] of Object.entries(project.sources)) {
    if (source.type !== "github") continue;
    recordCommentSeen(config.dataDir, projectId, sourceId, keys);
  }
}
