import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string };
type Workflow = {
  jobs: { release: { steps: Step[] } };
};

const root = fileURLToPath(new URL("../../../", import.meta.url));
const release = parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
) as Workflow;
const step = release.jobs.release.steps.find(
  (entry) => entry.name === "Verify packed tarball contents",
)!.run!;
const realTar = execFileSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).trim();

describe("release pack shell boundary", () => {
  let directory: string;
  let workspace: string;
  let bin: string;
  let destination: string;
  let archive: string;
  let calls: string;
  let checkerCalls: string;
  let payload: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "spur-release-pack-"));
    workspace = join(directory, "workspace with spaces");
    bin = join(directory, "bin");
    destination = join(directory, "pack destination");
    archive = join(directory, "fixture.tgz");
    calls = join(directory, "tar-calls");
    checkerCalls = join(directory, "checker-calls");
    payload = join(directory, "payload", "package");
    for (const path of [bin, destination, join(workspace, "scripts"), join(workspace, "v2")]) {
      mkdirSync(path, { recursive: true });
    }
    copyFileSync(join(root, "scripts/pack-release.sh"), join(workspace, "scripts/pack-release.sh"));
    // Shell orchestration double only; real archive/closure checks live in distribution tests.
    writeFileSync(
      join(workspace, "scripts/verify-package-tarball.sh"),
      `#!/usr/bin/env bash
set -eu
[[ "$#" == 1 && "$1" == "$RUNNER_TEMP/$PACK_TEST_NAME" ]]
printf '%s\n' "$1" >> "$PACK_TEST_CHECKER_CALLS"
if [[ "$PACK_TEST_MODE" == refuse ]]; then
  printf 'review-app-package: verification failed\n' >&2
  exit 1
fi
`,
    );
    const manifest = readFileSync(join(root, "v2/required-package-files.txt"), "utf8");
    writeFileSync(join(workspace, "v2/required-package-files.txt"), manifest);
    for (const entry of [
      ...manifest.trim().split("\n"),
      `web/node_modules/node-pty/prebuilds/linux-${process.arch}/pty.node`,
    ]) {
      const path = join(payload, entry);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "fixture\n");
    }
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env bash
set -eu
[[ "$#" == 3 && "$1" == pack && "$2" == --pack-destination ]]
[[ "$PWD" == "$PACK_TEST_WORKSPACE/v2" ]]
if [[ "$PACK_TEST_MODE" == fail ]]; then
  printf 'fixture compiler diagnostic\nELIFECYCLE Command failed with exit code 2.\n'
  printf 'fixture npm stderr\n' >&2
  exit 2
fi
if [[ "$PACK_TEST_MODE" == success || "$PACK_TEST_MODE" == refuse ]]; then
  cp "$PACK_TEST_ARCHIVE" "$3/$PACK_TEST_NAME"
fi
printf 'fixture prepack output\n%s\n' "$PACK_TEST_NAME"
`,
    );
    writeFileSync(
      join(bin, "tar"),
      `#!/usr/bin/env bash
printf 'tar\n' >> "$PACK_TEST_CALLS"
exec "$PACK_TEST_REAL_TAR" "$@"
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "tar"), 0o755);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(step: string, mode = "success", name = "shugaev-spur-fixture.tgz") {
    execFileSync(realTar, ["-czf", archive, "-C", join(directory, "payload"), "package"]);
    return spawnSync("bash", ["-e", "-c", step], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: destination,
        GITHUB_WORKSPACE: workspace,
        PACK_TEST_WORKSPACE: workspace,
        PACK_TEST_ARCHIVE: archive,
        PACK_TEST_MODE: mode,
        PACK_TEST_NAME: name,
        PACK_TEST_CALLS: calls,
        PACK_TEST_CHECKER_CALLS: checkerCalls,
        PACK_TEST_REAL_TAR: realTar,
      },
    });
  }

  it("preserves failed prepack exit and both output streams before invoking tar", () => {
    const result = run(step, "fail");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("fixture compiler diagnostic");
    expect(result.stderr).toContain("ELIFECYCLE Command failed with exit code 2.");
    expect(result.stderr).toContain("fixture npm stderr");
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(checkerCalls)).toBe(false);
  });

  it("verifies the produced archive with paths containing spaces", () => {
    const result = run(step);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(destination, "shugaev-spur-fixture.tgz"));
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(checkerCalls, "utf8")).toBe(
      `${join(destination, "shugaev-spur-fixture.tgz")}\n`,
    );
  });

  it.each([
    "",
    "../outside.tgz",
    "other/archive.tgz",
    "archive with spaces.tgz",
    "ELIFECYCLE",
    ".tgz",
  ])("rejects invalid pack filename %j before invoking tar", (name) => {
    const result = run(step, "invalid", name);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm pack did not produce a valid archive");
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(checkerCalls)).toBe(false);
  });

  it("rejects a valid filename when npm did not produce the file", () => {
    const result = run(step, "missing");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm pack did not produce a valid archive");
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(checkerCalls)).toBe(false);
  });

  it("propagates checker refusal before native and skill checks", () => {
    const result = run(step, "refuse");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("review-app-package: verification failed\n");
    expect(readFileSync(checkerCalls, "utf8")).toBe(
      `${join(destination, "shugaev-spur-fixture.tgz")}\n`,
    );
    expect(existsSync(calls)).toBe(false);
  });

  it("retains the native binary check", () => {
    unlinkSync(join(payload, `web/node_modules/node-pty/prebuilds/linux-${process.arch}/pty.node`));
    const result = run(step);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing node-pty/prebuilds/linux-${process.arch}/pty.node`);
    expect(readFileSync(checkerCalls, "utf8")).toBe(
      `${join(destination, "shugaev-spur-fixture.tgz")}\n`,
    );
  });

  it("rejects a skill stored as a symlink", () => {
    const skill = join(payload, "skills/spur/SKILL.md");
    unlinkSync(skill);
    symlinkSync("target.md", skill);
    writeFileSync(join(dirname(skill), "target.md"), "fixture\n");
    const result = run(step);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SKILL.md as a non-regular file");
    expect(readFileSync(checkerCalls, "utf8")).toBe(
      `${join(destination, "shugaev-spur-fixture.tgz")}\n`,
    );
  });
});
