import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@/components/Toast.js";

describe("ToastViewport", () => {
  it("keeps live regions mounted before toasts exist", () => {
    const { container } = render(<ToastViewport onDismiss={vi.fn()} toasts={[]} />);

    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-live="assertive"]')).toBeInTheDocument();
  });

  it("announces toast text through shared live regions", () => {
    const { container } = render(
      <ToastViewport
        onDismiss={vi.fn()}
        toasts={[
          { id: 1, tone: "success", title: "Saved" },
          { id: 2, tone: "error", title: "Failed", detail: "Retry later" },
        ]}
      />,
    );

    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("Saved");
    expect(container.querySelector('[aria-live="assertive"]')).toHaveTextContent("Failed");
    expect(container.querySelector('[aria-live="assertive"]')).toHaveTextContent("Retry later");
    expect(screen.getAllByRole("button", { name: "Dismiss toast" })).toHaveLength(2);
  });
});
