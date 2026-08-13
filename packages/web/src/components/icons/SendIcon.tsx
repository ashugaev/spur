"use client";

export function SendIcon({
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
      <path d="M2 8 14 2 9.5 14 7.5 9 2 8Z" />
      <path d="M7.5 9 14 2" />
    </svg>
  );
}
