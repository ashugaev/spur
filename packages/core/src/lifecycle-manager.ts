/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Replaces the legacy scripts/claude-session-status and scripts/claude-review-check
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
  type MergeReadiness,
  type ReviewComment,
  type PipelineEngine,
  type EventBus,
  type PipelineStep,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

const execFileAsync = promisify(execFile);

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (
    type.includes("fail") ||
    type.includes("changes_requested") ||
    type.includes("comments_unresolved") ||
    type.includes("conflicts")
  ) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "review.comments_unresolved":
      return "review-comments";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  healthHooks?: LifecycleHealthHooks;
  pipelineEngine?: PipelineEngine;
  eventBus?: EventBus;
}

export interface LifecycleHealthHooks {
  onPollStarting?: (message: string) => void;
  onPollHealthy?: (message: string) => void;
  onPollDegraded?: (message: string, error?: unknown) => void;
  onPollInactive?: (message: string) => void;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
  escalated?: boolean;
}

interface DeterminedSessionStatus {
  status: SessionStatus;
  hasMergeConflictBlockers: boolean;
}

function hasMergeConflictBlockers(blockers: string[]): boolean {
  return blockers.some((blocker) => {
    const normalized = blocker.toLowerCase();
    return normalized.includes("merge conflicts") || normalized.includes("behind base branch");
  });
}

