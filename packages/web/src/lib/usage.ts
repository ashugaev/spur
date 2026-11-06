import type { QuotaErrorKind, QuotaSourceResult, UsageReport } from "@/lib/types";

export type MeterTone = "normal" | "attention" | "error";
export type QuotaLevel = "ready" | "attention" | "error";

const ATTENTION_PERCENT = 75;
const ERROR_PERCENT = 90;

export async function fetchUsage(signal: AbortSignal): Promise<UsageReport> {
  const response = await fetch("/api/usage", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Usage request failed: ${response.status}`);
  return (await response.json()) as UsageReport;
}

export function meterTone(usedPercent: number): MeterTone {
  if (usedPercent >= ERROR_PERCENT) return "error";
  if (usedPercent >= ATTENTION_PERCENT) return "attention";
  return "normal";
}

export function formatResetIn(resetsAt: string | null, nowMs: number): string {
  if (resetsAt === null) return "no reset time";
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return "no reset time";
  const totalMinutes = Math.floor(Math.max(0, target - nowMs) / 60_000);
  if (totalMinutes < 1) return "<1m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function errorKindLabel(kind: QuotaErrorKind): string {
  return kind.replaceAll("_", " ");
}

export function errorKindTone(kind: QuotaErrorKind): "warn" | "error" {
  return kind === "rate_limited" || kind === "network_error" ? "warn" : "error";
}

export function quotaLevel(quotas: QuotaSourceResult[]): QuotaLevel {
  const failed = quotas.filter((quota) => quota.status === "error").length;
  if (failed === 0) return "ready";
  return failed === quotas.length ? "error" : "attention";
}
