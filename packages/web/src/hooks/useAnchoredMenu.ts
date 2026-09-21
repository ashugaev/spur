"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface AnchoredMenu {
  containerRef: React.RefObject<HTMLDivElement | null>;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  menuStyle: CSSProperties | undefined;
}

interface UseAnchoredMenuOptions {
  open: boolean;
  onClose: () => void;
  // Content values that change the menu's size; positioning re-runs when they change.
  contentDeps: readonly unknown[];
  // Which side to try first; falls back to the other side when the preferred
  // one doesn't fit, and finally clamps within the viewport. Defaults to
  // "above" — the original behavior, kept for existing callers (e.g. dashboard
  // row menus, which sit low enough in the viewport that "above" is usually
  // the correct first try).
  preferredSide?: "above" | "below";
  // Horizontal anchor: "start" lines the menu's left edge up with the
  // button's left edge (default), "end" lines the menu's right edge up with
  // the button's right edge. Both clamp within the viewport.
  align?: "start" | "end";
}

// A fixed-position dropdown anchored to a trigger button: closes on outside
// pointerdown or Escape, and keeps the menu within the viewport, flipping to
// the other side when the preferred one doesn't fit. The caller owns the open
// state so it can drive data fetching from it before computing contentDeps.
export function useAnchoredMenu({
  open,
  onClose,
  contentDeps,
  preferredSide = "above",
  align = "start",
}: UseAnchoredMenuOptions): AnchoredMenu {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open) return;
      if (containerRef.current?.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(undefined);
      return;
    }
    const updateMenuPosition = () => {
      const button = buttonRef.current;
      const menu = menuRef.current;
      if (!button || !menu) return;
      const margin = 8;
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const width = Math.min(
        Math.max(menuRect.width, Math.min(menu.scrollWidth, window.innerWidth - margin * 2)),
        window.innerWidth - margin * 2,
      );
      const preferredLeft = align === "end" ? buttonRect.right - width : buttonRect.left;
      const left = Math.min(
        Math.max(margin, preferredLeft),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const aboveTop = buttonRect.top - menuRect.height - margin;
      const belowTop = buttonRect.bottom + margin;
      const fitsAbove = aboveTop >= margin;
      const fitsBelow = belowTop + menuRect.height <= window.innerHeight - margin;
      const clampedFallback = Math.max(
        margin,
        Math.min(belowTop, window.innerHeight - menuRect.height - margin),
      );
      let top: number;
      if (preferredSide === "below") {
        top = fitsBelow ? belowTop : fitsAbove ? aboveTop : clampedFallback;
      } else {
        top = fitsAbove ? aboveTop : clampedFallback;
      }
      setMenuStyle({ left: `${left}px`, top: `${top}px`, width: `${width}px` });
    };
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, preferredSide, align, ...contentDeps]);

  return { containerRef, buttonRef, menuRef, menuStyle };
}
