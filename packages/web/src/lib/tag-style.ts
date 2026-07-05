import type { CSSProperties } from "react";

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
