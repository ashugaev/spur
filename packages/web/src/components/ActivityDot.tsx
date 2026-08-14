"use client";

import { cn } from "@/lib/cn";

type ActivityConfig = { label: string; dot: string; bg: string; text: string; pulse?: boolean };

const errorConfig: ActivityConfig = {
  label: "error",
  dot: "var(--color-status-error)",
  bg: "var(--color-dot-bg-error)",
  text: "var(--color-status-error)",
};

const inactiveConfig: ActivityConfig = {
  label: "paused",
  dot: "var(--color-text-tertiary)",
  bg: "var(--color-dot-bg-inactive)",
  text: "var(--color-text-secondary)",
};

const activityConfig: Record<string, ActivityConfig> = {
  working: {
    label: "working",
    dot: "var(--color-status-working)",
    bg: "var(--color-dot-bg-working)",
    text: "var(--color-status-working)",
    pulse: true,
  },
  waiting: {
    label: "waiting",
    dot: "var(--color-status-attention)",
    bg: "var(--color-dot-bg-waiting)",
    text: "var(--color-status-attention)",
  },
  needs_input: { ...errorConfig, label: "needs input" },
  rate_limited: {
    label: "rate limited",
    dot: "var(--color-status-attention)",
    bg: "var(--color-dot-bg-waiting)",
    text: "var(--color-status-attention)",
  },
  error: errorConfig,
  stopped: { ...inactiveConfig, label: "stopped" },
  killed: { ...inactiveConfig, label: "killed" },
};

const fallbackConfig: ActivityConfig = { ...inactiveConfig, label: "unknown" };

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
      <span className="text-[10px] font-medium" style={{ color: config.text }}>
        {config.label}
      </span>
    </span>
  );
}
