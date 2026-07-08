"use client";

import { createContext, useContext } from "react";
import type { SpurTagDefinition } from "@/lib/types";

export interface TagChange {
  add?: string[];
  remove?: string[];
}

export interface TagsContextValue {
  catalog: SpurTagDefinition[];
  applyTags: (sessionId: string, change: TagChange) => Promise<void>;
}

const defaultValue: TagsContextValue = {
  catalog: [],
  applyTags: async () => {},
};

export const TagsContext = createContext<TagsContextValue>(defaultValue);

export function useTags(): TagsContextValue {
  return useContext(TagsContext);
}
