"use client";

import { type RefObject, useEffect } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus contract: focus `initialRef` on mount, restore prior focus on
 * unmount, trap Tab inside `panelRef`, and call `onEscape` unless `escapeBlocked`.
 */
export function useDialogFocus({
  panelRef,
  initialRef,
  onEscape,
  escapeBlocked = false,
}: {
  panelRef: RefObject<HTMLElement | null>;
  initialRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
  escapeBlocked?: boolean;
}): void {
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
    // Mount-only: initial focus and restore happen once per dialog.
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !escapeBlocked) {
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelRef, onEscape, escapeBlocked]);
}
