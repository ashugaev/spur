"use client";

import { type DashboardPR, type DashboardSession, isPRRateLimited } from "@/lib/types";
import { buildSessionPath } from "@/lib/project-routes";
import { CIBadge } from "./CIBadge";
import { ActivityDot } from "./ActivityDot";

function getSizeLabel(additions: number, deletions: number): string {
  const size = additions + deletions;
  return size > 1000 ? "XL" : size > 500 ? "L" : size > 200 ? "M" : size > 50 ? "S" : "XS";
}

interface PRStatusProps {
  pr: DashboardPR;
}

function getPRLifecycleBadge(pr: Pick<DashboardPR, "state" | "isDraft">): {
  label: "draft" | "open" | "merged" | "closed";
  className: string;
} | null {
  if (pr.state === "merged") {
    return {
      label: "merged",
      className:
        "inline-flex items-center rounded-full bg-[rgba(163,113,247,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-violet)]",
    };
  }

  if (pr.state === "closed") {
    return {
      label: "closed",
      className:
        "inline-flex items-center rounded-full bg-[rgba(248,81,73,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-red)]",
    };
  }

  if (pr.isDraft) {
    return {
      label: "draft",
      className:
        "inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]",
    };
  }

  if (pr.state === "open") {
    return {
      label: "open",
      className:
        "inline-flex items-center rounded-full bg-[rgba(88,166,255,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-status-working)]",
    };
  }

  return null;
}

export function PRStatus({ pr }: PRStatusProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const lifecycleBadge = getPRLifecycleBadge(pr);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* PR number */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        #{pr.number}
      </a>

      {/* Size — hide when rate limited (would show +0 -0 XS) */}
      {!rateLimited && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          +{pr.additions} -{pr.deletions} {sizeLabel}
        </span>
      )}

      {lifecycleBadge && (
        <span className={lifecycleBadge.className}>
          {lifecycleBadge.label}
        </span>
      )}

      {/* CI status — only when we have real data */}
      {pr.state === "open" && !pr.isDraft && !rateLimited && (
        <CIBadge status={pr.ciStatus} checks={pr.ciChecks} />
      )}

      {/* Review decision (only for open PRs with real data) */}
      {pr.state === "open" && pr.reviewDecision === "approved" && !rateLimited && (
        <span className="inline-flex items-center rounded-full bg-[rgba(63,185,80,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-green)]">
          approved
        </span>
      )}
    </div>
  );
}

interface PRTableRowProps {
  pr: DashboardPR;
  session?: DashboardSession;
  onRestore?: (sessionId: string) => void;
}

export function PRTableRow({ pr, session, onRestore }: PRTableRowProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const lifecycleBadge = getPRLifecycleBadge(pr);

  const reviewLabel = rateLimited
    ? "—"
    : pr.isDraft
      ? "draft"
      : pr.reviewDecision === "approved"
        ? "approved"
        : pr.reviewDecision === "changes_requested"
          ? "changes requested"
          : "needs review";

  const reviewClass = rateLimited
    ? "text-[var(--color-text-tertiary)]"
    : pr.isDraft
      ? "text-[var(--color-text-muted)]"
      : pr.reviewDecision === "approved"
        ? "text-[var(--color-accent-green)]"
        : pr.reviewDecision === "changes_requested"
          ? "text-[var(--color-accent-red)]"
          : "text-[var(--color-accent-yellow)]";

  return (
    <tr className="border-b border-[var(--color-border-muted)] hover:bg-[rgba(88,166,255,0.03)]">
      <td className="px-3 py-2.5 text-sm">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          #{pr.number}
        </a>
      </td>
      <td className="max-w-[420px] truncate px-3 py-2.5 text-sm font-medium">{pr.title}</td>
      <td className="px-3 py-2.5">
        {lifecycleBadge ? (
          <span className={lifecycleBadge.className}>{lifecycleBadge.label}</span>
        ) : (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm">
        {rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <>
            <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>{" "}
            <span className="text-[var(--color-text-muted)]">{sizeLabel}</span>
          </>
        )}
      </td>
      <td className="px-3 py-2.5">
        {rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <CIBadge status={pr.ciStatus} checks={pr.ciChecks} compact />
        )}
      </td>
      <td className={`px-3 py-2.5 text-xs font-semibold ${reviewClass}`}>{reviewLabel}</td>
      <td
        className={`px-3 py-2.5 text-center text-sm font-bold ${pr.unresolvedThreads > 0 ? "text-[var(--color-accent-red)]" : "text-[var(--color-border-default)]"}`}
      >
        {pr.unresolvedThreads}
      </td>
      <td className="px-3 py-2.5">
        {session ? (
          <a
            href={buildSessionPath(session.id, session.projectId)}
            className="inline-flex items-center gap-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] hover:underline"
          >
            {session.id}
          </a>
        ) : (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {session ? (
          session.status === "killed" || session.status === "terminated" ? (
            <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-[rgba(248,81,73,0.1)] text-[var(--color-accent-red)]">
              {session.status}
            </span>
          ) : (
            <ActivityDot activity={session.activity} />
          )
        ) : (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        {(session?.status === "killed" || session?.status === "terminated") && onRestore && (
          <button
            type="button"
            onClick={() => onRestore(session.id)}
            className="rounded border border-[rgba(210,153,34,0.45)] bg-[rgba(210,153,34,0.12)] px-2 py-1 text-[11px] font-medium text-[var(--color-status-attention)] hover:bg-[rgba(210,153,34,0.2)]"
          >
            Reactivate
          </button>
        )}
      </td>
    </tr>
  );
}
