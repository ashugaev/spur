"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_VISIBLE_TOASTS = 5;
const SUCCESS_TOAST_DISMISS_MS = 2_500;
const ERROR_TOAST_DISMISS_MS = 8_000;

export interface ToastEntry {
  id: number;
  tone: "success" | "error";
  title: string;
  detail?: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef<Map<number, number>>(new Map());

  const clearToastTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const dismissToast = useCallback(
    (id: number) => {
      clearToastTimer(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearToastTimer],
  );

  const showToast = useCallback(
    (
      tone: ToastEntry["tone"],
      title: string,
      detail: string | undefined,
      autoDismissMs: number,
    ) => {
      nextIdRef.current += 1;
      const id = nextIdRef.current;
      setToasts((current) => {
        const next = [...current, { id, tone, title, detail }];
        const dropped = next.slice(0, Math.max(0, next.length - MAX_VISIBLE_TOASTS));
        for (const toast of dropped) {
          clearToastTimer(toast.id);
        }
        return next.slice(-MAX_VISIBLE_TOASTS);
      });
      if (typeof window !== "undefined") {
        const timer = window.setTimeout(() => {
          timersRef.current.delete(id);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }, autoDismissMs);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [clearToastTimer],
  );

  const showSuccessToast = useCallback(
    (title: string, detail?: string) =>
      showToast("success", title, detail, SUCCESS_TOAST_DISMISS_MS),
    [showToast],
  );

  const showErrorToast = useCallback(
    (title: string, detail?: string) => showToast("error", title, detail, ERROR_TOAST_DISMISS_MS),
    [showToast],
  );

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
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
