import { test, expect } from "playwright/test";

// P1: PWA manifest
test.describe("P1: PWA manifest", () => {
  test("GET /manifest.webmanifest returns 200", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
  });

  test("manifest has name = Spur", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest["name"]).toBe("Spur");
  });

  test("manifest has short_name", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = (await response.json()) as Record<string, unknown>;
    expect(typeof manifest["short_name"]).toBe("string");
    expect((manifest["short_name"] as string).length).toBeGreaterThan(0);
  });

  test("manifest has display = standalone", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest["display"]).toBe("standalone");
  });

  test("manifest has start_url = /", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest["start_url"]).toBe("/");
  });

  test("manifest icons array has 192 and 512 entries", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = (await response.json()) as Record<string, unknown>;
    const icons = manifest["icons"] as Array<{ sizes: string }>;
    expect(Array.isArray(icons)).toBe(true);
    const sizes = icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  test("manifest theme_color is dark", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = (await response.json()) as Record<string, unknown>;
    const themeColor = manifest["theme_color"] as string;
    expect(typeof themeColor).toBe("string");
    // Should be a dark color (e.g. #0D0D0E)
    expect(themeColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    // Verify it's actually dark by checking lightness — just check it starts with #0 or similar
    expect(themeColor.toLowerCase()).toBe("#0d0d0e");
  });
});
