import { render, screen } from "@testing-library/react";
import { BusyContent } from "@/components/BusyContent";
import { CenteredLoader } from "@/components/CenteredLoader";
import { LoadingBar } from "@/components/LoadingBar";
import { Skeleton } from "@/components/Skeleton";

describe("loading feedback", () => {
  it("reserves idle content while showing only a spinner when busy", () => {
    render(
      <button aria-busy="true" aria-label="Saving" type="button">
        <BusyContent busy>Save changes</BusyContent>
      </button>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button.querySelector("[data-busy-content='true'] .voice-spinner")).not.toBeNull();
    expect(screen.getByText("Save changes")).toHaveClass("invisible");
    expect(screen.getByText("Save changes")).toHaveAttribute("aria-hidden", "true");
  });

  it("names route and row loading without visible text", () => {
    render(
      <>
        <LoadingBar label="Loading dashboard" />
        <Skeleton className="h-4 w-24" label="Loading models" />
        <CenteredLoader label="Loading session" />
      </>,
    );

    expect(screen.getByRole("status", { name: "Loading dashboard" })).toHaveClass("loader-bar");
    expect(screen.getByRole("status", { name: "Loading models" })).toHaveClass("loader-skeleton");
    expect(screen.getByRole("status", { name: "Loading session" })).toHaveClass(
      "items-center",
      "justify-center",
    );
    expect(
      screen.getByRole("status", { name: "Loading session" }).querySelector(
        ".loader-centered-mark",
      ),
    ).not.toBeNull();
  });
});
