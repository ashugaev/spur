"use client";

export function CloseIcon({
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
      strokeWidth={strokeWidth}
      viewBox="0 0 16 16"
    >
      <path d="M3 3 13 13M13 3 3 13" />
    </svg>
  );
}
