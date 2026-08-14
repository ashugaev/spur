import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "@/components/ThemeToggle";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/lib/theme-context";

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    stubMatchMedia(false);
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    window.matchMedia = originalMatchMedia;
  });

  it("reflects the dark theme by default: aria-pressed false, label offers switch to light", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const button = screen.getByRole("button", { name: "Switch to light theme" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Switch to light theme");
  });

  it("clicking flips theme, writes localStorage, toggles data-theme, and swaps the label", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));

    const button = screen.getByRole("button", { name: "Switch to dark theme" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "Switch to light theme" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("rotates the mark toward light theme when motion is not reduced", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));

    const svg = screen.getByRole("button", { name: "Switch to dark theme" }).querySelector("svg");
    expect(svg).toHaveClass("rotate-180");
    expect(svg).toHaveClass("transition-transform");
  });

  it("omits the rotate/transition classes when prefers-reduced-motion is set", () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));

    const svg = screen.getByRole("button", { name: "Switch to dark theme" }).querySelector("svg");
    expect(svg).not.toHaveClass("rotate-180");
    expect(svg).not.toHaveClass("transition-transform");
  });
});
