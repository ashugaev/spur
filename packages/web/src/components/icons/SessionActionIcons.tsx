"use client";

import type { ReactNode } from "react";

/** 16-unit stroke glyphs for session actions that have no shared icon yet. */
function StrokeIcon({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
    >
      {children}
    </svg>
  );
}

export function PauseIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <StrokeIcon className={className}>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </StrokeIcon>
  );
}

export function PlayIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <StrokeIcon className={className}>
      <path d="M5 3.5v9l7-4.5-7-4.5Z" />
    </StrokeIcon>
  );
}

export function RestoreIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <StrokeIcon className={className}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.5v3.5H6" />
    </StrokeIcon>
  );
}

export function CheckIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <StrokeIcon className={className}>
      <path d="m3 8.5 3 3 7-7" />
    </StrokeIcon>
  );
}

export function KeyIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <StrokeIcon className={className}>
      <circle cx="5" cy="11" r="2.5" />
      <path d="m6.8 9.2 6.2-6.2M11 5l1.5 1.5M9.5 6.5 11 8" />
    </StrokeIcon>
  );
}

export function EditIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <StrokeIcon className={className}>
      <path d="M10.5 2.5 13.5 5.5 6 13H3v-3l7.5-7.5Z" />
    </StrokeIcon>
  );
}
