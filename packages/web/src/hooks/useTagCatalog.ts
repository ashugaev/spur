"use client";

import { useQuery } from "@tanstack/react-query";
import type { SpurTagDefinition } from "@/lib/types";

const tagCatalogQueryKey = ["tag-catalog"] as const;

function isTagDefinition(value: unknown): value is SpurTagDefinition {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.description === "string" &&
    typeof record.color === "string"
  );
}

async function fetchTagCatalog(): Promise<SpurTagDefinition[]> {
  const response = await fetch("/api/tags", { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load tag catalog (${response.status})`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) return [];
  const tags = (payload as Record<string, unknown>).tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter(isTagDefinition);
}

// Shared react-query for the tag catalog so multiple consumers dedupe on one
// request and reuse the same cached definitions.
export function useTagCatalog(): SpurTagDefinition[] {
  const { data } = useQuery({
    queryKey: tagCatalogQueryKey,
    queryFn: fetchTagCatalog,
    staleTime: 60_000,
  });
  return data ?? [];
}
