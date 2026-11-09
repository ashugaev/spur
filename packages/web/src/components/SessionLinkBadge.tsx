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
  ReviewersBadge,
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

function statusTitle(info: PrInfo, github: boolean): string | undefined {
  const facts: string[] = [];
  if (info.ciStatus === "success") facts.push("CI passing");
  if (info.ciStatus === "failure") facts.push("CI failing");
  if (info.ciStatus === "pending") facts.push("CI pending");
  if (info.reviewDecision === "approved") facts.push("Review approved");
  if (info.reviewDecision === "changes_requested") facts.push("Changes requested");
  if (info.reviewDecision === "review_required") {
    facts.push(
      github ? "GitHub requires review" : "Review required",
      "Remaining required approvals: unknown",
    );
  }
  if (info.mergeConflict) facts.push("Merge conflict");
  return facts.length > 0 ? facts.join("\n") : undefined;
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
  const hasStatus =
    indicator.kind === "review" || indicator.status !== null || prInfo.mergeConflict;
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
          {hasStatus ? (
            <span
              className="inline-flex items-center gap-1"
              title={statusTitle(prInfo, reviewProvider === "github")}
            >
              {indicator.kind === "review" ? (
                <ReviewDecisionDot decision={indicator.decision} showTitle={false} />
              ) : (
                <CiStatusDot status={indicator.status} />
              )}
              {prInfo.mergeConflict ? <MergeConflictBadge /> : null}
            </span>
          ) : null}
          {reviewProvider === "github" && prInfo.reviewers ? (
            <>
              <ReviewersBadge logins={prInfo.reviewers.approved} decision="approved" />
              <ReviewersBadge
                logins={prInfo.reviewers.changesRequested}
                decision="changes_requested"
              />
            </>
          ) : null}
          <ReviewCommentsBadge total={prInfo.totalThreads} unresolved={prInfo.unresolvedThreads} />
        </>
      ) : null}
    </a>
  );
}
