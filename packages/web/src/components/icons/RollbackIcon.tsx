"use client";

export function RollbackIcon({
  className = "h-3 w-3",
  "data-testid": dataTestid,
}: {
  className?: string;
  "data-testid"?: string;
}) {
  // Filled circle with an x knocked out (evenodd cuts the cross back out), so
  // the shape carries the meaning: red alone cannot, since the severity
  // triangle already turns --color-status-error on a major release. A disc
  // reads as "this went wrong", a triangle as "there is something to do".
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-testid={dataTestid}
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <path
        d="M8 1.5A6.5 6.5 0 1 0 8 14.5A6.5 6.5 0 1 0 8 1.5ZM5.35 4.65 8 7.3 10.65 4.65 11.35 5.35 8.7 8 11.35 10.65 10.65 11.35 8 8.7 5.35 11.35 4.65 10.65 7.3 8 4.65 5.35Z"
        fillRule="evenodd"
      />
    </svg>
  );
}
