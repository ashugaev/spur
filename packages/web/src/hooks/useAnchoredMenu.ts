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
}

// A fixed-position dropdown anchored to a trigger button: closes on outside
// pointerdown or Escape, and keeps the menu within the viewport, flipping above
// the button when there is no room below. The caller owns the open state so it
// can drive data fetching from it before computing contentDeps.
export function useAnchoredMenu({
  open,
  onClose,
  contentDeps,
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
      const left = Math.min(
        Math.max(margin, buttonRect.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const aboveTop = buttonRect.top - menuRect.height - margin;
      const belowTop = buttonRect.bottom + margin;
      const top =
        aboveTop >= margin
          ? aboveTop
          : Math.max(margin, Math.min(belowTop, window.innerHeight - menuRect.height - margin));
      setMenuStyle({ left: `${left}px`, top: `${top}px`, width: `${width}px` });
    };
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, ...contentDeps]);

  return { containerRef, buttonRef, menuRef, menuStyle };
}
