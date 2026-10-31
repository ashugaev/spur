import type { ProviderReasoningEffort } from "@/lib/types";

export const PROVIDER_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const satisfies readonly ProviderReasoningEffort[];

export function isProviderReasoningEffort(value: unknown): value is ProviderReasoningEffort {
  return PROVIDER_REASONING_EFFORTS.some((effort) => effort === value);
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
