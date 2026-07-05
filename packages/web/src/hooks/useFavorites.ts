"use client";

import { useEffect, useState } from "react";

function readFavoriteKeys(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? new Set(parsed)
      : new Set();
  } catch {
    return new Set();
  }
}

function writeFavoriteKeys(storageKey: string, keys: ReadonlySet<string>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey, JSON.stringify([...keys].sort()));
}

export interface Favorites {
  keys: ReadonlySet<string>;
  has: (key: string) => boolean;
  toggle: (key: string) => void;
}

// Favorite keys persisted in localStorage under storageKey, kept in sync across
// tabs via the storage event. Callers build their own composite key strings.
// keys is exposed so consumers can list it in effect/memo dependency arrays.
export function useFavorites(storageKey: string): Favorites {
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(() => readFavoriteKeys(storageKey));

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setFavoriteKeys(readFavoriteKeys(storageKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  return {
    keys: favoriteKeys,
    has: (key: string) => favoriteKeys.has(key),
    toggle: (key: string) => {
      setFavoriteKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        writeFavoriteKeys(storageKey, next);
        return next;
      });
    },
  };
}
