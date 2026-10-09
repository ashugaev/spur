import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "@/components/ThemeToggle";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/lib/theme-context";

const originalMatchMedia = window.matchMedia;

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    window.matchMedia = ((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? false : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function openMenu() {
    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    const trigger = screen.getByRole("button", { name: "Theme" });
    fireEvent.click(trigger);
    return trigger;
  }

  it("opens without changing the theme and starts with Auto selected", () => {
    const trigger = openMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Auto theme" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "false");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("keeps the menu open and exactly one mode selected across picks", () => {
    const trigger = openMenu();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("checkbox", { name: "Auto theme" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "false");
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto theme" }));
    expect(screen.getByRole("checkbox", { name: "Auto theme" })).toBeChecked();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("unchecking Auto pins the resolved color without a visual change", () => {
    openMenu();
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto theme" }));
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("Escape closes and restores trigger focus", () => {
    const trigger = openMenu();
    screen.getByRole("checkbox", { name: "Auto theme" }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
