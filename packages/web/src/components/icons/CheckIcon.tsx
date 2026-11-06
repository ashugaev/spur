"use client";

export function CheckIcon({
  className = "h-2.5 w-2.5",
  strokeWidth = 1.5,
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
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 16 16"
    >
      <path d="m3 8.5 3.5 3.5L13 4.5" />
    </svg>
  );
}
