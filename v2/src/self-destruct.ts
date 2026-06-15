import type { SelfDestructConfig } from "./types.js";

export const SELF_DESTRUCT_TOOL_NAME = "spur-self-destruct";
const DEFAULT_SELF_DESTRUCT_CONDITION = "the assigned task is complete";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("selfDestruct must be an object");
  }
  return value as Record<string, unknown>;
}

export function normalizeSelfDestructConfig(value: unknown): SelfDestructConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const raw = asRecord(value);
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
  if (!config?.enabled || prompt.includes(SELF_DESTRUCT_TOOL_NAME)) {
    return prompt;
  }

  const condition = config.conditions ?? DEFAULT_SELF_DESTRUCT_CONDITION;
  return `${prompt}

Self-destruct:
- When ${condition}, run \`"$SPUR_SESSION_TOOL_DIR/${SELF_DESTRUCT_TOOL_NAME}"\`.
- This completes and removes the temporary Spur agent session. Run it only after the condition above is satisfied.`;
}
