// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageManifest, renderPageIcon } from "@/lib/page-metadata";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const page = { id: "one", title: "One", url: "/p/one/" };
describe("Page install identity", () => {
  it("keeps installed pages distinct", () => {
    expect(pageManifest(page)).toMatchObject({
      id: "/p/one/",
      scope: "/p/one/",
      start_url: "/p/one/",
      name: "One",
      display: "standalone",
    });
    expect(pageManifest({ ...page, url: "/p/two/" }).id).not.toBe(pageManifest(page).id);
  });
  it("renders default and configured PNGs at actual requested dimensions", async () => {
    const original = Buffer.from(await (await renderPageIcon(page, 512)).arrayBuffer());
    expect(original.subarray(1, 4).toString()).toBe("PNG");
    expect(original.readUInt32BE(16)).toBe(512);
    vi.stubEnv("SPUR_DAEMON_URL", "http://isolated.test");
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(original, { headers: { "content-type": "image/png" } })),
      );
    vi.stubGlobal("fetch", fetch);
    for (const size of [32, 180, 192, 512] as const) {
      const png = Buffer.from(
        await (await renderPageIcon({ ...page, icon: "assets/icon.png" }, size)).arrayBuffer(),
      );
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    expect(fetch).toHaveBeenCalledWith(
      "http://isolated.test/pages/one/files/assets/icon.png",
      expect.anything(),
    );
  });
  it("rejects invalid explicitly configured icons", async () => {
    vi.stubEnv("SPUR_DAEMON_URL", "http://isolated.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad", { headers: { "content-type": "image/png" } })),
    );
    await expect(renderPageIcon({ ...page, icon: "icon.png" }, 32)).rejects.toThrow("Invalid PNG");
  });
  it("bounds icon bytes and rejects nonsquare raster dimensions", async () => {
    vi.stubEnv("SPUR_DAEMON_URL", "http://isolated.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(1024 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    await expect(renderPageIcon({ ...page, icon: "icon.png" }, 32)).rejects.toThrow(
      "exceeds 1 MiB",
    );
    const bad = Buffer.from(await (await renderPageIcon(page, 32)).arrayBuffer());
    bad.writeUInt32BE(64, 20);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(bad, { headers: { "content-type": "image/png" } })),
    );
    await expect(renderPageIcon({ ...page, icon: "icon.png" }, 32)).rejects.toThrow("square");
  });
});
