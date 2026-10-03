import type { ProviderReasoningEffort } from "@/lib/types";

export function isProviderReasoningEffort(value: unknown): value is ProviderReasoningEffort {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
  );
}

export type ReasoningIntent =
  | { kind: "default-new" }
  | { kind: "carried"; level: ProviderReasoningEffort }
  | { kind: "explicit"; level: ProviderReasoningEffort }
  | { kind: "clear" };

export function initialReasoningIntent(
  lifecycle: boolean,
  level?: ProviderReasoningEffort,
): ReasoningIntent {
  return lifecycle && level !== undefined ? { kind: "carried", level } : { kind: "default-new" };
}

export function serializeReasoningIntent(
  intent: ReasoningIntent,
): ProviderReasoningEffort | null | undefined {
  if (intent.kind === "explicit") return intent.level;
  if (intent.kind === "clear") return null;
  return undefined;
}
