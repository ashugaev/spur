"use client";

import { useEffect } from "react";
import { holdScreenWakeLock } from "@/lib/screen-wake-lock";

export function useScreenWakeLock(active: boolean): void {
  useEffect(() => (active ? holdScreenWakeLock() : undefined), [active]);
}
