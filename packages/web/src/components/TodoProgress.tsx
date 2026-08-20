interface TodoProgressProps {
  resolved: number;
  total: number;
}

export function TodoProgress({ resolved, total }: TodoProgressProps) {
  const percent = total === 0 ? 0 : Math.round((resolved / total) * 100);
  return (
    <div
      aria-label={`${resolved} of ${total} ToDo items resolved`}
      className="grid h-8 w-8 shrink-0 place-items-center border border-[var(--color-border-default)] font-bold text-[var(--color-text-primary)]"
      title={`${percent}% resolved`}
    >
      {resolved}/{total}
    </div>
  );
}
