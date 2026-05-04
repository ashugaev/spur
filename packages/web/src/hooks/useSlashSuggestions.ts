"use client";

import { useEffect, useState } from "react";
import type { AgentSuggestionsResponse } from "@/lib/types";

interface UseSlashSuggestionsOptions {
  endpoint: string | null;
  enabled: boolean;
}

export function useSlashSuggestions({ endpoint, enabled }: UseSlashSuggestionsOptions) {
  const [data, setData] = useState<AgentSuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !endpoint) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as AgentSuggestionsResponse | { error?: string };
        if (!response.ok) {
          throw new Error(
            typeof payload === "object" && payload !== null && "error" in payload
              ? String(payload.error ?? "Failed to load slash commands")
              : "Failed to load slash commands",
          );
        }
        if (cancelled) {
          return;
        }
        setData(payload as AgentSuggestionsResponse);
        setError(null);
      })
      .catch((fetchError) => {
        if (cancelled) {
          return;
        }
        setError(
          fetchError instanceof Error ? fetchError.message : "Failed to load slash commands",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, endpoint]);

  return { data, loading, error };
}
