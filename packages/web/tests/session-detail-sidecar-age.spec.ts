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

  // Distinguishable at a glance, not just present: a sidecar past the
  // backend's own sidecarGc.maxAgeWarnMinutes threshold (ageWarn) renders in
  // the same attention color the app already uses for warn/near-due states
  // (e.g. SessionDetail.tsx:1393, :2686, :3470); a fresh sidecar stays on the
  // neutral tertiary-text color.
  test("styles the age token with the attention color once the sidecar is past the age-warn threshold", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "sc-age-3",
      sidecars: [
        {
          name: "front-local",
          alive: true,
          ports: [{ id: "http", env: "SPUR_RESERVED_PORT_FRONT_LOCAL", port: 3002 }],
          ageSeconds: 46800, // 13h
          ageWarn: true,
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const ageToken = page
      .locator("section")
      .filter({ hasText: "Sidecars" })
      .getByTestId("sidecar-age-front-local");
    await expect(ageToken).toBeVisible();
    await expect(ageToken).toHaveClass(/color-status-attention/);
    await expect(ageToken).not.toHaveClass(/color-text-tertiary/);
  });

  test("keeps the age token on the neutral tertiary color while under the age-warn threshold", async ({
    page,
  }) => {
    const session = makeWorkingSession({
      id: "sc-age-4",
      sidecars: [
        {
          name: "front-local",
          alive: true,
          ports: [{ id: "http", env: "SPUR_RESERVED_PORT_FRONT_LOCAL", port: 3002 }],
          ageSeconds: 5, // 5s, well under any realistic threshold
        },
      ],
    });
    await mockSessionDetail(page, session);
    await page.goto(`/sessions/${session.id}`);

    const ageToken = page
      .locator("section")
      .filter({ hasText: "Sidecars" })
      .getByTestId("sidecar-age-front-local");
    await expect(ageToken).toBeVisible();
    await expect(ageToken).toHaveClass(/color-text-tertiary/);
    await expect(ageToken).not.toHaveClass(/color-status-attention/);
  });
});
