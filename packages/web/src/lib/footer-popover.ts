"use client";

import { type FocusEvent, useEffect, useRef, useState } from "react";

const FOOTER_POPOVER_OPEN_EVENT = "spur:footer-popover-open";

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
  const instanceId = useRef(Symbol("footer-popover"));
  const hoveredRef = useRef(false);
  const suppressHoverRef = useRef(false);
  const open = !dismissed && (hovered || pinned);

  const announceOpen = () => {
    window.dispatchEvent(
      new CustomEvent(FOOTER_POPOVER_OPEN_EVENT, { detail: instanceId.current }),
    );
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onPeerOpen = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail === instanceId.current) return;
      suppressHoverRef.current = hoveredRef.current;
      setDismissed(true);
      setPinned(false);
      setHovered(false);
    };

    window.addEventListener(FOOTER_POPOVER_OPEN_EVENT, onPeerOpen);
    return () => {
      window.removeEventListener(FOOTER_POPOVER_OPEN_EVENT, onPeerOpen);
    };
  }, []);

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
      hoveredRef.current = true;
      if (suppressHoverRef.current) return;
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        activeElement.closest("footer") &&
        !containerRef.current?.contains(activeElement)
      ) {
        return;
      }
      setDismissed(false);
      setHovered(true);
      announceOpen();
    },
    onMouseLeave() {
      hoveredRef.current = false;
      suppressHoverRef.current = false;
      setDismissed(false);
      setHovered(false);
    },
    toggle() {
      suppressHoverRef.current = false;
      setDismissed(false);
      setPinned((current) => {
        const next = !current;
        if (next) announceOpen();
        return next;
      });
    },
    dismiss() {
      suppressHoverRef.current = false;
      setDismissed(true);
      setPinned(false);
    },
  };
}
