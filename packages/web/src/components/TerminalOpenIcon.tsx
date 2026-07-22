export function TerminalOpenIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <path d="m3 4 3.5 3.5L3 11" />
      <path d="M8.5 11h4.5" />
    </svg>
  );
}
