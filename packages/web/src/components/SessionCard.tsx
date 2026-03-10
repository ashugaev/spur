"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  type DashboardSession,
  type AttentionLevel,
  getAttentionLevel,
  isPRRateLimited,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { CICheckList } from "./CIBadge";
import { ActivityDot } from "./ActivityDot";
import { buildSessionPath } from "@/lib/project-routes";

interface SessionCardProps {
  session: DashboardSession;
  projectId?: string;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

interface SessionCardTone {
  label: string;
  shellFrom: string;
  shellTo: string;
  outline: string;
  glow: string;
  shadow: string;
  accent: string;
  headerText: string;
}

type ChipTone = "positive" | "warning" | "critical" | "neutral" | "accent";

type BadgeIconKey =
  | "ci-passing"
  | "ci-pending"
  | "ci-failing"
  | "ci-unknown"
  | "review-approved"
  | "needs-review"
  | "changes-requested"
  | "merge-conflict"
  | "unresolved-comments"
  | "merged"
  | "draft"
  | "rate-limited"
  | "branch"
  | "default";

type ActionIconKey = "merge" | "send" | "terminal" | "restore";
type SourceKind = "linear" | "jira" | "session";

interface StatusChipModel {
  key: string;
  label: string;
  tone: ChipTone;
  icon: BadgeIconKey;
  href?: string;
  count?: number;
}

interface Alert {
  key: string;
  label: string;
  url: string;
  actionLabel?: string;
  actionMessage?: string;
}

const chipToneClassByTone: Record<ChipTone, string> = {
  positive: "border-[rgba(64,186,113,0.44)] bg-[rgba(12,73,43,0.9)] text-[#90e9b8]",
  warning: "border-[rgba(92,169,124,0.4)] bg-[rgba(19,65,42,0.9)] text-[#9fddb8]",
  critical: "border-[rgba(111,171,133,0.4)] bg-[rgba(24,58,41,0.9)] text-[#c0e8cf]",
  neutral: "border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] text-[rgba(231,238,247,0.8)]",
  accent: "border-[rgba(77,208,140,0.5)] bg-[rgba(14,91,55,0.92)] text-[#b7f5d3]",
};

const baseShellTone = {
  shellFrom: "rgba(10, 106, 66, 0.95)",
  shellTo: "rgba(8, 73, 47, 0.95)",
  outline: "rgba(42, 171, 105, 0.88)",
  glow: "rgba(34, 143, 91, 0.18)",
  shadow: "rgba(8, 59, 37, 0.34)",
  accent: "#3fc780",
  headerText: "#f0fff8",
} as const;

const sessionCardToneByLevel: Record<AttentionLevel, SessionCardTone> = {
  merge: {
    label: "Merge",
    ...baseShellTone,
  },
  respond: {
    label: "Respond",
    ...baseShellTone,
  },
  review: {
    label: "Review",
    ...baseShellTone,
  },
  pending: {
    label: "Pending",
    ...baseShellTone,
  },
  working: {
    label: "Running",
    ...baseShellTone,
  },
  done: {
    label: "Done",
    ...baseShellTone,
  },
};

const actionButtonBaseClass =
  "inline-flex items-center gap-1.5 rounded-[9px] border px-2.5 py-1 text-[9.5px] font-semibold uppercase tracking-[0.07em] transition-[background-color,border-color,color,filter]";

export function SessionCard({
  session,
  projectId,
  onSend,
  onKill,
  onMerge,
  onRestore,
}: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [sendingAction, setSendingAction] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const level = getAttentionLevel(session);
  const pr = session.pr;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleAction = (action: string, message: string) => {
    setSendingAction(action);
    onSend?.(session.id, message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSendingAction(null), 2000);
  };

  const rateLimited = pr ? isPRRateLimited(pr) : false;
  const alerts = getAlerts(session);
  const isReadyToMerge = !rateLimited && pr?.mergeability.mergeable && pr.state === "open";
  const isTerminal =
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity));
  const isRestorable = isTerminal && session.status !== "merged";
  const sessionLinkProjectId = projectId ?? session.projectId;
  const sessionLink = buildSessionPath(session.id, sessionLinkProjectId);
  const title = getSessionTitle(session);
  const tone = sessionCardToneByLevel[level];
  const sourceKind = getSourceKind(session);
  const shellStyle = {
    "--session-shell-from": tone.shellFrom,
    "--session-shell-to": tone.shellTo,
    "--session-outline": tone.outline,
    "--session-glow": tone.glow,
    "--session-shadow": tone.shadow,
    "--session-accent": tone.accent,
    "--session-header-text": tone.headerText,
  } as CSSProperties;
  const primaryChips = getPrimaryChips(session, rateLimited);
  const showAnyChips =
    primaryChips.length > 0 ||
    Boolean(session.branch && !pr) ||
    !isTerminal ||
    isRestorable ||
    isReadyToMerge ||
    alerts.some((alert) => alert.actionLabel && session.activity !== "active");

  return (
    <div
      className={cn(
        "session-card cursor-pointer overflow-hidden border",
        expanded && "session-card-expanded",
        pr?.state === "merged" && "opacity-70",
      )}
      style={shellStyle}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, textarea")) return;
        setExpanded(!expanded);
      }}
    >
      <div className="flex items-center justify-between gap-2.5 px-3.5 pb-2 pt-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-medium tracking-[-0.03em] text-[var(--session-header-text)]">
            {tone.label}
          </span>
          <span className="session-card-kicker inline-flex items-center gap-1.5 rounded-full px-[7px] py-0.5 text-[9px] font-medium text-[rgba(255,255,255,0.76)]">
            <ActivityDot activity={session.activity} dotOnly size={5} />
            <span>{session.id}</span>
          </span>
        </div>
        <div className="session-card-status-icon inline-flex h-6 w-6 shrink-0 items-center justify-center">
          <SessionCornerIcon level={level} />
        </div>
      </div>

      <div className="px-[9px] pb-[9px]">
        <div className="session-card-panel rounded-[14px] border px-3 py-[11px] sm:px-3.5 sm:py-3">
          <div className="flex items-start gap-2">
            {sourceKind && (
              <div className="session-card-source inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]">
                <SourceTileIcon kind={sourceKind} />
              </div>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.25 gap-y-1 leading-tight">
                {pr ? (
                  <>
                    <PullRequestInlineIcon />
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[12.5px] font-medium text-[rgba(237,244,255,0.92)] underline decoration-[rgba(212,229,255,0.4)] underline-offset-[3px] hover:text-white"
                    >
                      PR #{pr.number}
                    </a>
                  </>
                ) : (
                  <span className="text-[12.5px] font-medium text-[rgba(237,244,255,0.7)]">
                    Session {session.id}
                  </span>
                )}
                <span className="text-[12.5px] text-[rgba(210,220,235,0.48)]">→</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium tracking-[-0.02em] text-[rgba(249,251,255,0.93)] sm:text-[13.5px]">
                  {title}
                </span>
              </div>

              {showAnyChips && (
                <div className="mt-2.5 flex flex-wrap items-center gap-[5px]">
                  {primaryChips.map((chip) => (
                    <StatusChip key={chip.key} chip={chip} />
                  ))}

                  {session.branch && !pr && (
                    <StatusChip
                      chip={{
                        key: "branch",
                        label: session.branch,
                        tone: "neutral",
                        icon: "branch",
                      }}
                    />
                  )}

                  {isReadyToMerge && pr && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMerge?.(pr.number);
                      }}
                      className={cn(
                        actionButtonBaseClass,
                        "border-[rgba(101,214,149,0.48)] bg-[rgba(10,56,33,0.9)] text-[#a0ebc4] hover:border-[rgba(127,224,168,0.58)] hover:bg-[rgba(14,70,41,0.92)]",
                      )}
                    >
                      <ActionIcon icon="merge" />
                      Merge PR #{pr.number}
                    </button>
                  )}

                  {alerts
                    .filter((alert) => alert.actionLabel && session.activity !== "active")
                    .map((alert) => (
                      <button
                        key={`${alert.key}-action`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAction(alert.key, alert.actionMessage ?? "");
                        }}
                        disabled={sendingAction === alert.key}
                        className={cn(
                          actionButtonBaseClass,
                          "border-[rgba(102,199,154,0.42)] bg-[rgba(14,49,34,0.9)] text-[#aee8c8] hover:border-[rgba(130,212,171,0.52)] hover:bg-[rgba(18,61,42,0.92)] disabled:opacity-55",
                        )}
                      >
                        <ActionIcon icon="send" />
                        {sendingAction === alert.key ? "sent" : alert.actionLabel}
                      </button>
                    ))}

                  {!isTerminal && (
                    <a
                      href={sessionLink}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        actionButtonBaseClass,
                        "border-[rgba(255,255,255,0.17)] bg-[rgba(255,255,255,0.05)] text-[rgba(235,242,251,0.84)] hover:border-[rgba(255,255,255,0.28)] hover:bg-[rgba(255,255,255,0.09)] hover:no-underline",
                      )}
                    >
                      <ActionIcon icon="terminal" />
                      terminal
                    </a>
                  )}

                  {isRestorable && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestore?.(session.id);
                      }}
                      className={cn(
                        actionButtonBaseClass,
                        "border-[rgba(106,217,157,0.46)] bg-[rgba(10,53,33,0.9)] text-[#a8efc9] hover:border-[rgba(137,230,179,0.56)] hover:bg-[rgba(14,67,41,0.92)]",
                      )}
                    >
                      <ActionIcon icon="restore" />
                      restore
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="session-card-detail border-t px-4 py-4">
          {session.summary && pr?.title && session.summary !== pr.title && (
            <DetailSection label="Summary">
              <p className="text-[12px] leading-relaxed text-[rgba(220,227,238,0.78)]">
                {session.summary}
              </p>
            </DetailSection>
          )}

          {session.issueUrl && (
            <DetailSection label="Issue">
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-[#9be7dd] hover:underline"
              >
                {session.issueLabel || session.issueUrl}
                {session.issueTitle && `: ${session.issueTitle}`}
              </a>
            </DetailSection>
          )}

          {pr && pr.ciChecks.length > 0 && (
            <DetailSection label="CI Checks">
              <CICheckList checks={pr.ciChecks} />
            </DetailSection>
          )}

          {pr && pr.unresolvedComments.length > 0 && (
            <DetailSection label="Unresolved Comments">
              <div className="space-y-1">
                {pr.unresolvedComments.map((comment) => (
                  <div key={comment.url} className="flex items-center gap-2 text-[12px]">
                    <span className="w-3 shrink-0 text-center text-[#bce5ca]">●</span>
                    <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[10px] text-[rgba(220,227,238,0.68)]">
                      {comment.path}
                    </span>
                    <a
                      href={comment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-[11px] text-[#9be7dd] hover:underline"
                    >
                      view →
                    </a>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {pr && (
            <DetailSection label="PR">
              <p className="text-[12px] text-[rgba(220,227,238,0.78)]">
                <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {pr.title}
                </a>
                <br />
                <span className="text-[#93efcf]">+{pr.additions}</span>{" "}
                <span className="text-[#9adcb8]">-{pr.deletions}</span>
                {" · "}mergeable: {pr.mergeability.mergeable ? "yes" : "no"}
                {" · "}review: {pr.reviewDecision}
              </p>
            </DetailSection>
          )}

          {!pr && (
            <p className="text-[12px] text-[rgba(220,227,238,0.58)]">No PR associated with this session.</p>
          )}

          <div className="mt-4 flex gap-2 border-t border-[rgba(255,255,255,0.08)] pt-4">
            {isRestorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore?.(session.id);
                }}
                className={cn(
                  actionButtonBaseClass,
                  "border-[rgba(106,217,157,0.46)] bg-[rgba(10,53,33,0.9)] text-[#a8efc9] hover:border-[rgba(137,230,179,0.56)] hover:bg-[rgba(14,67,41,0.92)]",
                )}
              >
                <ActionIcon icon="restore" />
                restore session
              </button>
            )}
            {!isTerminal && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onKill?.(session.id);
                }}
                className={cn(
                  actionButtonBaseClass,
                  "border-[rgba(122,191,152,0.42)] bg-[rgba(22,54,39,0.9)] text-[#b6e2ca] hover:border-[rgba(145,207,174,0.54)] hover:bg-[rgba(29,68,49,0.92)]",
                )}
              >
                <ActionIcon icon="terminal" />
                terminate
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusChip({ chip }: { chip: StatusChipModel }) {
  const content = (
    <>
      <BadgeIcon icon={chip.icon} />
      {chip.count !== undefined && <span className="font-bold">{chip.count}</span>}
      <span>{chip.label}</span>
    </>
  );

  if (chip.href) {
    return (
      <a
        href={chip.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[4px] text-[9.5px] font-semibold tracking-[0.02em] hover:brightness-110 hover:no-underline",
          chipToneClassByTone[chip.tone],
        )}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[4px] text-[9.5px] font-semibold tracking-[0.02em]",
        chipToneClassByTone[chip.tone],
      )}
    >
      {content}
    </span>
  );
}

function BadgeIcon({ icon }: { icon: BadgeIconKey }) {
  switch (icon) {
    case "ci-passing":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12.5 10.8 15 16 9.5" />
        </svg>
      );
    case "ci-pending":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "ci-failing":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M9 4h6l5 5v6l-5 5H9l-5-5V9z" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </svg>
      );
    case "ci-unknown":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 1 1 3.8 2.2c-.9.5-1.3 1-1.3 1.8" />
          <path d="M12 17h.01" />
        </svg>
      );
    case "review-approved":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="m12 3 7 3v6c0 4-2.7 7-7 9-4.3-2-7-5-7-9V6z" />
          <path d="m9.3 12.2 1.9 1.8 3.7-3.8" />
        </svg>
      );
    case "needs-review":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case "changes-requested":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M4 20h4l10-10-4-4L4 16z" />
          <path d="m13 7 4 4" />
        </svg>
      );
    case "merge-conflict":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="M6 8v4a4 4 0 0 0 4 4h0" />
          <path d="M18 8v3a3 3 0 0 1-3 3h-1" />
        </svg>
      );
    case "unresolved-comments":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M5 5h14v10H9l-4 4z" />
          <path d="M9 9h6M9 12h4" />
        </svg>
      );
    case "merged":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="18" cy="5" r="2.5" />
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="18" cy="19" r="2.5" />
          <path d="M8.5 12H13a5 5 0 0 0 5-5" />
          <path d="M8.5 12H13a5 5 0 0 1 5 5" />
        </svg>
      );
    case "draft":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M7 3h8l4 4v14H7z" />
          <path d="M15 3v4h4" />
        </svg>
      );
    case "rate-limited":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M8 4h8v4l-2 2 2 2v4H8v-4l2-2-2-2z" />
        </svg>
      );
    case "branch":
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 6h6M18 8v8" />
        </svg>
      );
    default:
      return (
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="12" r="5" />
        </svg>
      );
  }
}

