import { describe, expect, it } from "vitest";
import { getDashboardUrl } from "../tailscale.js";

describe("getDashboardUrl", () => {
  it("trims explicit host", async () => {
    await expect(getDashboardUrl(3000, "  my-host.local  ")).resolves.toBe(
      "http://my-host.local:3000",
    );
  });

  it("wraps explicit IPv6 host in brackets", async () => {
    await expect(getDashboardUrl(3000, "fd7a:115c:a1e0::2")).resolves.toBe(
      "http://[fd7a:115c:a1e0::2]:3000",
    );
  });

  it("keeps bracketed IPv6 host unchanged", async () => {
    await expect(getDashboardUrl(3000, "[fd7a:115c:a1e0::2]")).resolves.toBe(
      "http://[fd7a:115c:a1e0::2]:3000",
    );
  });
});
