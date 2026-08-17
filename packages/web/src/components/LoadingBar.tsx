export function LoadingBar({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div
      aria-label={label}
      className={`loader-bar h-0.5 w-full overflow-hidden bg-[var(--color-border-subtle)] ${className}`}
      role="status"
    >
      <span className="loader-bar-segment block h-full w-2/5 bg-[var(--color-accent)]" />
    </div>
  );
}
