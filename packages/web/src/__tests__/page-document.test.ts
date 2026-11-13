// @vitest-environment node
import { describe, expect, it } from "vitest";
import { augmentPageDocument } from "@/lib/page-document";

describe("Page document augmentation", () => {
  it("replaces platform metadata structurally and leaves script strings and relative assets intact", () => {
    const html = augmentPageDocument(
      '<!doctype html><title>Old</title><link rel="icon" href="old.ico"><script>const text="<head><title>safe</title>";</script><img src="./asset.png">',
      { id: "one", title: '<New & "page">', url: "/p/one/" },
    );
    expect(html).toContain('<title>&lt;New &amp; "page"&gt;</title>');
    expect(html).toContain('const text="<head><title>safe</title>";');
    expect(html).toContain('src="./asset.png"');
    expect(html).not.toContain("old.ico");
    expect(html).toContain("/p/one/_spur/sdk.js");
    expect(html.indexOf("/p/one/_spur/sdk.js")).toBeLessThan(html.indexOf("const text="));
    expect(html).not.toContain("<base");
  });
  it("is idempotent and repairs missing document/head tags", () => {
    const page = { id: "one", title: "One", url: "/p/one/" };
    const once = augmentPageDocument("<p>Content</p>", page);
    expect(augmentPageDocument(once, page)).toBe(once);
    expect(once).toContain('<link rel="manifest" href="/p/one/_spur/manifest.webmanifest">');
  });
});
