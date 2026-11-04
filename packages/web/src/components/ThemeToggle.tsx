"use client";

import { useEffect, useRef } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useFooterPopover } from "@/lib/footer-popover";
import { useTheme, type Theme } from "@/lib/theme-context";

export function ThemeToggle() {
  const { mode, theme, setMode } = useTheme();
  const popover = useFooterPopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const { dismiss } = popover;
  useEffect(() => {
    if (!popover.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismiss();
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [popover.open, dismiss]);

  const fixedRow = (value: Theme, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => {
        if (mode !== value) setMode(value);
      }}
      className={cn(
        "col-span-full -mx-1.5 grid grid-cols-subgrid items-center px-1.5 py-1 text-left outline-none transition-colors hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] focus-visible:bg-[var(--color-hover-overlay)] focus-visible:text-[var(--color-text-primary)]",
        mode === value
          ? "font-bold text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)]",
      )}
    >
      <span>{label}</span>
      <span aria-hidden="true" className="text-center text-[var(--color-accent)]">
        {mode === value ? "✓" : ""}
      </span>
    </button>
  );

  return (
    <div
      ref={popover.containerRef}
      className="relative"
      onBlur={popover.onBlur}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
    >
      <button
        ref={triggerRef}
        aria-label="Theme"
        aria-haspopup="true"
        aria-expanded={popover.open}
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        title="Theme"
        type="button"
        onClick={popover.toggle}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className={cn(
            "h-4 w-4",
            !prefersReducedMotion && "transition-transform duration-200",
            !prefersReducedMotion && theme === "light" && "rotate-180",
          )}
        >
          <path
            d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {popover.open ? (
        <div
          role="group"
          aria-label="Theme"
          className="absolute bottom-full right-0 z-50 mb-1.5 grid min-w-[180px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)] max-[400px]:right-auto max-[400px]:left-1/2 max-[400px]:-translate-x-1/2"
        >
          <div className="col-span-full mb-2 grid grid-cols-subgrid items-center border-b border-[var(--color-border-subtle)] pb-2">
            <span className="text-[var(--color-text-secondary)]">Theme</span>
            <label className="col-span-2 grid cursor-pointer grid-cols-subgrid items-center">
              <input
                type="checkbox"
                aria-label="Auto theme"
                checked={mode === "auto"}
                className="accent-[var(--color-accent)]"
                onChange={(event) => setMode(event.target.checked ? "auto" : theme)}
              />
              <span
                className={
                  mode === "auto"
                    ? "font-bold text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-tertiary)]"
                }
              >
                Auto
              </span>
            </label>
          </div>
          <div
            role="radiogroup"
            aria-label="Fixed theme"
            className="col-span-full grid grid-cols-subgrid gap-y-0.5"
          >
            {fixedRow("light", "Light")}
            {fixedRow("dark", "Dark")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
