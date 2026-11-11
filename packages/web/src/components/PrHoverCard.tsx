"use client";

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { isTouchPointer, useFooterPopover } from "@/lib/footer-popover";
import type { PrCheck, PrCheckState, PrReviewers } from "@/lib/pr-status-shape";

export type PrCardTone = "error" | "attention" | "ready";

export interface PrCardRow {
  key: string;
  name: string;
  tone: PrCardTone;
  team?: boolean;
}

// Pointer transit from trigger to card crosses the badge border and padding.
const CLOSE_GRACE_MS = 150;
const DEFAULT_ROW_LIMIT = 8;

const DOT_CLASS: Record<PrCardTone, string> = {
  error: "bg-[var(--color-status-error)]",
  attention: "bg-[var(--color-status-attention)]",
  ready: "bg-[var(--color-status-ready)]",
};

const CHECK_TONE: Record<PrCheckState, PrCardTone> = {
  failed: "error",
  pending: "attention",
  passed: "ready",
};

export function reviewerCardRows(reviewers: PrReviewers | null | undefined): PrCardRow[] {
  if (!reviewers) return [];
  const rows: PrCardRow[] = [];
  const seen = new Set<string>();
  const add = (name: string, display: string, tone: PrCardTone, team = false) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ key, name: display, tone, team });
  };
  for (const login of reviewers.changesRequested) add(login, `@${login}`, "error");
  for (const request of reviewers.pending ?? []) {
    add(request.name, request.team ? request.name : `@${request.name}`, "attention", request.team);
  }
  for (const login of reviewers.approved) add(login, `@${login}`, "ready");
  return rows;
}

export function checkCardRows(checks: PrCheck[] | null | undefined): PrCardRow[] {
  if (!checks) return [];
  return (["failed", "pending", "passed"] as const).flatMap((state) =>
    checks
      .filter((check) => check.state === state)
      .map((check, index) => ({
        key: `${state}:${index}:${check.name}`,
        name: check.name,
        tone: CHECK_TONE[state],
      })),
  );
}

function PrCard({ id, rows, limit }: { id: string; rows: PrCardRow[]; limit: number }) {
  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return (
    <div
      id={id}
      role="tooltip"
      data-pr-card
      onClick={(event) => event.stopPropagation()}
      className="absolute right-0 top-full z-50 flex w-max min-w-[9rem] max-w-[16rem] flex-col gap-px border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-[11px] leading-4 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]"
    >
      {shown.map((row) => (
        <div key={row.key} data-pr-card-row className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            data-pr-card-dot={row.tone}
            className={`h-1.5 w-1.5 shrink-0 ${DOT_CLASS[row.tone]}`}
          />
          <span className="min-w-0 truncate text-[var(--color-text-primary)]">{row.name}</span>
          {row.team ? (
            <span className="ml-auto shrink-0 pl-2 text-[var(--color-text-tertiary)]">team</span>
          ) : null}
        </div>
      ))}
      {hidden > 0 ? (
        <div
          data-pr-card-more
          className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
        >
          +{hidden} more
        </div>
      ) : null}
    </div>
  );
}

export type PrCardId = "ci" | "reviewers";

interface PrHoverCardTriggerProps {
  cardId: PrCardId;
  // One card at a time: the badge owns which card is active.
  activeCard: PrCardId | null;
  onActiveCardChange(id: PrCardId | null): void;
  slot: HTMLElement | null;
  rows: PrCardRow[];
  limit?: number;
  fallbackTitle: string | undefined;
  children: ReactNode;
}

// The card is portaled into `slot`, a DOM sibling of the badge <a>: it stays a
// React child of the trigger (pointer transit keeps it open) without being a
// DOM descendant of the link (clicks inside never navigate).
export function PrHoverCardTrigger({
  cardId,
  activeCard,
  onActiveCardChange,
  slot,
  rows,
  limit = DEFAULT_ROW_LIMIT,
  fallbackTitle,
  children,
}: PrHoverCardTriggerProps) {
  const popover = useFooterPopover<HTMLSpanElement>({ closeDelayMs: CLOSE_GRACE_MS });
  const domId = useId();
  const { open } = popover;
  // The hook's dismiss changes identity every render; keep the effect keyed on activeCard only.
  const dismissRef = useRef(popover.dismiss);
  dismissRef.current = popover.dismiss;
  const openRef = useRef(open);
  openRef.current = open;
  const activeRef = useRef(activeCard);
  activeRef.current = activeCard;
  // Opening claims the badge's active slot; closing releases it if still held.
  useEffect(() => {
    if (open) onActiveCardChange(cardId);
    else if (activeRef.current === cardId) onActiveCardChange(null);
  }, [open, cardId, onActiveCardChange]);
  // Another card claimed the slot: close this one at once.
  useEffect(() => {
    if (openRef.current && activeCard !== null && activeCard !== cardId) {
      dismissRef.current();
    }
  }, [activeCard, cardId]);
  if (rows.length === 0) {
    return (
      <span className="inline-flex items-center gap-1" title={fallbackTitle}>
        {children}
      </span>
    );
  }
  const onClick = (event: MouseEvent) => {
    if (!isTouchPointer()) return;
    event.preventDefault();
    popover.toggle();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") popover.dismiss();
  };
  const showCard = open && slot !== null && (activeCard === null || activeCard === cardId);
  return (
    <span
      ref={popover.containerRef}
      role="group"
      tabIndex={0}
      aria-label={fallbackTitle}
      aria-describedby={showCard ? domId : undefined}
      className={`inline-flex items-center gap-1 px-0.5 ${open ? "bg-[var(--color-hover-overlay)]" : ""}`}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
      onFocus={popover.onMouseEnter}
      onBlur={popover.onBlur}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      {children}
      {showCard && slot
        ? createPortal(<PrCard id={domId} rows={rows} limit={limit} />, slot)
        : null}
    </span>
  );
}