function pendingCommentsFingerprint(comments: ReviewComment[]): string {
  if (comments.length === 0) return "";
  return comments
    .map((comment) =>
      JSON.stringify([
        comment.id,
        comment.author,
        comment.body,
        comment.path ?? "",
        comment.line ?? "",
        comment.url,
      ]),
    )
    .sort()
    .join("|");
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, healthHooks } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const mergeConflictStates = new Map<SessionId, boolean>();
  const reviewCommentFingerprints = new Map<SessionId, string>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  function resolveReactionConfig(session: Session, reactionKey: string): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction ? { ...globalReaction, ...projectReaction } : globalReaction;
    if (!reactionConfig || !reactionConfig.action) return null;
    return reactionConfig as ReactionConfig;
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<DeterminedSessionStatus> {
    const result = (
      status: SessionStatus,
      hasConflicts: boolean = false,
    ): DeterminedSessionStatus => ({
      status,
      hasMergeConflictBlockers: hasConflicts,
    });

    const project = config.projects[session.projectId];
    if (!project) return result(session.status);

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) {
          // Runtime dead — ask agent plugin to distinguish clean exit from crash.
          // getActivityState returns null for clean completion (e.g. last JSONL
          // entry is "result"), { state: "exited" } for crashes.
          if (agent) {
            try {
              const activity = await agent.getActivityState(session, config.readyThresholdMs);
              if (activity === null) return result("done");
            } catch {
              // Can't determine — treat as killed
            }
          }
          return result("killed");
        }
      }
    }

    // 2. Check agent activity — prefer JSONL-based detection (runtime-agnostic)
    if (agent && session.runtimeHandle) {
      try {
        // Try JSONL-based activity detection first (reads agent's session files directly)
        const activityState = await agent.getActivityState(session, config.readyThresholdMs);
        if (activityState) {
          if (activityState.state === "waiting_input") return result("needs_input");
          if (activityState.state === "exited") return result("killed");
          // active/ready/idle/blocked — proceed to PR checks below
        } else {
          // getActivityState returned null — fall back to terminal output parsing
          const runtime = registry.get<Runtime>(
            "runtime",
            project.runtime ?? config.defaults.runtime,
          );
          const terminalOutput = runtime
            ? await runtime.getOutput(session.runtimeHandle, 10)
            : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            if (activity === "waiting_input") return result("needs_input");

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) return result("killed");
          }
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return result(session.status);
        }
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!session.pr && scm && session.branch) {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch {
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    if (session.pr && scm) {
      try {
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return result("merged");
        if (prState === PR_STATE.CLOSED) return result("killed");

        // Monitor merge conflicts continuously, similar to CI/review polling.
        // Reuse the same mergeability payload for approved-path status decisions
        // to avoid duplicate API calls in a single poll cycle.
        let mergeReadiness: MergeReadiness | null = null;
        try {
          const readiness = await scm.getMergeability(session.pr);
          if (readiness && Array.isArray(readiness.blockers)) {
            mergeReadiness = readiness;
          }
        } catch {
          // Keep lifecycle status checks running even if mergeability probe fails.
        }
        const hasConflictBlockers = !!(
          mergeReadiness && hasMergeConflictBlockers(mergeReadiness.blockers)
        );

        if (mergeReadiness) {
          session.pr.isDraft = mergeReadiness.isDraft;
        }

        // Check CI — skip for draft PRs (CI jobs are expected to be inactive)
        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING && !session.pr.isDraft) {
          return result("ci_failed", hasConflictBlockers);
        }

        // Check reviews
        const reviewDecision = await scm.getReviewDecision(session.pr);
        if (reviewDecision === "changes_requested") {
          return result("changes_requested", hasConflictBlockers);
        }
        if (reviewDecision === "approved") {
          if (mergeReadiness?.mergeable) return result("mergeable", hasConflictBlockers);
          return result("approved", hasConflictBlockers);
        }
        if (reviewDecision === "pending") return result("review_pending", hasConflictBlockers);

        return result("pr_open", hasConflictBlockers);
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 5. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return result("working");
    }
    return result(session.status);
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      if (!tracker.escalated) {
        tracker.escalated = true;
        const event = createEvent("reaction.escalated", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
          data: { reactionKey, attempts: tracker.attempts },
        });
        await notifyHuman(event, reactionConfig.priority ?? "urgent");
      }
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "restore": {
        try {
          const session = await sessionManager.get(sessionId);
          if (!session) {
            const reason = `Session '${sessionId}' not found`;
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' restore failed: ${reason}`,
              data: { reactionKey, reason },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "restore",
              message: reason,
              escalated: false,
            };
          }

          if (session.metadata["terminationReason"] === "restore-failed") {
            return {
              reactionType: reactionKey,
              success: false,
              action: "restore",
              message: "Previously failed to restore, skipping",
              escalated: false,
            };
          }

          if (session.pr) {
            const project = config.projects[session.projectId];
            const scm = project?.scm
              ? registry.get<SCM>("scm", project.scm.plugin)
              : null;
            if (scm) {
              const prState = await scm.getPRState(session.pr).catch(() => null);
              if (prState === PR_STATE.MERGED || prState === PR_STATE.CLOSED) {
                const reason = `PR is ${prState}, restore skipped`;
                const event = createEvent("reaction.triggered", {
                  sessionId,
                  projectId,
                  message: `Reaction '${reactionKey}' restore skipped: ${reason}`,
                  data: { reactionKey, reason },
                });
                await notifyHuman(event, "info");
                return {
                  reactionType: reactionKey,
                  success: false,
                  action: "restore",
                  message: reason,
                  escalated: false,
                };
              }
            }
          }

          const restored = await sessionManager.restore(sessionId);

          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' auto-restored session ${sessionId}`,
            data: { reactionKey },
          });
          await notifyHuman(event, "action");

          states.set(sessionId, restored.status);

          return {
            reactionType: reactionKey,
            success: true,
            action: "restore",
            message: `Restored session ${sessionId}`,
            escalated: false,
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Restore failed";

          const project = config.projects[projectId];
          if (project) {
            const sessionsDir = getSessionsDir(config.configPath, project.path);
            updateMetadata(sessionsDir, sessionId, { terminationReason: "restore-failed" });
          }

          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' restore failed: ${reason}`,
            data: { reactionKey, reason },
          });
          await notifyHuman(event, "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action: "restore",
            message: reason,
            escalated: false,
          };
        }
      }

      case "auto-merge": {
        try {
          const session = await sessionManager.get(sessionId);
          if (!session) {
            const reason = `Session '${sessionId}' not found`;
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' auto-merge failed: ${reason}`,
              data: { reactionKey, reason },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "auto-merge",
              message: reason,
              escalated: false,
            };
          }

          const project = config.projects[session.projectId];
          if (!project) {
            const reason = `Project '${session.projectId}' not configured`;
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' auto-merge failed: ${reason}`,
              data: { reactionKey, reason },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "auto-merge",
              message: reason,
              escalated: false,
            };
          }

          if (!session.pr) {
            const reason = "No PR attached to session";
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' auto-merge skipped: ${reason}`,
              data: { reactionKey, reason },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "auto-merge",
              message: reason,
              escalated: false,
            };
          }

          const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
          if (!scm) {
            const reason = "No SCM plugin configured for this project";
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' auto-merge failed: ${reason}`,
              data: { reactionKey, reason },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "auto-merge",
              message: reason,
              escalated: false,
            };
          }

          const prState = await scm.getPRState(session.pr);
          if (prState !== PR_STATE.OPEN) {
            const reason = `PR is ${prState}, not open`;
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' auto-merge skipped: ${reason}`,
              data: { reactionKey, reason, prNumber: session.pr.number },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "auto-merge",
              message: reason,
              escalated: false,
            };
          }

          const mergeability = await scm.getMergeability(session.pr);
          if (!mergeability.mergeable) {
            const reason =
              mergeability.blockers.length > 0
                ? `PR not mergeable: ${mergeability.blockers.join(", ")}`
                : "PR not mergeable";
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' auto-merge skipped: ${reason}`,
              data: {
                reactionKey,
                reason,
                prNumber: session.pr.number,
                blockers: mergeability.blockers,
              },
            });
            await notifyHuman(event, "warning");
            return {
              reactionType: reactionKey,
              success: false,
              action: "auto-merge",
              message: reason,
              escalated: false,
            };
          }

          const mergeMethod = reactionConfig.mergeMethod ?? "merge";
          await scm.mergePR(session.pr, mergeMethod);

          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' auto-merged PR #${session.pr.number}`,
            data: { reactionKey, prNumber: session.pr.number, mergeMethod },
          });
          await notifyHuman(event, "action");
          return {
            reactionType: reactionKey,
            success: true,
            action: "auto-merge",
            message: `Merged PR #${session.pr.number}`,
            escalated: false,
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Auto-merge failed";
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' auto-merge failed: ${reason}`,
            data: { reactionKey, reason },
          });
          await notifyHuman(event, "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message: reason,
            escalated: false,
          };
        }
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const determined = await determineStatus(session);
    const newStatus = determined.status;
    const hadMergeConflicts = mergeConflictStates.get(session.id) ?? false;
    const hasMergeConflicts = determined.hasMergeConflictBlockers;
    let changesRequestedHandledBySendToAgent = false;
    let hasNewReviewComments = false;

    if (newStatus !== oldStatus) {
      // State transition detected
      states.set(session.id, newStatus);

      // Update metadata — session.projectId is the config key (e.g., "my-app")
      const project = config.projects[session.projectId];
      if (project) {
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        const metaUpdate: Record<string, string> = { status: newStatus };
        if (newStatus === "killed") {
          metaUpdate["terminationReason"] = "system";
        }
        updateMetadata(sessionsDir, session.id, metaUpdate);
      }

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          reactionTrackers.delete(`${session.id}:${oldReactionKey}`);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = resolveReactionConfig(session, reactionKey);
          if (reactionConfig) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
              );
              if (
                reactionKey === "changes-requested" &&
                reactionResult.action === "send-to-agent" &&
                reactionResult.success
              ) {
                changesRequestedHandledBySendToAgent = true;
              }
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For significant transitions not already notified by a reaction, notify humans
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          if (priority !== "info") {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: ${oldStatus} → ${newStatus}`,
              data: { oldStatus, newStatus },
            });
            await notifyHuman(event, priority);
          }
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    // Trigger review-comments reaction when unresolved comments change, independent of status transitions.
    const projectConfig = config.projects[session.projectId];
    const scm = projectConfig?.scm ? registry.get<SCM>("scm", projectConfig.scm.plugin) : null;
    if (session.pr && scm) {
      try {
        const pendingCommentsRaw = await scm.getPendingComments(session.pr);
        const pendingComments = Array.isArray(pendingCommentsRaw) ? pendingCommentsRaw : [];
        const fingerprint = pendingCommentsFingerprint(pendingComments);
        const previousFingerprint = reviewCommentFingerprints.get(session.id) ?? "";
        const hasPendingComments = pendingComments.length > 0;
        const commentsChanged = fingerprint !== previousFingerprint;

        if (commentsChanged) {
          reviewCommentFingerprints.set(session.id, fingerprint);
        }

        if (!hasPendingComments) {
          reactionTrackers.delete(`${session.id}:review-comments`);
        }

        if (hasPendingComments && commentsChanged && !changesRequestedHandledBySendToAgent) {
          hasNewReviewComments = true;
          const eventType: EventType = "review.comments_unresolved";
          let reactionHandledNotify = false;
          const reactionKey = eventToReactionKey(eventType);

          if (reactionKey) {
            const reactionConfig = resolveReactionConfig(session, reactionKey);
            if (reactionConfig) {
              if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
                await executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
                reactionHandledNotify = true;
              }
            }
          }

          if (!reactionHandledNotify) {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: ${pendingComments.length} unresolved review comment(s)`,
              data: { pendingComments: pendingComments.length },
            });
            await notifyHuman(event, inferPriority(eventType));
          }
        }
      } catch {
        // Keep lifecycle checks running if pending-comment polling fails.
      }
    } else {
      reviewCommentFingerprints.delete(session.id);
      reactionTrackers.delete(`${session.id}:review-comments`);
    }

    // Trigger merge-conflicts reaction once per conflict period, independent of status transitions.
    if (hasMergeConflicts && !hadMergeConflicts) {
      const eventType: EventType = "merge.conflicts";
      let reactionHandledNotify = false;
      const reactionKey = eventToReactionKey(eventType);

      if (reactionKey) {
        const reactionConfig = resolveReactionConfig(session, reactionKey);
        if (reactionConfig) {
          if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
            await executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
            reactionHandledNotify = true;
          }
        }
      }

      if (!reactionHandledNotify) {
        const event = createEvent(eventType, {
          sessionId: session.id,
          projectId: session.projectId,
          message: `${session.id}: merge conflicts detected`,
        });
        await notifyHuman(event, inferPriority(eventType));
      }
    }

    // Conflict condition cleared — allow merge-conflicts reaction retry on future reoccurrence.
    if (!hasMergeConflicts && hadMergeConflicts) {
      reactionTrackers.delete(`${session.id}:merge-conflicts`);
    }
    mergeConflictStates.set(session.id, hasMergeConflicts);

    // Pipeline evaluation — tick the pipeline engine with already-computed session events.
    // Runs AFTER reactions so review-comments flag is available.
    if (deps.pipelineEngine) {
      const pipelineState = deps.pipelineEngine.getState(session.id);
      if (pipelineState && pipelineState.state === "running") {
        const events: Record<string, unknown> = {};
        events["session.status"] = newStatus;
        if (newStatus === "killed" || newStatus === "merged") events["session.finished"] = true;

        // Reaction-style event names (match pipeline on: handler keys)
        if (newStatus === "ci_failed") events["ci-failed"] = true;
        if (newStatus === "changes_requested") events["changes-requested"] = true;
        if (hasMergeConflicts) events["merge-conflicts"] = true;
        if (hasNewReviewComments) events["review-comments"] = true;

        if (session.pr) {
          events["pr.created"] = true;
          events["pr.state"] = newStatus === "merged" ? "merged" : "open";
          if (newStatus === "ci_failed") {
            events["ci.status"] = "failing";
          } else if (newStatus === "approved" || newStatus === "mergeable" || newStatus === "merged") {
            events["ci.status"] = "passing";
            events["ci.passing"] = true;
          }
          if (newStatus === "approved" || newStatus === "mergeable") {
            events["review.approved"] = true;
          }
          if (newStatus === "mergeable") {
            events["merge.ready"] = true;
          }
        }

        deps.pipelineEngine.tick(session.id, events);

        await executePipelineRunStep(session);
      }
    }
  }

  async function executePipelineRunStep(session: Session): Promise<void> {
    if (!deps.pipelineEngine) return;
    const pipelineState = deps.pipelineEngine.getState(session.id);
    if (!pipelineState || pipelineState.state !== "running") return;

    const stepState = pipelineState.steps[pipelineState.currentStepIndex];
    if (!stepState || stepState.state !== "running") return;

    const project = config.projects[session.projectId];
    if (!project?.pipeline?.steps) return;

    const stepCfg: PipelineStep | undefined = project.pipeline.steps[pipelineState.currentStepIndex];
    if (!stepCfg?.run) return;

    const cwd = session.workspacePath ?? project.path;
    try {
      // run: values come from admin-authored YAML config (same trust level as
      // postCreate hooks). Shell execution via sh -c is intentional here.
      const { stdout } = await execFileAsync("sh", ["-c", stepCfg.run], {
        timeout: 30_000,
        cwd,
      });
      deps.pipelineEngine.done(session.id, { stdout, exitCode: 0 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "run step failed";
      deps.pipelineEngine.fail(session.id, message);
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list();

      // On first poll, seed tracked state from metadata so sessions already
      // in a terminal state are never re-processed (prevents one-time spurious
      // restore notifications on lifecycle manager restart).
      const TERMINAL_SEED: ReadonlySet<string> = new Set(["killed", "stopped", "done", "merged", "terminated"]);
      for (const s of sessions) {
        if (states.has(s.id)) continue;
        const metaStatus = s.metadata?.["status"] as string | undefined;
        if (metaStatus && TERMINAL_SEED.has(metaStatus)) {
          states.set(s.id, metaStatus as SessionStatus);
        }
      }

      // Load persisted pipeline state for sessions on cold restart
      if (deps.pipelineEngine) {
        for (const s of sessions) {
          if (!deps.pipelineEngine.getState(s.id)) {
            const project = config.projects[s.projectId];
            deps.pipelineEngine.load(s.id, project?.pipeline);
          }
        }
      }

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (s.status !== "merged" && s.status !== "killed" && s.status !== "stopped") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackedId of mergeConflictStates.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          mergeConflictStates.delete(trackedId);
        }
      }
      for (const trackedId of reviewCommentFingerprints.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          reviewCommentFingerprints.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => s.status !== "merged" && s.status !== "killed" && s.status !== "stopped");
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
      healthHooks?.onPollHealthy?.(
        `Lifecycle poll completed (${sessionsToCheck.length} session(s) checked, ${activeSessions.length} active)`,
      );
    } catch (error) {
      // Poll cycle failed — will retry next interval
      healthHooks?.onPollDegraded?.("Lifecycle poll cycle failed", error);
    } finally {
      polling = false;
    }
  }

  const pipelineCleanups: Array<() => void> = [];
  if (deps.eventBus && deps.pipelineEngine) {
    pipelineCleanups.push(
      deps.eventBus.on("pipeline.send", (data: unknown) => {
        if (data && typeof data === "object" && "sessionId" in data && "message" in data) {
          const { sessionId, message } = data as { sessionId: string; message: string };
          if (sessionId && message) {
            void sessionManager.send(sessionId, message);
          }
        }
      }),
    );
    pipelineCleanups.push(
      deps.eventBus.on("pipeline.ask", (data: unknown) => {
        if (data && typeof data === "object" && "sessionId" in data && "question" in data) {
          const { sessionId, question } = data as { sessionId: string; question: string };
          if (sessionId && question) {
            const event = createEvent("session.needs_input", {
              sessionId,
              projectId: "pipeline",
              message: `Pipeline asks: ${question}`,
              data: { question },
            });
            void notifyHuman(event, "action");
          }
        }
      }),
    );
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      healthHooks?.onPollStarting?.("Starting lifecycle polling runtime");
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const cleanup of pipelineCleanups) {
        cleanup();
      }
      pipelineCleanups.length = 0;
      healthHooks?.onPollInactive?.("Lifecycle polling stopped");
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
