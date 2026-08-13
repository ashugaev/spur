"use client";

export function TrashIcon({
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
      <path d="M2 4h12M5.5 4V2.5h5V4M6 7v5M10 7v5M3.5 4l.6 9.2a1 1 0 0 0 1 .8h5.8a1 1 0 0 0 1-.8L12.5 4" />
    </svg>
  );
}
