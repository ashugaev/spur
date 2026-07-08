import { describe, expect, it } from "vitest";
import { collectHostInstallChecks } from "../../src/host-install.js";

describe("collectHostInstallChecks", () => {
  it("returns npm-prefix and systemd checks for a fake home", () => {
    const checks = collectHostInstallChecks("/tmp/spur-host-install-test");
    const ids = checks.map((check) => check.id);
    expect(ids).toContain("npm-prefix");
    expect(ids).toContain("systemd-units");
    expect(ids).toContain("linger");
    expect(checks.find((check) => check.id === "systemd-units")?.ok).toBe(false);
  });
});