function ActionIcon({ icon }: { icon: ActionIconKey }) {
  if (icon === "merge") {
    return (
      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    );
  }

  if (icon === "send") {
    return (
      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="m3 11 18-8-8 18-2-7z" />
      </svg>
    );
  }

  if (icon === "restore") {
    return (
      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
      </svg>
    );
  }

  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m8 10 3 3-3 3" />
      <path d="M13 16h4" />
    </svg>
  );
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[rgba(220,227,238,0.5)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function getPrimaryChips(session: DashboardSession, rateLimited: boolean): StatusChipModel[] {
  const pr = session.pr;
  if (!pr) return [];

  if (rateLimited) {
    return [
      {
        key: "rate-limited",
        label: "PR data rate limited",
        tone: "neutral",
        icon: "rate-limited",
        href: pr.url,
      },
    ];
  }

  const chips: StatusChipModel[] = [];

  if (pr.state === "open" && !pr.isDraft) {
    if (pr.ciStatus === "passing") {
      chips.push({
        key: "ci-passing",
        label: "CI passing",
        tone: "positive",
        icon: "ci-passing",
        href: `${pr.url}/checks`,
      });
    } else if (pr.ciStatus === "pending") {
      chips.push({
        key: "ci-pending",
        label: "CI pending",
        tone: "warning",
        icon: "ci-pending",
        href: `${pr.url}/checks`,
      });
    } else if (pr.ciStatus === "failing") {
      const failedCount = pr.ciChecks.filter((check) => check.status === "failed").length;
      chips.push({
        key: "ci-failing",
        label: failedCount > 0 ? `${failedCount} CI check${failedCount > 1 ? "s" : ""} failing` : "CI unknown",
        tone: failedCount > 0 ? "critical" : "warning",
        icon: failedCount > 0 ? "ci-failing" : "ci-unknown",
        href: `${pr.url}/checks`,
      });
    }
  }

  if (pr.state === "merged") {
    chips.push({ key: "merged", label: "merged", tone: "accent", icon: "merged", href: pr.url });
  } else if (pr.isDraft && pr.state === "open") {
    chips.push({ key: "draft", label: "draft", tone: "neutral", icon: "draft", href: pr.url });
  }

  if (pr.state === "open") {
    if (pr.reviewDecision === "approved") {
      chips.push({
        key: "review-approved",
        label: "review approved",
        tone: "positive",
        icon: "review-approved",
        href: pr.url,
      });
    } else if (pr.reviewDecision === "changes_requested") {
      chips.push({
        key: "changes-requested",
        label: "changes requested",
        tone: "critical",
        icon: "changes-requested",
        href: pr.url,
      });
    } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
      chips.push({
        key: "needs-review",
        label: "needs review",
        tone: "warning",
        icon: "needs-review",
        href: pr.url,
      });
    }

    if (!pr.mergeability.noConflicts) {
      chips.push({
        key: "merge-conflict",
        label: "merge conflict",
        tone: "critical",
        icon: "merge-conflict",
        href: pr.url,
      });
    }

    if (pr.unresolvedThreads > 0) {
      chips.push({
        key: "unresolved-comments",
        label: "unresolved comments",
        count: pr.unresolvedThreads,
        tone: "critical",
        icon: "unresolved-comments",
        href: pr.unresolvedComments[0]?.url ?? `${pr.url}/files`,
      });
    }
  }

  return chips;
}

