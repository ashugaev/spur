import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templates = [
  new URL("../../../deploy/spur-daemon.service", import.meta.url),
  new URL("../../deploy/spur-daemon.npm.service", import.meta.url),
];

describe("daemon unit memory guardrails", () => {
  it.each(templates)("bounds fleet memory in %s", (template) => {
    const unit = readFileSync(fileURLToPath(template), "utf8");
    expect(unit).toContain("MemoryHigh=75%");
    expect(unit).toContain("MemoryMax=85%");
    expect(unit).toContain("MemorySwapMax=2G");
  });
});
