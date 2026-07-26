import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession, mockSessions } from "./fixtures.js";

// Real daemon restart/update ~ a version change; a transient blip on the
// same daemon reports the same version back once recovered.
async function routeRuntimeInfo(page: Page, getState: () => { alive: boolean; version: string }) {
  await page.route("/api/runtime/info", (route) => {
    const state = getState();
    if (!state.alive) {
      void route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Bad gateway" }),
      });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: state.version }),
    });
  });
}

test.describe("D6e: Backend-connection gate", () => {
  test("shows a blocking, inert overlay when the backend drops, then reloads once it recovers on a different version", async ({
    page,
  }) => {
    await mockSessions(page, [makeWorkingSession()]);

    const state = { alive: true, version: "1.4.2" };
    await routeRuntimeInfo(page, () => state);

    await page.goto("/");
    const spawnButton = page.getByRole("button", { name: /spawn session/i });
    await expect(spawnButton).toBeVisible();
    await expect(page.getByTestId("backend-connection-overlay")).toHaveCount(0);
    await expect(page.locator("[inert]")).toHaveCount(0);

    state.alive = false;
    await expect(page.getByTestId("backend-connection-overlay")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Reconnecting to Spur…" })).toBeVisible();

    // The background app tree is marked inert while the overlay blocks it.
    await expect(page.locator("[inert]")).toHaveCount(1);

    let reloaded = false;
    await page.exposeFunction("__markReloaded", () => {
      reloaded = true;
    });
    await page.evaluate(() => {
      window.addEventListener("beforeunload", () => {
        (window as unknown as { __markReloaded: () => void }).__markReloaded();
      });
    });

    // Recovery on a different version simulates a real daemon restart/update.
    state.alive = true;
    state.version = "1.5.0";
    await expect.poll(() => reloaded, { timeout: 10_000 }).toBe(true);
  });

  test("recovers without reloading when the backend comes back on the same version", async ({
    page,
  }) => {
    await mockSessions(page, [makeWorkingSession()]);

    const state = { alive: true, version: "1.4.2" };
    await routeRuntimeInfo(page, () => state);

    await page.goto("/");
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();

    state.alive = false;
    await expect(page.getByTestId("backend-connection-overlay")).toBeVisible({ timeout: 10_000 });

    let reloaded = false;
    await page.exposeFunction("__markReloadedSameVersion", () => {
      reloaded = true;
    });
    await page.evaluate(() => {
      window.addEventListener("beforeunload", () => {
        (
          window as unknown as { __markReloadedSameVersion: () => void }
        ).__markReloadedSameVersion();
      });
    });

    // Same version as before the outage: a transient blip, not a real
    // restart — the overlay should clear without a reload.
    state.alive = true;
    await expect(page.getByTestId("backend-connection-overlay")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /spawn session/i })).toBeVisible();
    expect(reloaded).toBe(false);
  });
});
