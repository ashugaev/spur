/** Status tones. Components take a tone, never a raw color. */
export type StatusTone = "working" | "ready" | "attention" | "error" | "inactive";

/** Dot, icon, edge and status-word color for a tone. */
export function toneColor(tone: StatusTone): string {
  return `var(--color-status-${tone})`;
}

/** Tint ground for a tone (chip, badge, activity pill). */
export function toneBg(tone: StatusTone): string {
  return `var(--color-status-${tone}-bg)`;
}

/** Chip or zone-rule edge for a tone. */
export function toneBorder(tone: StatusTone): string {
  return `var(--color-status-${tone}-border)`;
}
