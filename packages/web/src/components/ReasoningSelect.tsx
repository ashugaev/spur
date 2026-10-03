"use client";

import { Skeleton } from "@/components/Skeleton";
import { INPUT_CLASS } from "@/design/classes";
import type { ProviderReasoningEffort } from "@/lib/types";
import type { ReasoningIntent } from "@/lib/reasoning-effort";

export function ReasoningSelect({
  label,
  intent,
  levels,
  loading,
  error,
  needsModel,
  lifecycle,
  projectEffort,
  onChange,
  submitting = false,
}: {
  label: string;
  intent: ReasoningIntent;
  levels: ProviderReasoningEffort[] | undefined;
  loading: boolean;
  error: string | null;
  needsModel: boolean;
  lifecycle: boolean;
  projectEffort?: ProviderReasoningEffort | null;
  onChange: (intent: ReasoningIntent) => void;
  submitting?: boolean;
}) {
  if (loading)
    return (
      <div className={`w-full sm:w-auto ${INPUT_CLASS}`}>
        <Skeleton className="h-3 w-16" label="Resolving reasoning" />
      </div>
    );
  const unavailable = error !== null || (!needsModel && levels === undefined);
  const unsupported = !unavailable && levels?.length === 0;
  const disabled = unavailable || unsupported || needsModel;
  const value = intent.kind === "explicit" || intent.kind === "carried" ? intent.level : "default";
  const title = unavailable
    ? "Unavailable"
    : needsModel
      ? "Pick a model"
      : unsupported
        ? "Not supported"
        : `Default (${projectEffort ? `project: ${projectEffort[0].toUpperCase() + projectEffort.slice(1)}` : "agent"})`;
  return (
    <div className="flex w-full min-w-32 flex-col gap-1 sm:w-auto">
      <select
        aria-label={label}
        className={INPUT_CLASS}
        disabled={disabled || submitting}
        value={disabled ? "default" : value}
        onChange={(event) => {
          const level = levels?.find((entry) => entry === event.target.value);
          onChange(
            level ? { kind: "explicit", level } : { kind: lifecycle ? "clear" : "default-new" },
          );
        }}
      >
        <option value="default">Reasoning · {title}</option>
        {!disabled &&
          levels?.map((level) => (
            <option key={level} value={level}>
              Reasoning · {level[0].toUpperCase() + level.slice(1)}
              {intent.kind === "carried" && intent.level === level ? " · current" : ""}
            </option>
          ))}
      </select>
      {disabled ? (
        <span
          className={`text-[10px] uppercase tracking-[0.1em] ${unavailable ? "text-[var(--color-status-error)]" : "text-[var(--color-text-tertiary)]"}`}
        >
          {unavailable
            ? (error ?? "Reasoning capabilities unavailable")
            : needsModel
              ? "OpenCode needs a model for reasoning levels"
              : "This model has no reasoning levels"}
        </span>
      ) : null}
    </div>
  );
}
