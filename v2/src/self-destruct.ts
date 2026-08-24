import type { SelfDestructConfig } from "./types.js";

export const SELF_DESTRUCT_TOOL_NAME = "spur-self-destruct";
// Mirrored (hand-copied, web cannot import from v2) in
// packages/web/src/lib/self-destruct.ts. Keep both literals identical —
// guarded by the drift test in test/fast/self-destruct.test.ts.
export const DEFAULT_SELF_DESTRUCT_CONDITION = "every objective in the task prompt is done";
const SELF_DESTRUCT_INSTRUCTIONS_MARKER = "\nSelf-destruct:\n-";

export function normalizeSelfDestructConfig(value: unknown): SelfDestructConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("selfDestruct must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["enabled"] !== "boolean") {
    throw new Error("selfDestruct.enabled must be a boolean");
  }
  const enabled = raw["enabled"];
  const conditionsRaw = raw["conditions"];
  if (conditionsRaw !== undefined && typeof conditionsRaw !== "string") {
    throw new Error("selfDestruct.conditions must be a string");
  }
  const conditions = conditionsRaw?.trim();
  return {
    enabled,
    ...(conditions ? { conditions } : {}),
  };
}

export function withSelfDestructInstructions(
  prompt: string,
  config: SelfDestructConfig | undefined,
): string {
  if (!config?.enabled || prompt.includes(SELF_DESTRUCT_INSTRUCTIONS_MARKER)) {
    return prompt;
  }

  const condition = config.conditions ?? DEFAULT_SELF_DESTRUCT_CONDITION;
  return `${prompt}

Self-destruct:
- When ${condition}, run \`"$SPUR_SESSION_TOOL_DIR/${SELF_DESTRUCT_TOOL_NAME}"\`.
- This completes and removes the temporary Spur agent session. Run it only after the condition above is satisfied.`;
}
