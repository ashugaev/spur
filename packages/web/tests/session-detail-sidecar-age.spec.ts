import { test, expect, type Page } from "playwright/test";
import { makeWorkingSession, mockTagCatalog } from "./fixtures.js";

function mockSessionDetail(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  return Promise.all([
    mockTagCatalog(page),
    page.route(`**/api/sessions/${session.id}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    }),
  ]);
}

// AC11: session detail renders the sidecar age token when ageSeconds is
// present, and leaves the row unchanged (no token, no layout change) when it
// is absent.
test.describe("AC11: sidecar age token", () => {
  test("renders the age token for a sidecar with a recorded identity", async ({ page }) => {
    const session = makeWorkingSession({
      id: "sc-age-1",
      sidecars: [
        {
          name: "front-local",
          alive: true,
          ports: [{ id: "http", env: "SPUR_RESERVED_PORT_FRONT_LOCAL", port: 3002 }],
          ageSeconds: 46800, // 13h
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection).toBeVisible();
    await expect(sidecarSection.getByText(":3002")).toBeVisible();
    const ageToken = sidecarSection.getByTestId("sidecar-age-front-local");
    await expect(ageToken).toBeVisible();
    await expect(ageToken).toHaveText("13h");
  });

  test("renders no age token, and leaves the row otherwise unchanged, when ageSeconds is absent", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "sc-age-2",
      sidecars: [
        {
          name: "front-local",
          alive: true,
          ports: [{ id: "http", env: "SPUR_RESERVED_PORT_FRONT_LOCAL", port: 3002 }],
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const sidecarSection = page.locator("section").filter({ hasText: "Sidecars" });
    await expect(sidecarSection).toBeVisible();
    await expect(sidecarSection.getByText("front-local")).toBeVisible();
    await expect(sidecarSection.getByText(":3002")).toBeVisible();
    await expect(sidecarSection.getByTestId("sidecar-age-front-local")).toHaveCount(0);
  });
});
