import {
  test, expect, mockSessions, mockTagCatalog, gotoMocked, makeWorkingSession,
  type ProjectInfo,
} from "./fixtures.js";

type FirstFrame = { dataTheme: string | null; colorScheme: string };

async function prepare(page: Parameters<typeof mockSessions>[0], stored: string | null, os: "light" | "dark") {
  await page.emulateMedia({ colorScheme: os });
  await page.addInitScript((value) => {
    if (value === null) localStorage.removeItem("spur:theme");
    else localStorage.setItem("spur:theme", value);
    const frames: FirstFrame[] = [];
    const capture = () => ({
      dataTheme: document.documentElement.getAttribute("data-theme"),
      colorScheme: document.documentElement.style.colorScheme,
    });
    const observer = new MutationObserver(() => { frames.push(capture()); });
    observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme", "style"] });
    requestAnimationFrame(() => {
      (window as typeof window & { firstThemeFrame?: FirstFrame; themeMutations?: FirstFrame[] }).firstThemeFrame = capture();
      (window as typeof window & { firstThemeFrame?: FirstFrame; themeMutations?: FirstFrame[] }).themeMutations = frames;
      observer.disconnect();
    });
  }, stored);
  await mockTagCatalog(page);
  await mockSessions(page, []);
  await page.goto("/");
}

for (const [stored, os, expected] of [
  [null, "light", "light"],
  ["auto", "dark", "dark"],
  ["light", "dark", "light"],
  ["dark", "light", "dark"],
] as const) {
  test(`first frame resolves ${stored ?? "absent/Auto"} with OS ${os} to ${expected}`, async ({ page }) => {
    await prepare(page, stored, os);
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { firstThemeFrame?: FirstFrame }).firstThemeFrame,
    )).toEqual({ dataTheme: expected === "light" ? "light" : null, colorScheme: expected });
    await expect(page.locator("html")).toHaveCSS("color-scheme", expected);
  });
}

test("Auto follows an OS change in an open tab; fixed mode ignores later changes", async ({ page }) => {
  await prepare(page, "auto", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.getByRole("button", { name: "Theme" }).click();
  await expect(page.getByRole("checkbox", { name: "Auto theme" })).toBeChecked();
  await page.getByRole("radio", { name: "Light" }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("stored Light and the project filter survive reload", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("spur:theme", "light"));
  await mockTagCatalog(page);
  const projects: ProjectInfo[] = [{ id: "test-project", name: "test-project" }];
  await gotoMocked(page, "/?project=test-project", [makeWorkingSession()], projects);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: /^Project filter:/ })).toHaveAccessibleName(
    "Project filter: test-project",
  );
});

for (const mode of ["auto", "light", "dark"] as const) {
  for (const os of ["light", "dark"] as const) {
    test(`${mode} menu with OS ${os} has one selection`, async ({ page }) => {
      await prepare(page, mode, os);
      await page.getByRole("button", { name: "Theme" }).click();
      const auto = page.getByRole("checkbox", { name: "Auto theme" });
      const light = page.getByRole("radio", { name: "Light" });
      const dark = page.getByRole("radio", { name: "Dark" });
      await expect(auto).toHaveJSProperty("checked", mode === "auto");
      await expect(light).toHaveAttribute("aria-checked", String(mode === "light"));
      await expect(dark).toHaveAttribute("aria-checked", String(mode === "dark"));
      await expect(page.locator("html")).toHaveCSS("color-scheme", mode === "auto" ? os : mode);
    });
  }
}

test("menu aligns labels and marks, fits a 320px viewport, and Escape restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await prepare(page, "light", "dark");
  const trigger = page.getByRole("button", { name: "Theme" });
  await trigger.click();
  const panel = page.getByRole("group", { name: "Theme" });
  const geometry = await panel.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const styles = getComputedStyle(node);
    const label = node.querySelector("div > span")?.getBoundingClientRect();
    const row = node.querySelector('[role="radio"] > span')?.getBoundingClientRect();
    const checkbox = node.querySelector("input")?.getBoundingClientRect();
    const mark = node.querySelector('[role="radio"] > span:nth-child(2)')?.getBoundingClientRect();
    if (!label || !row || !checkbox || !mark) throw new Error("Theme menu geometry targets missing");
    return { left: rect.left, right: rect.right, width: rect.width, padding: styles.paddingLeft,
      labelX: label.x, rowX: row.x, checkboxCenter: checkbox.x + checkbox.width / 2,
      markCenter: mark.x + mark.width / 2 };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(320);
  expect(geometry.width).toBeGreaterThanOrEqual(180);
  expect(geometry.padding).toBe("8px");
  expect(Math.abs(geometry.labelX - geometry.rowX)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.checkboxCenter - geometry.markCenter)).toBeLessThanOrEqual(1);
  await page.getByRole("checkbox", { name: "Auto theme" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("keyboard reaches Auto, Light, and Dark in order", async ({ page }) => {
  await prepare(page, "auto", "light");
  const trigger = page.getByRole("button", { name: "Theme" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox", { name: "Auto theme" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Light" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Dark" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
});
