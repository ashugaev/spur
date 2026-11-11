"use client";

import { type FocusEvent, useEffect, useRef, useState } from "react";

const HOVER_OPEN_DELAY_MS = 100;
const TOUCH_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

export interface FooterPopover<T extends HTMLElement = HTMLDivElement> {
  containerRef: React.MutableRefObject<T | null>;
  open: boolean;
  onBlur(event: FocusEvent<T>): void;
  onMouseEnter(): void;
  onMouseLeave(): void;
  toggle(): void;
  dismiss(): void;
}

export function isTouchPointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia(TOUCH_POINTER_QUERY).matches;
}

// closeDelayMs > 0 keeps the popover open for that long after mouseleave so a
// pointer crossing a gap between trigger and card does not close it.
export function useFooterPopover<T extends HTMLElement = HTMLDivElement>({
  closeDelayMs = 0,
}: { closeDelayMs?: number } = {}): FooterPopover<T> {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const containerRef = useRef<T | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = !dismissed && (hovered || pinned);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current === null) return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const close = () => {
    clearHoverTimer();
    clearCloseTimer();
    setDismissed(true);
    setPinned(false);
    setHovered(false);
  };

  useEffect(
    () => () => {
      clearHoverTimer();
      clearCloseTimer();
    },
    [],
  );

  useEffect(() => {
    if (!isTouchPointer() || !open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      close();
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return {
    containerRef,
    open,
    onBlur(event: FocusEvent<T>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        close();
      }
    },
    onMouseEnter() {
      setDismissed(false);
      clearHoverTimer();
      clearCloseTimer();
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        setHovered(true);
      }, HOVER_OPEN_DELAY_MS);
    },
    onMouseLeave() {
      clearHoverTimer();
      setDismissed(false);
      if (closeDelayMs <= 0) {
        setHovered(false);
        return;
      }
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setHovered(false);
      }, closeDelayMs);
    },
    toggle() {
      setDismissed(false);
      setPinned((current) => !current);
    },
    dismiss: close,
  };
}
