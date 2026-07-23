"use client";

export function AccountsIcon({
  className = "h-4 w-4",
  "data-testid": dataTestid,
}: {
  className?: string;
  "data-testid"?: string;
}) {
  // Two overlapping user silhouettes (accounts glyph). The back figure is
  // drawn first at reduced opacity so it reads behind the front one while
  // both stay a single currentColor fill.
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-testid={dataTestid}
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <circle cx="10.4" cy="4.7" opacity="0.55" r="1.9" />
      <path d="M6.9 14c0-2.9 1.6-5.3 3.6-5.3s3.6 2.4 3.6 5.3v.3H6.9Z" opacity="0.55" />
      <circle cx="5.6" cy="5.2" r="2.2" />
      <path d="M1.5 14.3c0-3.3 1.8-6 4.1-6s4.1 2.7 4.1 6v.2H1.5Z" />
    </svg>
  );
}
