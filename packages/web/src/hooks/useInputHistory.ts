"use client";

import { useCallback, useEffect, useState } from "react";

export interface InputHistoryEntry {
  value: string;
  savedAt: string;
}

const INPUT_HISTORY_LIMIT = 5;

function isInputHistoryEntry(value: unknown): value is InputHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry["value"] === "string" && typeof entry["savedAt"] === "string";
}

function readInputHistory(storageKey: string): InputHistoryEntry[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isInputHistoryEntry).slice(0, INPUT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function useInputHistory(storageKey: string) {
  const [entries, setEntries] = useState<InputHistoryEntry[]>([]);

  useEffect(() => {
    setEntries(readInputHistory(storageKey));
  }, [storageKey]);

  const saveEntry = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setEntries((current) => {
        const next = [
          { value: trimmed, savedAt: new Date().toISOString() },
          ...current.filter((entry) => entry.value !== trimmed),
        ].slice(0, INPUT_HISTORY_LIMIT);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        }
        return next;
      });
    },
    [storageKey],
  );

  return { entries, saveEntry };
}
