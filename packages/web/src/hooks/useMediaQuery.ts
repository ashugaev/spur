"use client";

import { useEffect, useState } from "react";

function toQuery(queryOrBreakpoint: string | number): string {
  if (typeof queryOrBreakpoint === "number") {
    return `(max-width: ${queryOrBreakpoint}px)`;
  }
  return queryOrBreakpoint;
}

export const MOBILE_BREAKPOINT = 767;
// Byte-equal to the Tailwind sm breakpoint media query, so JS and max-sm: classes agree.
export const PHONE_QUERY = "(width < 40rem)";

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
