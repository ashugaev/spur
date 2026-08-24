import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDefaultInstanceConfigPath } from "./config.js";

// One symlink per skill per agent host dir. Every release (or daemon boot on
// the default instance) re-points Spur's own links at the packaged skill
// dir, while a path this module does not own is left byte-untouched and
// reported as a conflict — see the `spur doctor` `skills-symlinks` check.

export type HostSkillOutcome = {
  skill: string;
  dir: string;
  status: "linked" | "unchanged" | "conflict" | "error";
  conflictPath?: string;
  conflictKind?: "file" | "directory" | "foreign-symlink";
  error?: string;
};

export function packagedSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

// Widened form of the `linkProjectsDir`/`ensureAccountProjectsLink` skeleton
// in claude-accounts.ts: lstat/isSymbolicLink/readlink, but ownership is a
// PREFIX/structure test instead of exact-target equality, and a conflicting
// directory or file is reported, never merged or thrown.
//
// Ownership is self-describing from the link text alone — never
// `samePathOnDisk`, never `realpathSync` on the link or its target. The one
// `existsSync` below (on the resolved target) exists solely to detect a
// DANGLING link; a target that does not exist at all, whose link text still
// looks like `<root>/skills/<name>`, is Spur-owned and gets replaced with no
// warning — this reclaims a link across install roots (npm global root,
// main-deploy source root, a dev worktree) even after the old root is gone.
// A target that DOES exist is never re-checked with `existsSync` for the
// ownership decision; `<root>/dist/cli.js` presence is the only other
// permitted `existsSync`, and it answers a different question (is the root
// still alive), not whether the target exists.
export function classifyHostSkillTarget(
  link: string,
): "absent" | "owned" | "foreign-symlink" | "file" | "directory" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw error;
  }

  if (!stat.isSymbolicLink()) {
    return stat.isDirectory() ? "directory" : "file";
  }

  const linkText = readlinkSync(link);
  const resolvedTarget = resolve(dirname(link), linkText);

  if (!existsSync(resolvedTarget)) {
    // Dangling. Never existsSync the target again from here — only the
    // structure of the link TEXT decides ownership.
    return basename(dirname(linkText)) === "skills" ? "owned" : "foreign-symlink";
  }

  const skillsDir = dirname(resolvedTarget);
  if (basename(skillsDir) !== "skills") {
    return "foreign-symlink";
  }
  const installRoot = dirname(skillsDir);
  return existsSync(join(installRoot, "dist", "cli.js")) ? "owned" : "foreign-symlink";
}

export function installHostSkills(options?: {
  home?: string;
  skillsDir?: string;
}): HostSkillOutcome[] {
  const home = options?.home ?? homedir();
  const skillsDir = options?.skillsDir ?? packagedSkillsDir();
  if (!existsSync(skillsDir)) {
    return [];
  }

  let skillNames: string[];
  try {
    skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const outcomes: HostSkillOutcome[] = [];
  const hostRoots = [join(home, ".claude", "skills"), join(home, ".codex", "skills")];

  for (const name of skillNames) {
    const pkgSkillDir = join(skillsDir, name);
    for (const root of hostRoots) {
      const link = join(root, name);
      try {
        mkdirSync(root, { recursive: true });
        const classification = classifyHostSkillTarget(link);

        if (classification === "absent") {
          symlinkSync(pkgSkillDir, link, "dir");
          outcomes.push({ skill: name, dir: link, status: "linked" });
          continue;
        }

        if (classification === "owned") {
          if (readlinkSync(link) === pkgSkillDir) {
            outcomes.push({ skill: name, dir: link, status: "unchanged" });
            continue;
          }
          unlinkSync(link);
          symlinkSync(pkgSkillDir, link, "dir");
          outcomes.push({ skill: name, dir: link, status: "linked" });
          continue;
        }

        outcomes.push({
          skill: name,
          dir: link,
          status: "conflict",
          conflictPath: link,
          conflictKind: classification,
        });
      } catch (error) {
        outcomes.push({
          skill: name,
          dir: link,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return outcomes;
}

export function installHostSkillsForDaemonStart(configPath: string): HostSkillOutcome[] {
  if (!isDefaultInstanceConfigPath(configPath)) {
    return [];
  }
  return installHostSkills();
}

export function renderHostSkillWarnings(outcomes: HostSkillOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.status === "conflict" || outcome.status === "error")
    .map((outcome) => {
      if (outcome.status === "error") {
        return `spur: failed to install host skill '${outcome.skill}' at ${outcome.dir}: ${outcome.error}`;
      }
      return `spur: host skill '${outcome.skill}' conflict at ${outcome.conflictPath} (${outcome.conflictKind})`;
    });
}
