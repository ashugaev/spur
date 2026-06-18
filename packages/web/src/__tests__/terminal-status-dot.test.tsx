import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminalStatusDot } from "@/components/TerminalStatusDot";

describe("TerminalStatusDot", () => {
  it("renders the connecting state with a pulse", () => {
    render(<TerminalStatusDot wsStatus="connecting" />);
    const dot = screen.getByTestId("direct-terminal-header-status-dot");
    expect(dot).toHaveAttribute("data-ws-status", "connecting");
    expect(dot).toHaveAttribute("title", "Connecting…");
    expect(dot.className).toContain("dot-pulse");
  });

  it("renders the reconnecting state with the error title when provided", () => {
    render(<TerminalStatusDot wsStatus="reconnecting" error="network down" />);
    const dot = screen.getByTestId("direct-terminal-header-status-dot");
    expect(dot).toHaveAttribute("data-ws-status", "reconnecting");
    expect(dot).toHaveAttribute("title", "network down");
  });

  it("renders the error state without pulsing", () => {
    render(<TerminalStatusDot wsStatus="error" error="boom" />);
    const dot = screen.getByTestId("direct-terminal-header-status-dot");
    expect(dot).toHaveAttribute("title", "boom");
    expect(dot.className).not.toContain("dot-pulse");
  });

  it("renders the connected state with 'connected' title by default", () => {
    render(<TerminalStatusDot wsStatus="connected" />);
    expect(screen.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
      "title",
      "connected",
    );
  });
});
