"use client";

import { useEffect } from "react";

const ZOOMABLE_FIELD_SELECTOR = "input, textarea, select";

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as "MacIntel" in desktop mode; touch support disambiguates it from a Mac.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function withMaxScale(content: string): string {
  if (/maximum-scale\s*=/.test(content)) {
    return content.replace(/maximum-scale\s*=\s*[\d.]+/, "maximum-scale=1");
  }
  return `${content}, maximum-scale=1`;
}

/**
 * iOS Safari auto-zooms the page when a focused form field computes to
 * font-size < 16px. Toggling `maximum-scale=1` only while a field is
 * focused suppresses that zoom without touching field font-size or
 * disabling the user's own pinch-zoom the rest of the time.
 */
export function useSuppressIOSAutoZoom(): void {
  useEffect(() => {
    if (!isIOS()) return;

    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;

    const originalContent = meta.getAttribute("content") ?? "";
    let focusedCount = 0;
    let pendingRestore: ReturnType<typeof setTimeout> | undefined;

    const isZoomableField = (target: EventTarget | null): boolean =>
      target instanceof Element && target.matches(ZOOMABLE_FIELD_SELECTOR);

    const handleFocusIn = (event: FocusEvent) => {
      if (!isZoomableField(event.target)) return;
      if (pendingRestore !== undefined) {
        clearTimeout(pendingRestore);
        pendingRestore = undefined;
      }
      focusedCount += 1;
      if (focusedCount === 1) {
        meta.setAttribute("content", withMaxScale(originalContent));
      }
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!isZoomableField(event.target)) return;
      focusedCount = Math.max(0, focusedCount - 1);
      if (focusedCount === 0) {
        // Deferred so a same-tick focusin on the next field (tabbing
        // between inputs) cancels this before the viewport flips back.
        pendingRestore = setTimeout(() => {
          pendingRestore = undefined;
          meta.setAttribute("content", originalContent);
        }, 0);
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      if (pendingRestore !== undefined) clearTimeout(pendingRestore);
      meta.setAttribute("content", originalContent);
    };
  }, []);
}
