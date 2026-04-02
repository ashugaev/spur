"use client";

import { useEffect, useState } from "react";

function toQuery(queryOrBreakpoint: string | number): string {
  if (typeof queryOrBreakpoint === "number") {
    return `(max-width: ${queryOrBreakpoint}px)`;
  }
  return queryOrBreakpoint;
}

export const MOBILE_BREAKPOINT = 767;

export function useMediaQuery(queryOrBreakpoint: string | number): boolean {
  const query = toQuery(queryOrBreakpoint);
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQueryList = window.matchMedia(query);
    setMatches(mediaQueryList.matches);

    const listener = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", listener);
      return () => mediaQueryList.removeEventListener("change", listener);
    }

    mediaQueryList.addListener(listener);
    return () => mediaQueryList.removeListener(listener);
  }, [query]);

  return matches;
}
