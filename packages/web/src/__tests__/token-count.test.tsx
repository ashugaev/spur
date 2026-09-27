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
  it("rounds the count to integer K and preserves footer precision", () => {
    render(
      <TokenCount
        sidebar
        session={{
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
    render(<TokenCount session={{ tokenUsageView }} />);
    const count = screen.getByLabelText("Tokens: unavailable");
    expect(count).toHaveTextContent("—");
    fireEvent.focus(count);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows isolated totals on hover and keyboard focus, omits unreported rows", () => {
    render(
      <TokenCount
        session={{
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
      expect(screen.getByText("Unavailable · pre-flight usage unknown")).toBeInTheDocument();
  });
});