function getSourceKind(session: DashboardSession): SourceKind | null {
  const issueUrl = session.issueUrl?.toLowerCase() ?? "";
  if (issueUrl.includes("linear.app")) return "linear";
  if (issueUrl.includes("atlassian.net") || issueUrl.includes("jira")) return "jira";
  if (!session.pr) return "session";
  return null;
}

function SessionCornerIcon({ level }: { level: AttentionLevel }) {
  if (level === "merge" || level === "done") {
    return (
      <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24" aria-hidden>
        <path d="M5 13l4 4L19 7" />
      </svg>
    );
  }

  if (level === "respond") {
    return (
      <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
        <path d="M8 17l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8Z" />
        <path d="M12 8v4" />
        <path d="M12 15h.01" />
      </svg>
    );
  }

  if (level === "review") {
    return (
      <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
        <path d="m16.5 16.5 4 4" />
        <circle cx="11" cy="11" r="6" />
      </svg>
    );
  }

  if (level === "pending") {
    return (
      <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l2.5 2" />
      </svg>
    );
  }

  return (
    <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 12h4l2-5 3 10 2-5h5" />
    </svg>
  );
}

function PullRequestInlineIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-[rgba(239,244,255,0.95)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 21v-4a4.3 4.3 0 0 0-.9-2.8c2.9-.4 5.9-1.5 5.9-6.6a5 5 0 0 0-1.4-3.5 4.8 4.8 0 0 0-.1-3.4s-1.1-.3-3.6 1.3a12 12 0 0 0-6.4 0C6 .4 4.9.7 4.9.7a4.8 4.8 0 0 0-.1 3.4 5 5 0 0 0-1.4 3.5c0 5.1 3 6.2 5.9 6.6A4.3 4.3 0 0 0 8.4 17v4" />
      <path d="M8.4 18c-4 1.8-4.4-1.8-6.2-1.8" />
    </svg>
  );
}

