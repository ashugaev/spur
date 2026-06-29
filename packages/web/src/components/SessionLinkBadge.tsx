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

function trackerStatusColor(status: SpurSessionLink["status"]): string | undefined {
  if (status?.canonical === "backlog") {
    return "var(--color-text-tertiary)";
  }
  if (status?.canonical === "in_progress") {
    return "var(--color-status-working)";
  }
  if (status?.canonical === "done") {
    return "var(--color-status-ready)";
  }
  return undefined;
}

function trackerStatusLabel(status: SpurSessionLink["status"]): string | null {
  if (status?.canonical === "backlog") return "Backlog";
  if (status?.canonical === "in_progress") return "In Progress";
  if (status?.canonical === "done") return "Done";
  return null;
}

export function useSessionLinkPrInfo(link: SpurSessionLink | undefined) {
  return usePrInfo(link && isReviewLinkLabel(link.label) ? link.url : undefined);
}

export function SessionLinkBadge({ link, prInfo: providedPrInfo }: SessionLinkBadgeProps) {
  const isPr = isReviewLinkLabel(link.label);
  const isTracker = isTrackerLinkLabel(link.label);
  const trackerColor = isTracker ? trackerStatusColor(link.status) : undefined;
  const trackerLabel = isTracker ? trackerStatusLabel(link.status) : null;
  const reviewProvider = isPr ? reviewProviderFromUrl(link.url) : null;
  const fetchedPrInfo = useSessionLinkPrInfo(providedPrInfo ? undefined : link);
  const prInfo = providedPrInfo ?? fetchedPrInfo;
  const labelStyle: CSSProperties | undefined = isPr
    ? (() => {
        const color = prStateColor(prInfo.state);
        return color ? { color } : undefined;
      })()
    : trackerColor
      ? { color: trackerColor }
      : undefined;
  const linkId = extractLinkId(link);
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
      <span
        aria-label={trackerLabel ? `${linkId} Tracker status ${trackerLabel}` : undefined}
        className="text-[10px]"
        style={labelStyle}
        title={trackerLabel ? `Tracker status: ${trackerLabel}` : undefined}
      >
        {linkId}
      </span>
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
