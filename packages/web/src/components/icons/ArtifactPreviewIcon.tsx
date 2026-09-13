"use client";

export function ArtifactPreviewIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 16 16">
      <path d="M4 3.25v9.5L12 8 4 3.25Z" />
    </svg>
  );
}
