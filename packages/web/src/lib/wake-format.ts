import type { DashboardSession, SpurSessionView } from "@/lib/types";

type WakeSession = Pick<DashboardSession | SpurSessionView, "scheduledWake" | "intervalWake">;

export interface WakeSummary {
  kind: "one-shot" | "interval";
  label: "Wake" | "Interval wake";
  dueAt: string;
  message: string;
  intervalMs?: number;
  stopCondition?: string;
}

export function getWakeSummary(session: WakeSession): WakeSummary | null {
  if (session.intervalWake) {
    return {
      kind: "interval",
      label: "Interval wake",
      dueAt: session.intervalWake.nextDueAt,
      intervalMs: session.intervalWake.intervalMs,
      message: session.intervalWake.message,
      stopCondition: session.intervalWake.stopCondition,
    };
  }

  if (session.scheduledWake) {
    return {
      kind: "one-shot",
      label: "Wake",
      dueAt: session.scheduledWake.dueAt,
      message: session.scheduledWake.message,
    };
  }

  return null;
}

export function formatWakeCountdown(dueAt: string, nowMs = Date.now()): string {
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) return "unknown";

  const remainingMs = dueMs - nowMs;
  if (remainingMs <= 0) return "due now";

  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) return `in ${totalSeconds}s`;

  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return `in ${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes > 0 ? `in ${totalHours}h ${minutes}m` : `in ${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
}

export function formatIntervalDuration(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return "unknown";

  const totalSeconds = Math.round(intervalMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
