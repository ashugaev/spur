"use client";

export function AlertIcon({
  className = "h-3 w-3",
  strokeWidth = 2.2,
  aggressive = false,
  "data-testid": dataTestid,
}: {
  className?: string;
  strokeWidth?: number;
  aggressive?: boolean;
  "data-testid"?: string;
}) {
  if (aggressive) {
    // Solid triangle with a knocked-out exclamation (evenodd cuts the inner
    // shapes back out), so the alarming red fills the whole glyph.
    return (
      <svg
        aria-hidden="true"
        className={className}
        data-aggressive="true"
        data-testid={dataTestid}
        fill="currentColor"
        viewBox="0 0 16 16"
      >
        <path d="M8 1.5 15 14 1 14ZM7.3 5.5H8.7V9.5H7.3ZM7.3 10.6H8.7V12H7.3Z" fillRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-testid={dataTestid}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 16 16"
    >
      <path d="M8 2 15 14 1 14Z" />
      <path d="M8 6.5V9.5" />
      <path d="M8 11.5H8.01" />
    </svg>
  );
}
