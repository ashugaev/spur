"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ToastEntry {
  id: number;
  tone: "success" | "error";
  title: string;
  detail?: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (tone: ToastEntry["tone"], title: string, detail?: string, autoDismissMs?: number) => {
      nextIdRef.current += 1;
      const id = nextIdRef.current;
      setToasts((current) => [...current, { id, tone, title, detail }]);
      if (autoDismissMs !== undefined && typeof window !== "undefined") {
        const timer = window.setTimeout(() => dismissToast(id), autoDismissMs);
        timersRef.current.push(timer);
      }
    },
    [dismissToast],
  );

  const showSuccessToast = useCallback(
    (title: string, detail?: string) => showToast("success", title, detail, 2500),
    [showToast],
  );

  const showErrorToast = useCallback(
    (title: string, detail?: string) => showToast("error", title, detail),
    [showToast],
  );

  useEffect(
    () => () => {
      for (const timer of timersRef.current) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  return {
    toasts,
    showSuccessToast,
    showErrorToast,
    dismissToast,
  };
}
