export function Skeleton({ label, className = "" }: { label: string; className?: string }) {
  return (
    <span
      aria-label={label}
      className={`loader-skeleton block bg-[var(--color-hover-overlay)] ${className}`}
      role="status"
    />
  );
}
