"use client";

import { type FocusEvent, useEffect, useRef, useState } from "react";

const HOVER_OPEN_DELAY_MS = 100;

export interface FooterPopover {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  open: boolean;
  onBlur(event: FocusEvent<HTMLDivElement>): void;
  onMouseEnter(): void;
  onMouseLeave(): void;
  toggle(): void;
  dismiss(): void;
}

export function useFooterPopover(): FooterPopover {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = !dismissed && (hovered || pinned);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current === null) return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  useEffect(() => clearHoverTimer, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const touchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (!touchDevice || !open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      setDismissed(true);
      setPinned(false);
      setHovered(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return {
    containerRef,
    open,
    onBlur(event: FocusEvent<HTMLDivElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setPinned(false);
        setDismissed(false);
      }
    },
    onMouseEnter() {
      setDismissed(false);
      clearHoverTimer();
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        setHovered(true);
      }, HOVER_OPEN_DELAY_MS);
    },
    onMouseLeave() {
      clearHoverTimer();
      setDismissed(false);
      setHovered(false);
    },
    toggle() {
      setDismissed(false);
      setPinned((current) => !current);
    },
    dismiss() {
      setDismissed(true);
      setPinned(false);
    },
  };
}
