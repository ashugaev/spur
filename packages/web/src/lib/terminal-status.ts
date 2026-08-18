import type { SpurSessionState } from "@/lib/types";

export type TerminalWsStatus = "connecting" | "connected" | "reconnecting" | "error";

export interface ResolvedTerminalStatus {
  activity: SpurSessionState | null | undefined;
  colorVar: string;
  pulse: boolean;
  title: string;
  wsStatus: TerminalWsStatus;
}

/** Per-activity `{ colorVar, pulse, title }`, shared by the terminal status dot and the tab favicon. */
export function resolveActivityStatus(
  activity: SpurSessionState | null | undefined,
): Pick<ResolvedTerminalStatus, "colorVar" | "pulse" | "title"> {
  switch (activity) {
    case "working":
      return { colorVar: "var(--color-status-working)", pulse: true, title: "working" };
    case "waiting":
      return { colorVar: "var(--color-status-attention)", pulse: false, title: "waiting" };
    case "needs_input":
      return { colorVar: "var(--color-status-error)", pulse: false, title: "needs input" };
    case "rate_limited":
      return { colorVar: "var(--color-status-attention)", pulse: false, title: "rate limited" };
    case "stale":
      return { colorVar: "var(--color-text-tertiary)", pulse: false, title: "stale" };
    case "error":
      return { colorVar: "var(--color-status-error)", pulse: false, title: "error" };
    case "stopped":
      return { colorVar: "var(--color-text-tertiary)", pulse: false, title: "stopped" };
    case "killed":
      return { colorVar: "var(--color-text-tertiary)", pulse: false, title: "killed" };
    default:
      return { colorVar: "var(--color-status-ready)", pulse: false, title: "connected" };
  }
}

export function resolveTerminalStatus(
  wsStatus: TerminalWsStatus,
  activity: SpurSessionState | null | undefined,
  error: string | null,
): ResolvedTerminalStatus {
  if (wsStatus === "connecting") {
    return {
      activity,
      colorVar: "var(--color-status-attention)",
      pulse: true,
      title: "Connecting…",
      wsStatus,
    };
  }

  if (wsStatus === "reconnecting") {
    return {
      activity,
      colorVar: "var(--color-status-attention)",
      pulse: true,
      title: error ?? "Reconnecting…",
      wsStatus,
    };
  }

  if (wsStatus === "error") {
    return {
      activity,
      colorVar: "var(--color-status-error)",
      pulse: false,
      title: error ?? "Error",
      wsStatus,
    };
  }

  return { activity, wsStatus, ...resolveActivityStatus(activity) };
}
