import { describe, expect, it } from "vitest";
import { resolveTerminalStatus } from "@/lib/terminal-status";

describe("resolveTerminalStatus", () => {
  it("maps websocket states with priority over activity", () => {
    expect(resolveTerminalStatus("connecting", "working", null)).toMatchObject({
      colorVar: "var(--color-status-attention)",
      pulse: true,
      title: "Connecting…",
    });
    expect(resolveTerminalStatus("reconnecting", "working", "Lost link")).toMatchObject({
      colorVar: "var(--color-status-attention)",
      pulse: true,
      title: "Lost link",
    });
    expect(resolveTerminalStatus("reconnecting", "working", null)).toMatchObject({
      title: "Reconnecting…",
    });
    expect(resolveTerminalStatus("error", "working", "Terminal disconnected")).toMatchObject({
      colorVar: "var(--color-status-error)",
      pulse: false,
      title: "Terminal disconnected",
    });
    expect(resolveTerminalStatus("error", "working", null)).toMatchObject({
      title: "Error",
    });
  });

  it("maps connected activity states", () => {
    expect(resolveTerminalStatus("connected", "working", null)).toMatchObject({
      colorVar: "var(--color-status-working)",
      pulse: true,
      title: "working",
    });
    expect(resolveTerminalStatus("connected", "waiting", null)).toMatchObject({
      colorVar: "var(--color-status-attention)",
      pulse: false,
      title: "waiting",
    });
    expect(resolveTerminalStatus("connected", "needs_input", null)).toMatchObject({
      colorVar: "var(--color-status-error)",
      pulse: false,
      title: "needs input",
    });
    expect(resolveTerminalStatus("connected", "error", null)).toMatchObject({
      colorVar: "var(--color-status-error)",
      pulse: false,
      title: "error",
    });
    expect(resolveTerminalStatus("connected", "stopped", null)).toMatchObject({
      colorVar: "var(--color-text-tertiary)",
      pulse: false,
      title: "stopped",
    });
    expect(resolveTerminalStatus("connected", "killed", null)).toMatchObject({
      colorVar: "var(--color-text-tertiary)",
      pulse: false,
      title: "killed",
    });
    expect(resolveTerminalStatus("connected", null, null)).toMatchObject({
      colorVar: "var(--color-status-ready)",
      pulse: false,
      title: "connected",
    });
    expect(resolveTerminalStatus("connected", undefined, null)).toMatchObject({
      colorVar: "var(--color-status-ready)",
      pulse: false,
      title: "connected",
    });
  });
});