function SourceTileIcon({ kind }: { kind: SourceKind }) {
  if (kind === "linear") {
    return (
      <svg
        className="h-[18px] w-[18px] text-[#5dc6ff]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6 18 13 6" />
        <path d="M11 18 18 6" />
        <path d="M6 6h6" />
      </svg>
    );
  }

  if (kind === "jira") {
    return (
      <svg className="h-[18px] w-[18px] text-[#78a8ff]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M6 5h8.7l3.3 3.3-5.2 5.2H4.1V7a2 2 0 0 1 2-2Z" opacity="0.92" />
        <path d="M11.2 10.5H20l-5.8 8H7.4z" opacity="0.68" />
      </svg>
    );
  }

  return (
    <svg
      className="h-[18px] w-[18px] text-[rgba(231,238,247,0.84)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m8 10 3 3-3 3" />
      <path d="M13 16h4" />
    </svg>
  );
}

function getAlerts(session: DashboardSession): Alert[] {
  const pr = session.pr;
  if (!pr || pr.state !== "open") return [];
  if (isPRRateLimited(pr)) return [];

  const alerts: Alert[] = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failedCheck = pr.ciChecks.find((check) => check.status === "failed");
    const failCount = pr.ciChecks.filter((check) => check.status === "failed").length;
    if (failCount > 0) {
      alerts.push({
        key: "ci-fail",
        label: `${failCount} CI check${failCount > 1 ? "s" : ""} failing`,
        url: failedCheck?.url ?? `${pr.url}/checks`,
        actionLabel: "ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
      });
    }
  }

  if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      label: "needs review",
      url: pr.url,
      actionLabel: "ask to post",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
    });
  }

  if (!pr.mergeability.noConflicts) {
    alerts.push({
      key: "conflict",
      label: "merge conflict",
      url: pr.url,
      actionLabel: "ask to fix",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
    });
  }

  if (pr.unresolvedThreads > 0) {
    alerts.push({
      key: "comments",
      label: "unresolved comments",
      url: pr.unresolvedComments[0]?.url ?? `${pr.url}/files`,
      actionLabel: "ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
    });
  }

  return alerts;
}
