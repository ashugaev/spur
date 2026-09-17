import { test, expect, makeWorkingSession, gotoMocked } from "./fixtures.js";

test.describe("unmocked /api requests", () => {
  test("an /api request no spec mocked is recorded and aborted", async ({
    page,
    unmockedApiRequests,
  }) => {
    // page.goto resolves on `load`, but the dashboard's own /api fetches fire
    // after hydration. Awaiting the request is what makes this case
    // deterministic: without it the recorder can still be empty when the
    // assertion runs and the case passes for the wrong reason.
    await page.goto("/");
    await expect.poll(() => unmockedApiRequests.length).toBeGreaterThan(0);
    // This case asserts on the record itself, so it consumes it: the teardown
    // throw that fails every OTHER spec must not also fail this one.
    unmockedApiRequests.length = 0;
  });

  test("a spec's own route still wins over the catch-all", async ({ page }) => {
    await gotoMocked(page, "/", [makeWorkingSession({ id: "sp-1", prompt: "Catch-all override" })]);
    await expect(page.getByText("Catch-all override")).toBeVisible();
  });
});
