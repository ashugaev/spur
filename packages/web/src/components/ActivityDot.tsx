"use client";

import { cn } from "@/lib/cn";

const activityConfig: Record<
  string,
  { label: string; dot: string; bg: string; text: string; pulse?: boolean }
> = {
  working: {
    label: "working",
    dot: "var(--color-status-working)",
    bg: "rgba(88,166,255,0.14)",
    text: "var(--color-status-working)",
    pulse: true,
  },
  waiting: {
    label: "waiting",
    dot: "var(--color-status-attention)",
    bg: "rgba(210,153,34,0.14)",
    text: "var(--color-status-attention)",
  },
  needs_input: {
    label: "needs input",
    dot: "var(--color-status-error)",
    bg: "rgba(248,81,73,0.14)",
    text: "var(--color-status-error)",
  },
  stopped: {
    label: "paused",
    dot: "var(--color-text-tertiary)",
    bg: "rgba(72,79,88,0.2)",
    text: "var(--color-text-secondary)",
  },
  error: {
    label: "error",
    dot: "var(--color-status-error)",
    bg: "rgba(248,81,73,0.14)",
    text: "var(--color-status-error)",
  },
  killed: {
    label: "killed",
    dot: "var(--color-text-tertiary)",
    bg: "rgba(72,79,88,0.2)",
    text: "var(--color-text-secondary)",
  },
};

const fallbackConfig = {
  label: "unknown",
  dot: "var(--color-text-tertiary)",
  bg: "rgba(72,79,88,0.2)",
  text: "var(--color-text-secondary)",
};

interface ActivityDotProps {
  activity: string | null;
  dotOnly?: boolean;
  size?: number;
}

export function ActivityDot({ activity, dotOnly = false, size = 6 }: ActivityDotProps) {
  const config = (activity !== null && activityConfig[activity]) || {
    ...fallbackConfig,
    label: activity ?? fallbackConfig.label,
  };

  if (dotOnly) {
    return (
      <div
        className={cn("shrink-0 rounded-full", config.pulse && "dot-pulse")}
        style={{ width: size, height: size, background: config.dot }}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1"
      style={{
        background: config.bg,
        borderColor: "color-mix(in srgb, var(--color-border-default) 85%, transparent)",
      }}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", config.pulse && "dot-pulse")}
        style={{ background: config.dot }}
      />
      <span className="text-[11px] font-medium" style={{ color: config.text }}>
        {config.label}
      </span>
    </span>
  );
}
