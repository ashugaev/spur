import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpurProjectOptions } from "@/lib/spur-projects";

const originalCwd = process.cwd();
const originalSpurConfig = process.env["SPUR_CONFIG"];
const originalSpurConfigPath = process.env["SPUR_CONFIG_PATH"];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSpurConfig === undefined) {
    delete process.env["SPUR_CONFIG"];
  } else {
    process.env["SPUR_CONFIG"] = originalSpurConfig;
  }
  if (originalSpurConfigPath === undefined) {
    delete process.env["SPUR_CONFIG_PATH"];
  } else {
    process.env["SPUR_CONFIG_PATH"] = originalSpurConfigPath;
  }
});

describe("readSpurProjectOptions", () => {
  it("resolves a relative SPUR_CONFIG against the repo root when the web package changes cwd", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "spur-projects-"));
    const packageDir = join(rootDir, "packages", "web");
    try {
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(rootDir, "spur.yaml"),
        "projects:\n  sp:\n    name: Spur Core\n  lab:\n    name: Lab\n",
        "utf8",
      );

      process.chdir(packageDir);
      process.env["SPUR_CONFIG"] = "./spur.yaml";
      delete process.env["SPUR_CONFIG_PATH"];

      expect(readSpurProjectOptions()).toEqual([
        { id: "sp", name: "Spur Core" },
        { id: "lab", name: "Lab" },
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
