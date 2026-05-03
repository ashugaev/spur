"use client";

import type { CSSProperties } from "react";
import {
  CiStatusDot,
  extractLinkId,
  GithubIcon,
  isGitHubPrLinkLabel,
  JiraIcon,
  type PrInfo,
  prStateColor,
  ReviewCommentsBadge,
  ReviewDecisionDot,
  usePrInfo,
} from "@/lib/link-icons";
import type { SpurSessionLink } from "@/lib/types";

type SessionLinkBadgeVariant = "row" | "detail";

interface SessionLinkBadgeProps {
  className?: string;
  link: SpurSessionLink;
  prInfo?: PrInfo;
  variant: SessionLinkBadgeVariant;
}

const VARIANT_CLASS: Record<SessionLinkBadgeVariant, string> = {
  row: "shrink-0 text-[var(--color-text-tertiary)]",
  detail:
    "border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-text-secondary)]",
};

function trimClassName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hoverClassForLink(link: SpurSessionLink): string {
  if (link.label === "tracker") {
    return "hover:text-[var(--color-status-attention)]";
  }
  return "hover:text-[var(--color-text-primary)]";
}

export function useSessionLinkPrInfo(link: SpurSessionLink | undefined) {
  return usePrInfo(link && isGitHubPrLinkLabel(link.label) ? link.url : undefined);
}

export function SessionLinkBadge({
  className,
  link,
  prInfo: providedPrInfo,
  variant,
}: SessionLinkBadgeProps) {
  const isPr = isGitHubPrLinkLabel(link.label);
  const fetchedPrInfo = useSessionLinkPrInfo(providedPrInfo ? undefined : link);
  const prInfo = providedPrInfo ?? fetchedPrInfo;
  const labelStyle: CSSProperties | undefined = isPr
    ? (() => {
        const color = prStateColor(prInfo.state);
        return color ? { color } : undefined;
      })()
    : undefined;
  const classes = trimClassName(
    [
      "inline-flex items-center gap-1 hover:no-underline",
      VARIANT_CLASS[variant],
      hoverClassForLink(link),
      className ?? "",
    ].join(" "),
  );

  return (
    <a className={classes} href={link.url} rel="noreferrer" target="_blank">
      {isPr ? <GithubIcon /> : link.label === "tracker" ? <JiraIcon /> : null}
      <span className="text-[10px]" style={labelStyle}>
        {extractLinkId(link)}
      </span>
      {isPr ? (
        <>
          {prInfo.ciStatus === "success" ? null : <CiStatusDot status={prInfo.ciStatus} />}
          {prInfo.ciStatus === "success" &&
          (prInfo.reviewDecision === "approved" ||
            prInfo.reviewDecision === "changes_requested") ? (
            <ReviewDecisionDot decision={prInfo.reviewDecision} />
          ) : null}
          <ReviewCommentsBadge total={prInfo.totalThreads} unresolved={prInfo.unresolvedThreads} />
        </>
      ) : null}
    </a>
  );
}
