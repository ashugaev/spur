interface EmptyStateProps {
  message?: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  const text =
    message ??
    "No Spur sessions are visible yet. Start one with `spur spawn <project> <prompt...>` and it will appear here.";

  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-xl">
        𖤓
      </div>
      <p className="max-w-xl text-sm leading-6 text-[var(--color-text-secondary)]">{text}</p>
    </div>
  );
}
