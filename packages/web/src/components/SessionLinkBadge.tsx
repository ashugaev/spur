"use client";

import type { CSSProperties } from "react";
import {
  CiStatusDot,
  extractLinkId,
  GithubIcon,
  GitlabIcon,
  isReviewLinkLabel,
  isTrackerLinkLabel,
  JiraIcon,
  type PrInfo,
  prStateColor,
  reviewProviderFromUrl,
  ReviewCommentsBadge,
  ReviewDecisionDot,
  usePrInfo,
} from "@/lib/link-icons";
import type { SpurSessionLink } from "@/lib/types";

interface SessionLinkBadgeProps {
  link: SpurSessionLink;
  prInfo?: PrInfo;
}

function hoverClassForLink(link: SpurSessionLink): string {
  if (isTrackerLinkLabel(link.label)) {
    return "hover:text-[var(--color-status-attention)]";
  }
  return "hover:text-[var(--color-text-primary)]";
}

function trackerStatusClass(status: SpurSessionLink["status"]): string | null {
  if (status?.canonical === "backlog") {
    return "bg-[var(--color-text-tertiary)]";
  }
  if (status?.canonical === "in_progress") {
    return "bg-[var(--color-status-working)]";
  }
  if (status?.canonical === "done") {
    return "bg-[var(--color-status-ready)]";
  }
  return null;
}

function trackerStatusLabel(status: SpurSessionLink["status"]): string {
  if (status?.canonical === "backlog") return "Backlog";
  if (status?.canonical === "in_progress") return "In Progress";
  if (status?.canonical === "done") return "Done";
  return status?.raw ?? "Status";
}

export function useSessionLinkPrInfo(link: SpurSessionLink | undefined) {
  return usePrInfo(link && isReviewLinkLabel(link.label) ? link.url : undefined);
}

export function SessionLinkBadge({ link, prInfo: providedPrInfo }: SessionLinkBadgeProps) {
  const isPr = isReviewLinkLabel(link.label);
  const isTracker = isTrackerLinkLabel(link.label);
  const trackerStatusMarkerClass = isTracker ? trackerStatusClass(link.status) : null;
  const reviewProvider = isPr ? reviewProviderFromUrl(link.url) : null;
  const fetchedPrInfo = useSessionLinkPrInfo(providedPrInfo ? undefined : link);
  const prInfo = providedPrInfo ?? fetchedPrInfo;
  const labelStyle: CSSProperties | undefined = isPr
    ? (() => {
        const color = prStateColor(prInfo.state);
        return color ? { color } : undefined;
      })()
    : undefined;
  const classes = [
    "inline-flex items-center gap-1 border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:no-underline",
    hoverClassForLink(link),
  ].join(" ");

  return (
    <a className={classes} href={link.url} rel="noreferrer" target="_blank">
      {isPr ? (
        reviewProvider === "gitlab" ? (
          <GitlabIcon />
        ) : (
          <GithubIcon />
        )
      ) : isTracker ? (
        <JiraIcon />
      ) : null}
      <span className="text-[10px]" style={labelStyle}>
        {extractLinkId(link)}
      </span>
      {trackerStatusMarkerClass ? (
        <span
          aria-label={`Tracker status ${trackerStatusLabel(link.status)}`}
          className={`h-1.5 w-1.5 shrink-0 ${trackerStatusMarkerClass}`}
          title={`Tracker status: ${trackerStatusLabel(link.status)}`}
        />
      ) : null}
      {isPr ? (
        <>
          {prInfo.ciStatus === "success" &&
          (prInfo.reviewDecision === "approved" ||
            prInfo.reviewDecision === "changes_requested") ? (
            <ReviewDecisionDot decision={prInfo.reviewDecision} />
          ) : (
            <CiStatusDot status={prInfo.ciStatus} />
          )}
          <ReviewCommentsBadge total={prInfo.totalThreads} unresolved={prInfo.unresolvedThreads} />
        </>
      ) : null}
    </a>
  );
}
