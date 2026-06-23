"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "success" | "error";

export interface ToastEntry {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

interface AddToastInput {
  tone: ToastTone;
  title: string;
  detail?: string;
  autoDismissMs?: number;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback(
    ({ tone, title, detail, autoDismissMs }: AddToastInput) => {
      nextIdRef.current += 1;
      const id = Date.now() + nextIdRef.current;
      setToasts((current) => [...current, { id, tone, title, detail }]);
      if (autoDismissMs !== undefined && typeof window !== "undefined") {
        const timer = window.setTimeout(() => dismissToast(id), autoDismissMs);
        timersRef.current.push(timer);
      }
      return id;
    },
    [dismissToast],
  );

  const showSuccessToast = useCallback(
    (title: string, detail?: string) =>
      addToast({ tone: "success", title, detail, autoDismissMs: 2500 }),
    [addToast],
  );

  const showErrorToast = useCallback(
    (title: string, detail?: string) => addToast({ tone: "error", title, detail }),
    [addToast],
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
