"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ModelSelect,
  type ModelCatalogState,
  type ModelSelectProps,
} from "@/components/ModelSelect";
import { ReasoningSelect } from "@/components/ReasoningSelect";
import type { ReasoningIntent } from "@/lib/reasoning-effort";
import type { ProviderReasoningEffort } from "@/lib/types";

interface Props extends Omit<ModelSelectProps, "onResolvedChange"> {
  onValidityChange: ModelSelectProps["onResolvedChange"];
  reasoningIntent: ReasoningIntent;
  onReasoningChange: (intent: ReasoningIntent) => void;
  reasoningLabel: string;
  lifecycle?: boolean;
  projectReasoningEffort?: ProviderReasoningEffort | null;
}

export function ModelReasoningField({
  reasoningIntent,
  onReasoningChange,
  reasoningLabel,
  lifecycle = false,
  projectReasoningEffort,
  onValidityChange,
  ...modelProps
}: Props) {
  const [catalog, setCatalog] = useState<ModelCatalogState | null>(null);
  const [modelValidity, setModelValidity] = useState({
    resolved: false,
    error: null as string | null,
  });
  const [attention, setAttention] = useState<string | null>(null);
  const previous = useRef({ agent: modelProps.agent, model: modelProps.value });
  const callback = useRef(onValidityChange);
  callback.current = onValidityChange;
  const reasoningCallback = useRef(onReasoningChange);
  reasoningCallback.current = onReasoningChange;
  const current =
    catalog?.agent === modelProps.agent && catalog.model === modelProps.value ? catalog : null;
  const loading = current === null || current.loading || modelProps.spawnDefaults.loading;
  const selected =
    reasoningIntent.kind === "explicit" || reasoningIntent.kind === "carried"
      ? reasoningIntent.level
      : undefined;
  const valid =
    selected === undefined ||
    (reasoningIntent.kind === "carried" && previous.current.model === modelProps.value) ||
    (!loading && current?.error === null && current.levels?.includes(selected) === true);

  useEffect(() => {
    const agentChanged = previous.current.agent !== modelProps.agent;
    const modelChanged = previous.current.model !== modelProps.value;
    const clearUnsupported = (level: ProviderReasoningEffort) => {
      reasoningCallback.current({ kind: lifecycle ? "clear" : "default-new" });
      setAttention(
        `${level[0].toUpperCase() + level.slice(1)} not offered by ${current?.modelLabel ?? modelProps.value ?? "this model"}, using Default`,
      );
    };
    if (agentChanged) {
      previous.current = { agent: modelProps.agent, model: modelProps.value };
      if (selected !== undefined) reasoningCallback.current({ kind: "default-new" });
      setAttention(null);
    } else if (!loading && current?.error === null && current.levels !== undefined) {
      if (selected !== undefined && !current.levels.includes(selected)) clearUnsupported(selected);
      if (modelChanged) previous.current = { agent: modelProps.agent, model: modelProps.value };
    }
  }, [
    modelProps.agent,
    modelProps.value,
    loading,
    current,
    selected,
    lifecycle,
    reasoningIntent.kind,
  ]);

  useEffect(() => {
    callback.current(modelValidity.resolved && valid, modelValidity.error);
  }, [modelValidity, valid]);
  const handleResolved = useCallback(
    (resolved: boolean, error: string | null) => setModelValidity({ resolved, error }),
    [],
  );
  const handleCatalog = useCallback((state: ModelCatalogState) => setCatalog(state), []);

  return (
    <div className="contents">
      <div className="min-w-40 flex-1">
        <ModelSelect
          {...modelProps}
          onResolvedChange={handleResolved}
          onCatalogChange={handleCatalog}
        />
      </div>
      <ReasoningSelect
        label={reasoningLabel}
        intent={reasoningIntent}
        levels={current?.levels}
        loading={loading}
        error={current?.error ?? null}
        needsModel={modelProps.agent === "opencode" && modelProps.value === null}
        lifecycle={lifecycle}
        projectEffort={projectReasoningEffort ?? modelProps.spawnDefaults.reasoningEffort}
        onChange={(intent) => {
          setAttention(null);
          onReasoningChange(intent);
        }}
      />
      {attention ? (
        <span className="w-full text-[10px] uppercase tracking-[0.1em] text-[var(--color-status-attention)]">
          {attention}
        </span>
      ) : null}
    </div>
  );
}
