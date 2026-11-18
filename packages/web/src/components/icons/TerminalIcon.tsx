"use client";

export function TerminalIcon({
  className = "h-3.5 w-3.5",
  strokeWidth = 2,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="square"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}
