import { test, expect, mockSessions } from "./fixtures.js";

for (const width of [1280, 390]) {
  test(`project menu opens Pages and returns to Agents at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockSessions(page, [], [{ id: "films-project", name: "Films Project" }]);
    await page.route("**/api/pages", (route) =>
      route.fulfill({ json: { pages: [{ id: "films", title: "My films", url: "/p/films/" }] } }),
    );
    await context.route("**/p/films/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>My films</h1>" }),
    );
    await page.goto("/?project=films-project");
    await page.getByRole("button", { name: "Project filter: Films Project" }).click();
    const entry = page.getByRole("menuitem", { name: "Pages", exact: true });
    await expect(entry).toHaveAttribute("href", "/pages?project=films-project");
    await entry.focus();
    await entry.press("Enter");
    await expect(page).toHaveURL(/\/pages\?project=films-project$/);
    const title = page.getByRole("link", { name: "My films", exact: true });
    await expect(title).toHaveAttribute("target", "_blank");
    await expect(title).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByRole("button", { name: "Create Page" })).toBeVisible();
    const popupPromise = page.waitForEvent("popup");
    await title.click();
    const popup = await popupPromise;
    await expect(popup.getByRole("heading", { name: "My films" })).toBeVisible();
    await popup.close();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(/\/\?project=films-project$/);
    await expect(page.getByRole("button", { name: "Project filter: Films Project" })).toBeVisible();
  });
}

for (const width of [1280, 390]) {
  test(`creates a Page and opens one editable robot chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockSessions(page, []);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () =>
            Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
        },
      });
    });
    await page.route("**/api/runtime/voice", (route) =>
      route.fulfill({ json: { available: true, language: "auto" } }),
    );
    let creates = 0;
    let sends = 0;
    let releaseCreate!: () => void;
    const pendingCreate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await page.route("**/api/pages", async (route) => {
      if (route.request().method() === "POST") {
        creates++;
        await pendingCreate;
        return route.fulfill({
          status: 201,
          json: { id: "new", title: "New page", url: "/p/new/" },
        });
      }
      return route.fulfill({ json: { pages: [] } });
    });
    await page.route("**/p/new/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/_spur/events"))
        return route.fulfill({ contentType: "text/event-stream", body: "" });
      if (path.endsWith("/_spur/agent/send")) {
        sends++;
        return route.fulfill({ json: { sessionId: "pg-new-test" } });
      }
      if (path.includes("/_spur/")) return route.fulfill({ json: {} });
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><title>New page</title><h1>New page</h1><p>Your page starts here.</p><script src="/spur/spur-sdk.v2.js"></script>',
      });
    });
    await page.goto("/pages");
    await page.evaluate(() => document.fonts.ready);
    const create = page.getByRole("button", { name: "Create Page", exact: true });
    const createWidth = (await create.boundingBox())!.width;
    await create.click();
    await expect(create).toBeDisabled();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(create.locator(".voice-spinner")).toBeVisible();
    expect((await create.boundingBox())!.width).toBe(createWidth);
    expect(creates).toBe(1);
    releaseCreate();
    await expect(page.getByRole("heading", { name: "New page" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    expect(creates).toBe(1);
    await expect(page).toHaveURL(/\/p\/new\/$/);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    const panelBounds = await page.getByRole("region", { name: "Page agent chat" }).boundingBox();
    expect(panelBounds).not.toBeNull();
    const inset = width < 640 ? 16 : 24;
    expect(Math.abs(width - panelBounds!.x - panelBounds!.width - inset)).toBeLessThan(1);
    if (width < 640) expect(Math.abs(panelBounds!.x - inset)).toBeLessThan(1);
    const font = await draft.evaluate((node) => ({
      family: getComputedStyle(node).fontFamily,
      size: getComputedStyle(node).fontSize,
    }));
    expect(font.family).toContain("monospace");
    expect(font.size).toBe("12px");
    await draft.fill("Build a reading list\nwith tags");
    const voice = page.frameLocator('iframe[title="Voice input"]');
    await voice.getByRole("button", { name: "Start voice recording" }).click();
    await expect(voice.getByRole("alert")).toContainText("Microphone access is blocked");
    const sendBounds = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
    expect(sendBounds!.height).toBeLessThanOrEqual(36);
    await expect(draft).toHaveValue("Build a reading list\nwith tags");
    // Synthetic retained-document lifecycle; routed fixtures do not prove BFCache eligibility.
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
      );
      await expect(page.locator('iframe[title="Voice input"]')).toHaveCount(0);
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
      );
      await expect(voice.getByRole("button", { name: "Start voice recording" })).toBeVisible();
      await expect(draft).toHaveValue("Build a reading list\nwith tags");
      expect(sends).toBe(0);
    }
    await page.getByRole("button", { name: "Close agent chat", exact: true }).first().click();
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator('iframe[title="Voice input"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Open agent chat", exact: true }).click();
    await expect(draft).toHaveValue("Build a reading list\nwith tags");
    expect(sends).toBe(0);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(draft).toHaveValue("");
    expect(sends).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("Pages request failure retries to a compact empty catalogue", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/pages", (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fulfill({ json: { pages: [] } });
  });
  await page.goto("/pages");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Could not load pages (503).",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No pages yet.", { exact: true })).toBeVisible();
});

test("Pages keeps loading distinct from an empty list", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/pages", async (route) => {
    await pending;
    await route.fulfill({ json: { pages: [] } });
  });
  await page.goto("/pages");
  await expect(page.getByRole("status", { name: "Loading pages" })).toBeVisible();
  await expect(page.getByText("No pages yet.")).toHaveCount(0);
  release();
  await expect(page.getByText("No pages yet.")).toBeVisible();
});
