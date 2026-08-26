import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The script lives at repo-root scripts/bundle-skills.sh; this test file is
// at v2/test/fast/bundle-skills.test.ts.
const SCRIPT_PATH = fileURLToPath(new URL("../../../scripts/bundle-skills.sh", import.meta.url));

async function writeSkill(fixtureRoot: string, name: string, frontmatter: string): Promise<void> {
  const dir = join(fixtureRoot, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody text\n`, "utf8");
}

function runBundleSkills(fixtureRoot: string): void {
  execFileSync("bash", [SCRIPT_PATH], {
    env: { ...process.env, SPUR_BUNDLE_SKILLS_ROOT: fixtureRoot },
    stdio: "pipe",
  });
}

describe("bundle-skills.sh", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "spur-bundle-skills-"));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("T9a copies a skill whose frontmatter carries hostInstall: true", async () => {
    await writeSkill(fixtureRoot, "spur", "name: spur\nhostInstall: true");
    runBundleSkills(fixtureRoot);
    const copied = readFileSync(join(fixtureRoot, "v2", "skills", "spur", "SKILL.md"), "utf8");
    expect(copied).toContain("hostInstall: true");
  });

  it("T9b does not copy a skill without the key", async () => {
    await writeSkill(fixtureRoot, "spur", "name: spur\nhostInstall: true");
    await writeSkill(fixtureRoot, "other", "name: other\ndescription: no host install");
    runBundleSkills(fixtureRoot);
    const names = readdirSync(join(fixtureRoot, "v2", "skills"));
    expect(names).toEqual(["spur"]);
  });

  it("T9c dereferences a symlink inside a source skill", async () => {
    await writeSkill(fixtureRoot, "spur", "name: spur\nhostInstall: true");
    const refDir = join(fixtureRoot, ".claude", "skills", "spur", "references");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "real.md"), "reference content\n", "utf8");
    await symlink(join(refDir, "real.md"), join(refDir, "linked.md"));

    runBundleSkills(fixtureRoot);

    const copiedLink = join(fixtureRoot, "v2", "skills", "spur", "references", "linked.md");
    expect(lstatSync(copiedLink).isSymbolicLink()).toBe(false);
    expect(readFileSync(copiedLink, "utf8")).toBe("reference content\n");
  });

  it("T9d is idempotent across re-runs", async () => {
    await writeSkill(fixtureRoot, "spur", "name: spur\nhostInstall: true");
    runBundleSkills(fixtureRoot);
    runBundleSkills(fixtureRoot);
    const names = readdirSync(join(fixtureRoot, "v2", "skills"));
    expect(names).toEqual(["spur"]);
    const skillFiles = readdirSync(join(fixtureRoot, "v2", "skills", "spur"));
    expect(skillFiles).toEqual(["SKILL.md"]);
  });

  it("T9e exits nonzero when zero skills match", async () => {
    await writeSkill(fixtureRoot, "other", "name: other\ndescription: no host install");
    expect(() => runBundleSkills(fixtureRoot)).toThrow();
  });

  it("matches hostInstall: true only inside the leading frontmatter block", async () => {
    await writeSkill(fixtureRoot, "body-only", "name: body-only\ndescription: no frontmatter key");
    await mkdir(join(fixtureRoot, ".claude", "skills", "body-only"), { recursive: true });
    await writeFile(
      join(fixtureRoot, ".claude", "skills", "body-only", "SKILL.md"),
      "---\nname: body-only\ndescription: no frontmatter key\n---\n\nhostInstall: true\n",
      "utf8",
    );
    expect(() => runBundleSkills(fixtureRoot)).toThrow();
  });
});
