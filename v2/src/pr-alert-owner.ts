import { githubFeedbackIdentity } from "./review-providers/github.js";
import { workspaceIdOf } from "./session-desk.js";
import { readPrAlertOwnership, resolveWorkspaceState } from "./workspace-store.js";
import type { PersistedSendBatch, ProjectConfig, ReviewEventData, SessionRecord } from "./types.js";

export class PrAlertOwnerRequestError extends Error {
  readonly statusCode: 400 | 409;
  readonly payload: { code: "pr_alert_owner_invalid" | "pr_alert_owner_conflict"; error: string };

  constructor(kind: "invalid" | "conflict", message: string) {
    super(message);
    this.statusCode = kind === "invalid" ? 400 : 409;
    this.payload = {
      code: kind === "invalid" ? "pr_alert_owner_invalid" : "pr_alert_owner_conflict",
      error: message,
    };
  }
}

export function assertPrAlertRoutes(
  project: ProjectConfig,
  allowedTriggers?: readonly string[],
): void {
  const permitted = new Set<string>();
  for (const [id, trigger] of Object.entries(project.triggers)) {
    if (
      "send" in trigger &&
      project.sources[trigger.source]?.type === "github" &&
      (allowedTriggers === undefined || allowedTriggers.includes(id))
    )
      permitted.add(trigger.event);
  }
  for (const event of ["github:ci_failed", "github:merge_conflict"]) {
    if (!permitted.has(event))
      throw new PrAlertOwnerRequestError(
        "invalid",
        `prAlertOwner requires an allowed ${event} send route`,
      );
  }
}

export function isPrAlertEvent(event: string): boolean {
  return event === "github:ci_failed" || event === "github:merge_conflict";
}

export function allowsPrAlertIdentity(
  dataDir: string,
  session: SessionRecord,
  identity: Pick<ReviewEventData, "prUrl" | "prNumber" | "repo">,
): boolean {
  const owner = readPrAlertOwnership(dataDir, workspaceIdOf(session));
  if (owner.state === "unclaimed") return true;
  if (owner.state !== "owned" || owner.sessionId !== session.id) return false;
  if (!identity.prUrl) return false;
  const { pr } = resolveWorkspaceState(dataDir, session);
  if (!pr || pr.number !== identity.prNumber) return false;
  try {
    const actual = githubFeedbackIdentity(identity.prUrl, identity.prNumber, identity.repo);
    const current = githubFeedbackIdentity(pr.url, pr.number, pr.repo);
    return (
      actual.hostname.toLowerCase() === current.hostname.toLowerCase() &&
      actual.repo === current.repo
    );
  } catch {
    return false;
  }
}

export function allowsPrAlertBatch(
  dataDir: string,
  session: SessionRecord,
  batch: PersistedSendBatch,
): boolean {
  if (batch.kind === "review" && batch.providerId === "github")
    return allowsPrAlertIdentity(dataDir, session, batch);
  return readPrAlertOwnership(dataDir, workspaceIdOf(session)).state === "unclaimed";
}
