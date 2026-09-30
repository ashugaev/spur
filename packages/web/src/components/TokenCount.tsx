"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { formatTokenCount } from "@/lib/format";
import { isTokenBudgetBlocked, type SpurSessionView } from "@/lib/types";

type TokenSession = Pick<
  SpurSessionView,
  "status" | "tokenUsageView" | "preflightTokenUsageView" | "tokenBudgetView"
>;

export function TokenCount({
  session,
  sidebar = false,
  align = "right",
}: {
  session: TokenSession;
  sidebar?: boolean;
  align?: "left" | "right";
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
  const limit = budget?.budget;
  const total = budget?.knownTotalTokens ?? 0;
  const hit = isTokenBudgetBlocked(session);
  const unenforced =
    budget !== undefined && limit !== undefined && !budget.enforced && !budget.overridden;
  const floor = limit !== undefined && Boolean(budget?.reason);
  const tone = !budget
    ? "none"
    : hit
      ? "hit"
      : unenforced
        ? "unenf"
        : total === 0 && session.tokenUsageView?.status !== "available"
          ? "none"
          : limit !== undefined && total >= limit * 0.8
            ? "near"
            : "default";
  const available = tone !== "none";
  const hasDetails = available || Boolean(preflight);
  const toneColor =
    tone === "none"
      ? "text-tertiary"
      : tone === "hit"
        ? "status-error"
        : tone === "unenf"
          ? "chip-warn-text"
          : tone === "near"
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
        tabIndex={hasDetails ? 0 : undefined}
        aria-label={`Tokens: ${available ? `${floor ? "at least " : ""}${total.toLocaleString()}` : "unavailable"}`}
        aria-describedby={hasDetails && (hovered || focused) ? id : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`cursor-default outline-none focus-visible:underline focus-visible:decoration-dotted focus-visible:underline-offset-4 ${hit ? "font-bold" : ""}`}
        style={{ color: `var(--color-${toneColor})` }}
      >
        {available
          ? `${floor ? "≥" : ""}${formatTokenCount(total)}${sidebar && limit !== undefined ? ` / ${formatTokenCount(limit)}` : ""}`
          : "—"}
      </span>
      {hasDetails && (hovered || focused) ? (
        <span
          id={id}
          ref={cardRef}
          role="tooltip"
          className={`absolute top-full z-50 block max-h-[calc(100dvh-16px)] w-72 overflow-auto border border-[var(--color-border-default)] bg-[var(--color-bg-base)] text-[var(--color-text-secondary)] shadow-[0_8px_30px_var(--color-shadow-menu)] ${align === "left" ? "left-0" : "right-0"}`}
        >
          <span className="block bg-[var(--color-bg-elevated)] p-3">
            {reportedRows.length > 0 ? (
              <table className="w-full text-right">
                <thead>
                  <tr>
                    <th />
                    <th className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                      Pre-flight
                    </th>
                    <th className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                      Main
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reportedRows.map(([label, pre, current]) => (
                    <tr
                      key={label}
                      className={
                        label === "Total"
                          ? "border-t border-[var(--color-border-subtle)] font-bold text-[var(--color-text-primary)]"
                          : ""
                      }
                    >
                      <th className="py-1 text-left font-normal">{label}</th>
                      <td>{pre !== undefined ? formatTokenCount(pre, true) : "?"}</td>
                      <td>{current !== undefined ? formatTokenCount(current, true) : "?"}</td>
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
                            formatTokenCount(tokens, true),
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
                  ? session.status === "budget_limited"
                    ? "Stopped by token budget"
                    : "Token budget reached"
                  : unenforced
                    ? `Budget not enforced · ${reason}`
                    : limit !== undefined
                      ? `${formatTokenCount(total, true)} of ${formatTokenCount(limit, true)} · ${Math.round((total / limit) * 100)}%${budget?.overridden ? " · limit ignored" : ""}`
                      : null}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}
