"use client";

import { type StatusTone, toneBg, toneColor } from "@/design/tone";
import { cn } from "@/lib/cn";

type ActivityConfig = { label: string; tone: StatusTone; pulse?: boolean };

const activityConfig: Record<string, ActivityConfig> = {
  working: { label: "working", tone: "working", pulse: true },
  starting: { label: "starting", tone: "working", pulse: true },
  waiting: { label: "waiting", tone: "attention" },
  completed: { label: "completed", tone: "ready" },
  closed: { label: "closed", tone: "inactive" },
  needs_input: { label: "needs input", tone: "error" },
  rate_limited: { label: "rate limited", tone: "attention" },
  error: { label: "error", tone: "error" },
  budget_limited: { label: "BUDGET LIMITED", tone: "error" },
  stopped: { label: "stopped", tone: "inactive" },
  killed: { label: "killed", tone: "inactive" },
};

interface ActivityDotProps {
  activity: string | null;
  dotOnly?: boolean;
  size?: number;
}

export function ActivityDot({ activity, dotOnly = false, size = 6 }: ActivityDotProps) {
  const config: ActivityConfig = (activity !== null && activityConfig[activity]) || {
    label: activity ?? "unknown",
    tone: "inactive",
  };
  const dot = toneColor(config.tone);

  if (dotOnly) {
    return (
      <div
        className={cn("shrink-0 rounded-dot", config.pulse && "dot-pulse")}
        style={{ width: size, height: size, background: dot }}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 border px-2 py-1"
      style={{
        background: toneBg(config.tone),
        borderColor: "color-mix(in srgb, var(--color-border-default) 85%, transparent)",
      }}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-dot", config.pulse && "dot-pulse")}
        style={{ background: dot }}
      />
      <span className="text-label font-medium" style={{ color: dot }}>
        {config.label}
      </span>
    </span>
  );
}
