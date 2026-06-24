import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@/components/Toast.js";

describe("ToastViewport", () => {
  it("keeps live regions mounted before toasts exist", () => {
    render(<ToastViewport onDismiss={vi.fn()} toasts={[]} />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("announces toast text through shared live regions", () => {
    render(
      <ToastViewport
        onDismiss={vi.fn()}
        toasts={[
          { id: 1, tone: "success", title: "Saved" },
          { id: 2, tone: "error", title: "Failed", detail: "Retry later" },
        ]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Retry later");
    expect(screen.getAllByRole("button", { name: "Dismiss toast" })).toHaveLength(2);
  });
});
