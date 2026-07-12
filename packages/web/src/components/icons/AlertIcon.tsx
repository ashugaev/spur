"use client";

export function AlertIcon({
  className = "h-3 w-3",
  aggressive = false,
  "data-testid": dataTestid,
}: {
  className?: string;
  aggressive?: boolean;
  "data-testid"?: string;
}) {
  // Filled warning triangle with the exclamation knocked out (evenodd cuts the
  // inner shapes back out). The triangle body carries the severity color
  // (currentColor) and the exclamation reads as the dark footer behind it, so
  // it looks like a standard warning sign rather than a color-inverted outline.
  // The aggressive (major) variant uses a heavier exclamation for a harsher look.
  const exclamation = aggressive
    ? "M6.85 5H9.15V9.7H6.85ZM6.85 10.9H9.15V13.1H6.85Z"
    : "M7.3 5.5H8.7V9.6H7.3ZM7.3 10.9H8.7V12.6H7.3Z";
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-aggressive={aggressive ? "true" : undefined}
      data-testid={dataTestid}
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <path d={`M8 1.5 15 14 1 14Z${exclamation}`} fillRule="evenodd" />
    </svg>
  );
}
