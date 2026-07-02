import type { SpurSessionState } from "@/lib/types";

export type TerminalWsStatus = "connecting" | "connected" | "reconnecting" | "error";

export interface ResolvedTerminalStatus {
  activity: SpurSessionState | null | undefined;
  colorVar: string;
  pulse: boolean;
  title: string;
  wsStatus: TerminalWsStatus;
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

  switch (activity) {
    case "working":
      return {
        activity,
        colorVar: "var(--color-status-working)",
        pulse: true,
        title: "working",
        wsStatus,
      };
    case "waiting":
      return {
        activity,
        colorVar: "var(--color-status-attention)",
        pulse: false,
        title: "waiting",
        wsStatus,
      };
    case "needs_input":
      return {
        activity,
        colorVar: "var(--color-status-error)",
        pulse: false,
        title: "needs input",
        wsStatus,
      };
    case "rate_limited":
      return {
        activity,
        colorVar: "var(--color-status-attention)",
        pulse: false,
        title: "rate limited",
        wsStatus,
      };
    case "error":
      return {
        activity,
        colorVar: "var(--color-status-error)",
        pulse: false,
        title: "error",
        wsStatus,
      };
    case "stopped":
      return {
        activity,
        colorVar: "var(--color-text-tertiary)",
        pulse: false,
        title: "stopped",
        wsStatus,
      };
    case "killed":
      return {
        activity,
        colorVar: "var(--color-text-tertiary)",
        pulse: false,
        title: "killed",
        wsStatus,
      };
    default:
      return {
        activity,
        colorVar: "var(--color-status-ready)",
        pulse: false,
        title: "connected",
        wsStatus,
      };
  }
}
