/**
 * Shared class strings for recurring UI shapes. Colocated with `colors.ts` so
 * the design-system surface lives in one directory. Callers compose these with
 * layout-specific utilities (`flex-1`, `w-full`, `pr-12`, etc.).
 */

export const INPUT_CLASS =
  "border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]";

export const FOCUS_RING_CLASS =
  "outline-hidden focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-[var(--color-accent)]";

const BUTTON_BASE_CLASS = `border px-2 py-1 font-bold uppercase transition-colors ${FOCUS_RING_CLASS} disabled:cursor-not-allowed disabled:opacity-50`;

/** Square icon-only button. Caller adds size (`h-8 w-8`) and idle text color. */
export const ICON_BUTTON_CLASS = `inline-flex shrink-0 items-center justify-center border border-[var(--color-border-strong)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] ${FOCUS_RING_CLASS} disabled:cursor-not-allowed disabled:opacity-50`;

export const SECONDARY_BUTTON_CLASS = `${BUTTON_BASE_CLASS} border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]`;

export const PRIMARY_BUTTON_CLASS = `${BUTTON_BASE_CLASS} border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] hover:border-[var(--color-accent-hover)]`;

export const DANGER_BUTTON_CLASS = `${BUTTON_BASE_CLASS} border-[var(--color-status-error)] text-[var(--color-status-error)] hover:bg-[var(--color-status-error)] hover:text-[var(--color-bg-elevated)]`;

export const ATTENTION_BUTTON_CLASS = `${BUTTON_BASE_CLASS} border-[var(--color-status-attention)] text-[var(--color-status-attention)] hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)]`;

export const CHECKBOX_CLASS =
  "accent-[var(--color-accent)] outline-hidden focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]";

export const HARD_WRAP_TEXT_CLASS = "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]";

export const STATUS_CARD_CLASS =
  "border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-raised";
