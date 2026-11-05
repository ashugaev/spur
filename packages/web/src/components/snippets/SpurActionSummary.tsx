"use client";

import type { ReactNode } from "react";
import { HARD_WRAP_TEXT_CLASS } from "@/design/classes";
import { parseSpurActionEnvelope } from "@/lib/spur-action";

// Compact line for a daemon-built `[spur-action v1]` envelope. Text that does not
// parse strictly renders `fallback` exactly as before. The raw text stays the
// message identity for the queue; this is render-only.
export function SpurActionSummary({ text, fallback }: { text: string; fallback: ReactNode }) {
  const parsed = parseSpurActionEnvelope(text);
  if (!parsed) return <>{fallback}</>;
  const { source } = parsed;
  const kind = source.kind === "snippet" ? "Snippet action" : "Page action";
  const origin =
    source.kind === "snippet"
      ? `${source.snippetId} r${source.revision}`
      : parsed.store.slice("page:".length);
  return (
    <div className="min-w-0">
      <div
        className="flex min-w-0 items-start gap-1.5 text-[var(--color-text-secondary)]"
        data-spur-action-summary=""
      >
        <svg
          aria-hidden="true"
          className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-text-tertiary)]"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          viewBox="0 0 16 16"
        >
          <path d="M6 3 2 8l4 5M10 3l4 5-4 5" />
        </svg>
        <span className="shrink-0 whitespace-nowrap text-[10px] uppercase leading-[18px] tracking-[0.12em] text-[var(--color-text-tertiary)]">
          {kind}
        </span>{" "}
        <span className={`flex-1 ${HARD_WRAP_TEXT_CLASS}`}>
          <span className="font-bold text-[var(--color-text-primary)]">{parsed.label}</span>{" "}
          <span>· {origin}</span>
        </span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]">
          Raw prompt
        </summary>
        <pre className="mt-1 whitespace-pre-wrap border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2 text-[11px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
          {text}
        </pre>
      </details>
    </div>
  );
}
