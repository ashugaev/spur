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

  it("bounds the stack while keeping toast bodies and controls independently interactive", () => {
    const { container } = render(
      <ToastViewport
        onDismiss={vi.fn()}
        toasts={Array.from({ length: 5 }, (_, index) => ({
          id: index,
          tone: "error",
          title: `Failure ${index}`,
          detail: "Long failure detail",
        }))}
      />,
    );

    const viewport = container.firstElementChild;

    expect(viewport).toHaveClass("pointer-events-none");
    expect(viewport).toHaveClass("overflow-hidden");
    expect(viewport).toHaveStyle({ maxHeight: "calc(100dvh - 2rem)" });
    expect(screen.getAllByRole("alert")).toHaveLength(5);
    expect(screen.getAllByRole("alert")[0]).toHaveClass("pointer-events-auto");
    expect(screen.getAllByRole("alert")[0]).toHaveStyle({
      maxHeight: "min(32rem, calc(20dvh - 0.8rem))",
    });
    expect(container.querySelectorAll("[data-toast-scroll]")).toHaveLength(5);
    expect(screen.getAllByRole("button", { name: "Dismiss toast" })).toHaveLength(5);
  });
});
