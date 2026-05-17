"use client";

import type { SpurTodoState } from "@/lib/types";

export function getTodoResolvedCount(todo: SpurTodoState): number {
  return todo.done + todo.skipped + todo.failed;
}

export function todoProgressLabel(todo: SpurTodoState): string {
  return `Todo progress ${getTodoResolvedCount(todo)} of ${todo.total}`;
}

export function TodoProgress({ todo }: { todo: SpurTodoState }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const resolved = getTodoResolvedCount(todo);
  const progress = todo.total > 0 ? Math.min(resolved / todo.total, 1) : 0;
  const colorClass =
    todo.status === "completed"
      ? "text-[var(--color-status-ready)]"
      : progress > 0
        ? "text-[var(--color-status-attention)]"
        : "text-[var(--color-text-secondary)]";

  return (
    <span
      aria-label={todoProgressLabel(todo)}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${colorClass}`}
      role="img"
      title={todoProgressLabel(todo)}
    >
      <svg aria-hidden="true" className="h-4 w-4 -rotate-90" viewBox="0 0 16 16">
        <circle
          cx="8"
          cy="8"
          fill="none"
          r={radius}
          stroke="var(--color-border-strong)"
          strokeWidth="2"
        />
        <circle
          cx="8"
          cy="8"
          fill="none"
          r={radius}
          stroke="currentColor"
          strokeDasharray={`${circumference * progress} ${circumference}`}
          strokeLinecap="round"
          strokeWidth="2"
        />
      </svg>
    </span>
  );
}
