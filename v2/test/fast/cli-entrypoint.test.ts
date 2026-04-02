import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { matchesCliEntrypoint } from "../../src/cli.js";

describe("cli entrypoint", () => {
  it("matches when argv[1] is a symlink to the real CLI path", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "spur-cli-entrypoint-"));
    const targetPath = join(fixtureDir, "cli.js");
    const symlinkPath = join(fixtureDir, "spur");

    writeFileSync(targetPath, "#!/usr/bin/env node\n");
    symlinkSync(targetPath, symlinkPath);

    expect(matchesCliEntrypoint(pathToFileURL(targetPath).href, symlinkPath)).toBe(true);
  });

  it("does not match an unrelated argv path", () => {
    expect(matchesCliEntrypoint(pathToFileURL("/tmp/real-cli.js").href, "/tmp/other-cli.js")).toBe(
      false,
    );
  });
});
