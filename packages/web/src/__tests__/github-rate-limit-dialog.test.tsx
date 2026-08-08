import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GithubRateLimitDialog } from "@/components/GithubRateLimitDialog";
import type { GithubPrCheckUnavailablePayload } from "@/lib/types";

function payload(
  overrides: Partial<GithubPrCheckUnavailablePayload> = {},
): GithubPrCheckUnavailablePayload {
  return {
    code: "github_pr_check_unavailable",
    sessionId: "api-1",
    rateLimited: true,
    pr: {
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    },
    ...overrides,
  };
}

describe("GithubRateLimitDialog", () => {
  it("renders the linked pull request URL when present", () => {
    render(
      <GithubRateLimitDialog
        payload={payload()}
        onSkip={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://github.com/acme/api/pull/42");
  });

  it("renders gracefully without a pull request URL", () => {
    render(
      <GithubRateLimitDialog
        payload={payload({ pr: null })}
        onSkip={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("No linked pull request URL is available.")).toBeInTheDocument();
  });

  it("shows Retry PR Check only when rate limited", () => {
    const { rerender } = render(
      <GithubRateLimitDialog
        payload={payload({ rateLimited: false })}
        onSkip={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Retry PR Check" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip PR Check & Proceed" })).toBeInTheDocument();

    rerender(
      <GithubRateLimitDialog
        payload={payload({ rateLimited: true })}
        onSkip={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry PR Check" })).toBeInTheDocument();
  });

  it("fires the matching callback for each action", () => {
    const onSkip = vi.fn();
    const onRetry = vi.fn();
    const onCancel = vi.fn();

    render(
      <GithubRateLimitDialog
        payload={payload()}
        onSkip={onSkip}
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip PR Check & Proceed" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry PR Check" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("dismisses via the icon close button", () => {
    const onCancel = vi.fn();

    render(
      <GithubRateLimitDialog
        payload={payload()}
        onSkip={vi.fn()}
        onRetry={vi.fn()}
        onCancel={onCancel}
      />,
    );

    const dismiss = screen.getByRole("button", { name: "Dismiss GitHub PR check dialog" });
    expect(dismiss.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(dismiss);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("orders buttons neutral retry, danger skip, then cancel", () => {
    render(
      <GithubRateLimitDialog
        payload={payload()}
        onSkip={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((label): label is string =>
        ["Retry PR Check", "Skip PR Check & Proceed", "Cancel"].includes(label ?? ""),
      );

    expect(labels).toEqual(["Retry PR Check", "Skip PR Check & Proceed", "Cancel"]);
  });

  it("disables actions while busy", () => {
    const onSkip = vi.fn();

    render(
      <GithubRateLimitDialog
        payload={payload()}
        busy
        onSkip={onSkip}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const skip = screen.getByRole("button", { name: "Skip PR Check & Proceed" });
    expect(skip).toBeDisabled();
    fireEvent.click(skip);
    expect(onSkip).not.toHaveBeenCalled();
  });
});
