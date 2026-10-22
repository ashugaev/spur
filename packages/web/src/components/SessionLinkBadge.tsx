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
  MergeConflictBadge,
  type PrInfo,
  prStateColor,
  reviewProviderFromUrl,
  ReviewCommentsBadge,
  ReviewDecisionDot,
  usePrInfo,
} from "@/lib/link-icons";
import type { SpurSessionLink } from "@/lib/types";
import { prStatusIndicator } from "@/lib/pr-status-shape";

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

export function useSessionLinkPrInfo(link: SpurSessionLink | undefined) {
  return usePrInfo(link && isReviewLinkLabel(link.label) ? link.url : undefined);
}

export function SessionLinkBadge({ link, prInfo: providedPrInfo }: SessionLinkBadgeProps) {
  const isPr = isReviewLinkLabel(link.label);
  const reviewProvider = isPr ? reviewProviderFromUrl(link.url) : null;
  const fetchedPrInfo = useSessionLinkPrInfo(providedPrInfo ? undefined : link);
  const prInfo = providedPrInfo ?? fetchedPrInfo;
  const indicator = prStatusIndicator(prInfo);
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
      ) : isTrackerLinkLabel(link.label) ? (
        <JiraIcon />
      ) : null}
      <span className="text-[10px]" style={labelStyle}>
        {extractLinkId(link)}
      </span>
      {isPr ? (
        <>
          {indicator.kind === "review" ? (
            <ReviewDecisionDot decision={indicator.decision} />
          ) : (
            <CiStatusDot status={indicator.status} />
          )}
          {prInfo.mergeConflict ? <MergeConflictBadge /> : null}
          <ReviewCommentsBadge total={prInfo.totalThreads} unresolved={prInfo.unresolvedThreads} />
        </>
      ) : null}
    </a>
  );
}
