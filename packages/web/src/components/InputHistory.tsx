"use client";

import { useEffect, useRef, useState } from "react";
import type { InputHistoryEntry } from "@/hooks/useInputHistory";

function HistoryIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function formatInputHistoryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

interface InputHistoryButtonProps {
  entries: InputHistoryEntry[];
  onSelect: (value: string) => void;
  className?: string;
}

const DEFAULT_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-primary)] transition hover:bg-white/5";

export function InputHistoryButton({ entries, onSelect, className }: InputHistoryButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-label="History"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={className ?? DEFAULT_BUTTON_CLASS}
        onClick={() => setOpen((current) => !current)}
        title="History"
        type="button"
      >
        <HistoryIcon />
      </button>
      {open ? (
        <div
          aria-label="Input history"
          className="absolute bottom-full right-0 z-20 mb-2 w-80 max-w-[calc(100vw-2rem)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] shadow-[0_8px_30px_rgba(0,0,0,0.3)]"
          role="dialog"
        >
          <div className="border-b border-[var(--color-border-default)] px-3 py-2 font-bold uppercase text-[var(--color-text-primary)]">
            Recent inputs
          </div>
          {entries.length > 0 ? (
            <div className="max-h-80 overflow-y-auto">
              {entries.map((entry) => (
                <button
                  className="block w-full border-b border-[var(--color-border-subtle)] px-3 py-2 text-left transition hover:bg-white/5 last:border-b-0"
                  key={`${entry.savedAt}:${entry.value}`}
                  onClick={() => {
                    onSelect(entry.value);
                    setOpen(false);
                  }}
                  type="button"
                >
                  <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    {formatInputHistoryTimestamp(entry.savedAt)}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-[var(--color-text-primary)]">
                    {entry.value}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-[var(--color-text-secondary)]">No saved inputs yet.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
