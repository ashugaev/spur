import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeWorkspace, workspaceExists } from "../../src/workspace.js";

describe("workspaceExists", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("treats a symlink to a directory as an existing workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-workspace-exists-"));
    tempRoots.push(root);
    const target = join(root, "canonical");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias);

    expect(workspaceExists(alias)).toBe(true);
    expect(probeWorkspace(alias)).toEqual({ exists: true, missing: false });
  });

  it("reports missing when the symlink target does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-workspace-exists-"));
    tempRoots.push(root);
    const target = join(root, "missing-target");
    const alias = join(root, "broken-alias");
    await symlink(target, alias);

    expect(workspaceExists(alias)).toBe(false);
    expect(probeWorkspace(alias)).toEqual({ exists: false, missing: true });
  });

  it("reports missing for a plain file path", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-workspace-exists-"));
    tempRoots.push(root);
    const filePath = join(root, "file.txt");
    await writeFile(filePath, "x");

    expect(workspaceExists(filePath)).toBe(false);
    expect(probeWorkspace(filePath)).toEqual({ exists: false, missing: false });
  });
});
