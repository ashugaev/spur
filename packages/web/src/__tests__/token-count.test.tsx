import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TokenCount } from "@/components/TokenCount";
import type { SpurSessionView } from "@/lib/types";

afterEach(cleanup);
const usage: SpurSessionView["tokenUsageView"] = {
  status: "available",
  provider: "codex",
  inputTokens: 700,
  outputTokens: 100,
  totalTokens: 800,
  cacheReadInputTokens: 0,
  exhausted: false,
};

describe("TokenCount", () => {
  it("shows known usage without an enforcement warning when no budget is configured", () => {
    render(
      <TokenCount
        session={{
          status: "running",
          tokenUsageView: usage,
          tokenBudgetView: {
            knownTotalTokens: 800,
            exhausted: false,
            enforced: false,
            reason: "legacy_unknown",
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: 800");
    expect(count).toHaveTextContent(/^800$/);
    expect(count).toHaveAttribute("style", "color: var(--color-text-secondary);");
    fireEvent.focus(count);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Budget not enforced");
  });

  it("keeps zero unknown usage diagnostics without an enforcement warning or budget", () => {
    render(
      <TokenCount
        session={{
          status: "running",
          tokenBudgetView: {
            knownTotalTokens: 0,
            exhausted: false,
            enforced: false,
            reason: "preflight_unknown",
          },
          preflightTokenUsageView: {
            status: "unknown",
            attemptCount: 1,
            unknownAttemptCount: 1,
            providerIterationCount: 0,
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: unavailable");
    expect(count).toHaveTextContent("—");
    expect(count).toHaveAttribute("style", "color: var(--color-text-tertiary);");
    expect(count).toHaveAttribute("tabindex", "0");
    fireEvent.focus(count);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pre-flight statusunknown");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Budget not enforced");
  });

  it("keeps unknown pre-flight diagnostics available without a measured total", () => {
    render(
      <TokenCount
        session={{
          status: "running",
          preflightTokenUsageView: {
            status: "unknown",
            attemptCount: 2,
            unknownAttemptCount: 2,
            providerIterationCount: 0,
          },
        }}
      />,
    );
    expect(screen.getByLabelText("Tokens: unavailable")).toHaveAttribute("tabindex", "0");
    fireEvent.focus(screen.getByLabelText("Tokens: unavailable"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pre-flight statusunknown");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown attempts").closest("div")).toHaveTextContent("2");
  });
  it("distinguishes an ignored limit from unknown accounting", () => {
    render(
      <TokenCount
        sidebar
        session={{
          status: "running",
          tokenUsageView: usage,
          tokenBudgetView: {
            budget: 1000,
            knownTotalTokens: 800,
            exhausted: false,
            enforced: false,
            overridden: true,
            reason: "preflight_unknown",
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: at least 800");
    expect(count).toHaveTextContent("≥800 / 1K");
    fireEvent.focus(count);
    expect(screen.getByText("800 of 1K · 80% · limit ignored")).toBeInTheDocument();
    expect(screen.queryByText(/Budget not enforced ·/)).not.toBeInTheDocument();
  });
  it("rounds the count to integer K and preserves footer precision", () => {
    render(
      <TokenCount
        sidebar
        session={{
          status: "running",
          tokenUsageView: { ...usage, totalTokens: 184200 },
          tokenBudgetView: {
            budget: 500000,
            knownTotalTokens: 184200,
            exhausted: false,
            enforced: true,
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: 184,200");
    expect(count).toHaveTextContent("184K / 500K");
    fireEvent.focus(count);
    expect(screen.getByText("184.2K of 500K · 37%")).toBeInTheDocument();
  });
  it.each([
    [999499, "999K"],
    [999500, "1M"],
    [999999, "1M"],
    [1000000, "1M"],
    [1200000, "1.2M"],
  ])("formats the million boundary %i as %s", (totalTokens, expected) => {
    render(
      <TokenCount
        sidebar
        session={{
          status: "running",
          tokenUsageView: { ...usage, totalTokens },
          tokenBudgetView: {
            budget: totalTokens,
            knownTotalTokens: totalTokens,
            exhausted: false,
            enforced: true,
          },
        }}
      />,
    );
    expect(screen.getByLabelText(`Tokens: ${totalTokens.toLocaleString()}`)).toHaveTextContent(
      `${expected} / ${expected}`,
    );
  });

  it.each([
    ["running", "Token budget reached"],
    ["stopped", "Token budget reached"],
    ["budget_limited", "Stopped by token budget"],
  ] as const)("reports lifecycle truth for %s", (status, footer) => {
    render(
      <TokenCount
        session={{
          status,
          tokenUsageView: { ...usage, exhausted: true },
          tokenBudgetView: { knownTotalTokens: 800, exhausted: true, enforced: true },
        }}
      />,
    );
    fireEvent.focus(screen.getByLabelText("Tokens: 800"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(footer);
    if (footer === "Token budget reached")
      expect(screen.getByRole("tooltip")).not.toHaveTextContent("Stopped by token budget");
  });

  it.each([false, true])("uses combined exhaustion unless overridden=%s", (overridden) => {
    render(
      <TokenCount
        session={{
          status: "running",
          tokenUsageView: { ...usage, exhausted: true },
          tokenBudgetView: {
            budget: 1000,
            knownTotalTokens: 800,
            exhausted: !overridden,
            enforced: !overridden,
            overridden,
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: 800");
    expect(count).toHaveAttribute(
      "style",
      `color: var(--color-${overridden ? "status-attention" : "status-error"});`,
    );
    expect(count.classList.contains("font-bold")).toBe(!overridden);
    fireEvent.focus(count);
    expect(
      screen.getByText(overridden ? "800 of 1K · 80% · limit ignored" : "Token budget reached"),
    ).toBeInTheDocument();
  });

  it.each([
    undefined,
    { status: "waiting", provider: "codex", exhausted: false } as const,
    {
      status: "unavailable",
      provider: "cursor",
      reason: "structured_usage_unavailable",
      exhausted: false,
      unenforced: false,
    } as const,
  ])("renders missing usage without a card %#", (tokenUsageView) => {
    render(<TokenCount session={{ status: "running", tokenUsageView }} />);
    const count = screen.getByLabelText("Tokens: unavailable");
    expect(count).toHaveTextContent("—");
    expect(count).not.toHaveAttribute("tabindex");
    fireEvent.focus(count);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows isolated totals on hover and keyboard focus, omits unreported rows", () => {
    render(
      <TokenCount
        session={{
          status: "running",
          tokenUsageView: usage,
          preflightTokenUsageView: {
            status: "measured",
            inputTokens: 150,
            outputTokens: 50,
            totalTokens: 200,
            attemptCount: 1,
            unknownAttemptCount: 0,
            providerIterationCount: 1,
            byProvider: {},
          },
          tokenBudgetView: { knownTotalTokens: 1000, exhausted: false, enforced: true },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: 1,000");
    expect(count).toHaveTextContent("1K");
    fireEvent.mouseEnter(count.parentElement!);
    expect(
      within(screen.getByRole("tooltip")).getByRole("row", { name: "Total 200 800" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Cache read ? 0" })).toBeInTheDocument();
    fireEvent.mouseLeave(count.parentElement!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(count);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.blur(count);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each([
    [799, false, true, "text-secondary"],
    [800, false, true, "status-attention"],
    [1000, true, true, "status-error"],
    [800, false, false, "chip-warn-text"],
  ])("colors budget total %i exhausted=%s enforced=%s", (total, exhausted, enforced, tone) => {
    render(
      <TokenCount
        sidebar
        session={{
          status: "budget_limited",
          tokenUsageView: { ...usage, totalTokens: total },
          tokenBudgetView: {
            budget: 1000,
            knownTotalTokens: total,
            exhausted,
            enforced,
            ...(!enforced ? { reason: "preflight_unknown" as const } : {}),
          },
        }}
      />,
    );
    const count = screen.getByLabelText(
      `Tokens: ${enforced ? "" : "at least "}${total.toLocaleString()}`,
    );
    expect(count).toHaveAttribute("style", `color: var(--color-${tone});`);
    expect(count).toHaveTextContent(" / 1K");
    fireEvent.focus(count);
    if (exhausted) expect(screen.getByText("Stopped by token budget")).toBeInTheDocument();
    if (!enforced)
      expect(
        screen.getByText("Budget not enforced · pre-flight usage unknown"),
      ).toBeInTheDocument();
  });

  it("overridden budget with exhausted main usage is not hit", () => {
    render(
      <TokenCount
        session={{
          status: "running",
          tokenUsageView: { ...usage, exhausted: true },
          tokenBudgetView: {
            budget: 100,
            knownTotalTokens: 110,
            exhausted: false,
            enforced: false,
            overridden: true,
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: 110");
    expect(count).toHaveAttribute("style", "color: var(--color-status-attention);");
    fireEvent.focus(count);
    expect(screen.queryByText("Stopped by token budget")).not.toBeInTheDocument();
    expect(screen.queryByText("Token budget reached")).not.toBeInTheDocument();
    expect(screen.getByText("110 of 100 · 110% · limit ignored")).toBeInTheDocument();
  });

  it("marks a warn-only exceeded budget red without reporting a stop", () => {
    render(
      <TokenCount
        session={{
          status: "running",
          tokenUsageView: { ...usage, exhausted: false },
          tokenBudgetView: {
            budget: 100,
            knownTotalTokens: 800,
            exhausted: true,
            enforced: true,
            warnOnly: true,
          },
        }}
      />,
    );
    const count = screen.getByLabelText("Tokens: 800");
    expect(count).toHaveAttribute("style", "color: var(--color-status-error);");
    expect(count).toHaveClass("font-bold");
    fireEvent.focus(count);
    expect(screen.getByText("Token budget reached")).toBeInTheDocument();
    expect(screen.queryByText("Stopped by token budget")).not.toBeInTheDocument();
  });

  it("absent tokenBudgetView wins over exhausted usage", () => {
    render(
      <TokenCount session={{ status: "running", tokenUsageView: { ...usage, exhausted: true } }} />,
    );
    const count = screen.getByLabelText("Tokens: unavailable");
    expect(count).toHaveTextContent("—");
  });

  it("left alignment anchors the card at left-0", () => {
    render(
      <TokenCount
        align="left"
        session={{
          status: "running",
          tokenUsageView: usage,
          tokenBudgetView: { knownTotalTokens: 800, exhausted: false, enforced: true },
        }}
      />,
    );
    fireEvent.focus(screen.getByLabelText("Tokens: 800"));
    const card = screen.getByRole("tooltip");
    expect(card.className).toContain("left-0");
    expect(card.className).not.toContain("right-0");
  });
});
