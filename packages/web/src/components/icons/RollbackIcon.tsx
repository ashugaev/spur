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
        d="M8 1.5A6.5 6.5 0 1 0 8 14.5A6.5 6.5 0 1 0 8 1.5ZM5.5 4.5 8 7 10.5 4.5 11.5 5.5 9 8 11.5 10.5 10.5 11.5 8 9 5.5 11.5 4.5 10.5 7 8 4.5 5.5Z"
        fillRule="evenodd"
      />
    </svg>
  );
}
