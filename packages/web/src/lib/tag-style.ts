import type { CSSProperties } from "react";

// Shared class string for the bordered, uppercase tag chip. Consumed by the tag
// editor and the tag filter dropdown so a chip reads identically in both places.
export const CHIP_CLASS =
  "inline-flex items-center border p-1.5 text-[9px] uppercase leading-none tracking-[0.06em]";

// Shared styled-chip look for a tag, keyed off its configured color. Used both
// on dashboard session cards and in the tag filter dropdown so a tag reads the
// same in either place.
export function tagChipStyle(color: string): CSSProperties {
  return {
    color,
    borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
  };
}
