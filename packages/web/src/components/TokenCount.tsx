"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import type { SpurSessionView } from "@/lib/types";

type TokenSession = Pick<
  SpurSessionView,
  "tokenUsageView" | "preflightTokenUsageView" | "tokenBudgetView"
>;

function compact(value: number, precise = false): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000)
    return `${precise ? Number((value / 1_000).toFixed(1)) : Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

export function TokenCount({
  session,
  sidebar = false,
}: {
  session: TokenSession;
  sidebar?: boolean;
}) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const cardRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => {
      card.style.transform = "";
      const bounds = card.getBoundingClientRect();
      const x = Math.max(0, 8 - bounds.left);
      const above = -card.offsetHeight - (card.parentElement?.offsetHeight ?? 0);
      const y = Math.max(8 - bounds.top, bounds.bottom > window.innerHeight - 8 ? above : 0);
      card.style.transform = `translate(${x}px, ${y}px)`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [hovered, focused, session]);
  const main = session.tokenUsageView?.status === "available" ? session.tokenUsageView : undefined;
  const preflight = session.preflightTokenUsageView;
  const measured = preflight && "totalTokens" in preflight ? preflight : undefined;
  const budget = session.tokenBudgetView;
  const limit = budget?.budget ?? session.tokenUsageView?.budget;
  const total = budget?.knownTotalTokens ?? (main?.totalTokens ?? 0) + (measured?.totalTokens ?? 0);
  const available = Boolean(main || measured || total > 0);
  const hasDetails = available || Boolean(preflight);
  const hit = !budget?.overridden && (budget?.exhausted ?? main?.exhausted ?? false);
  const unenforced =
    limit !== undefined &&
    (budget
      ? !budget.enforced && (!budget.overridden || Boolean(budget.reason))
      : session.tokenUsageView?.status === "unavailable");
  const tone = !available
    ? "text-tertiary"
    : hit
      ? "status-error"
      : unenforced
        ? "chip-warn-text"
        : !budget?.overridden && limit && total >= limit * 0.8
          ? "status-attention"
          : "text-secondary";
  const reason =
    budget?.reason === "preflight_unknown"
      ? "pre-flight usage unknown"
      : budget?.reason === "legacy_unknown"
        ? "earlier usage unknown"
        : "main usage unavailable";
  const rows = [
    ["Input", measured?.inputTokens, main?.inputTokens],
    ["Output", measured?.outputTokens, main?.outputTokens],
    ["Cache read", measured?.cacheReadInputTokens, main?.cacheReadInputTokens],
    ["Cache write", measured?.cacheWriteInputTokens, main?.cacheWriteInputTokens],
    ["Reasoning", measured?.reasoningOutputTokens, main?.reasoningOutputTokens],
    ["Cache write 5m", measured?.cacheWrite5mInputTokens, main?.cacheWrite5mInputTokens],
    ["Cache write 1h", measured?.cacheWrite1hInputTokens, main?.cacheWrite1hInputTokens],
    ["Total", measured?.totalTokens, main?.totalTokens],
  ] as const;
  const reportedRows = rows.filter(
    ([, pre, current]) => pre !== undefined || current !== undefined,
  );
  return (
    <span
      className="relative inline-block tabular-nums"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        tabIndex={0}
        aria-label={`Tokens: ${available ? `${unenforced ? "at least " : ""}${total.toLocaleString()}` : "unavailable"}`}
        aria-describedby={hasDetails && (hovered || focused) ? id : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`cursor-default focus:outline-none focus:underline focus:decoration-dotted focus:underline-offset-4 ${hit ? "font-bold" : ""}`}
        style={{ color: `var(--color-${tone})` }}
      >
        {available
          ? `${unenforced ? "≥" : ""}${compact(total)}${sidebar && limit !== undefined ? ` / ${compact(limit)}` : ""}`
          : "—"}
      </span>
      {hasDetails && (hovered || focused) ? (
        <span
          id={id}
          ref={cardRef}
          role="tooltip"
          className="absolute right-0 top-full z-50 block max-h-[calc(100dvh-16px)] w-72 overflow-auto border border-[var(--color-border-default)] bg-[var(--color-bg-base)] text-[var(--color-text-secondary)] shadow-[0_8px_30px_var(--color-shadow-menu)]"
        >
          <span className="block bg-[var(--color-bg-elevated)] p-3">
            {reportedRows.length > 0 ? (
              <table className="w-full text-right">
                <thead>
                  <tr>
                    <th />
                    <th className="font-normal">Pre-flight</th>
                    <th className="font-normal">Main</th>
                  </tr>
                </thead>
                <tbody>
                  {reportedRows.map(([label, pre, current]) => (
                    <tr
                      key={label}
                      className={
                        label === "Total"
                          ? "border-t border-[var(--color-border-subtle)] font-bold"
                          : ""
                      }
                    >
                      <th className="py-1 text-left font-normal">{label}</th>
                      <td>{pre?.toLocaleString() ?? "?"}</td>
                      <td>{current?.toLocaleString() ?? "?"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {preflight ? (
              <dl className="mt-2 border-t border-[var(--color-border-subtle)] pt-2 text-left">
                {[
                  [
                    "Pre-flight status",
                    preflight.status === "legacy_unknown"
                      ? "Legacy usage unknown"
                      : preflight.status,
                  ],
                  ["Pre-flight attempts", preflight.attemptCount.toLocaleString()],
                  ["Unknown attempts", preflight.unknownAttemptCount.toLocaleString()],
                  ["Provider iterations", preflight.providerIterationCount.toLocaleString()],
                  ...(["claude", "codex", "cursor", "opencode"] as const).flatMap((provider) => {
                    const tokens = measured?.byProvider[provider]?.totalTokens;
                    return tokens === undefined
                      ? []
                      : [
                          [
                            `Pre-flight ${provider === "opencode" ? "OpenCode" : provider[0].toUpperCase() + provider.slice(1)}`,
                            tokens.toLocaleString(),
                          ],
                        ];
                  }),
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2 py-0.5">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {hit || unenforced || limit !== undefined || budget?.overridden ? (
              <span
                className={`mt-2 block border-t border-[var(--color-border-subtle)] pt-2 text-left ${hit ? "text-[var(--color-status-error)]" : unenforced ? "text-[var(--color-chip-warn-text)]" : "text-[var(--color-text-tertiary)]"}`}
              >
                {hit
                  ? "Stopped by token budget"
                  : budget?.overridden
                    ? `Limit ignored${budget.reason ? ` · ${reason}` : ""}`
                    : unenforced
                      ? `Unavailable · ${reason}`
                      : limit !== undefined
                        ? `${compact(total, true)} of ${compact(limit, true)} · ${Math.round((total / limit) * 100)}%`
                        : null}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}
