import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const V2_DIR = resolve(HERE, "../..");

describe("npm package update helper", () => {
  it("ships the extended daemon readiness window", () => {
    const pkg = JSON.parse(readFileSync(resolve(V2_DIR, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(pkg.files).toContain("scripts/npm-init.sh");

    const helper = readFileSync(resolve(V2_DIR, "scripts/npm-init.sh"), "utf8");
    expect(helper).toContain("for _ in $(seq 1 60); do");
    expect(helper).not.toContain("for _ in $(seq 1 10); do");
  });
});
