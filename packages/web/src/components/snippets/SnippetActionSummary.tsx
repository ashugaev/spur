"use client";

import type { ReactNode } from "react";
import { HARD_WRAP_TEXT_CLASS } from "@/design/classes";
import { parseSnippetActionPrompt } from "@/lib/snippets/snippet-protocol";

// Compact line for a host-built snippet action prompt. Text that does not
// parse strictly renders `fallback` exactly as before. The raw text stays the
// message identity for the queue; this is render-only.
export function SnippetActionSummary({ text, fallback }: { text: string; fallback: ReactNode }) {
  const parsed = parseSnippetActionPrompt(text);
  if (!parsed) return <>{fallback}</>;
  return (
    <div className="min-w-0">
      <div
        className={`flex min-w-0 items-center gap-1.5 text-[var(--color-text-secondary)] ${HARD_WRAP_TEXT_CLASS}`}
        data-snippet-action-summary=""
      >
        <svg
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)]"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          viewBox="0 0 16 16"
        >
          <path d="M6 3 2 8l4 5M10 3l4 5-4 5" />
        </svg>
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Snippet action
        </span>{" "}
        <span className="font-bold text-[var(--color-text-primary)]">{parsed.label}</span>{" "}
        <span>
          · {parsed.snippetId} r{parsed.revision}
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
