import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDefaultInstanceConfigPath } from "./config.js";

// One symlink per skill per agent host dir. Every release (or daemon boot on
// the default instance) re-points Spur's own links at the packaged skill
// dir, while a path this module does not own is left byte-untouched and
// reported as a conflict — see the `spur doctor` `skills-symlinks` check.

export type HostSkillOutcome = {
  skill: string;
  dir: string;
  status: "linked" | "unchanged" | "conflict" | "error" | "skipped";
  conflictPath?: string;
  conflictKind?: "file" | "directory" | "foreign-symlink";
  error?: string;
  reason?: "host-dir-absent" | "host-dir-unreadable" | "home-not-absolute";
};

export function packagedSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

// Root existence gate, tri-state: `existsSync` alone reads `false` for
// EACCES exactly like the target-side dangling check above, and sending an
// operator whose `~/.claude` is unreadable to `mkdir -p ... && spur reinit`
// hands them a command that fails with EEXIST/EACCES, not a fix. `statSync`
// follows symlinks (same as `existsSync`), so a `skills` dir that is itself
// a symlink to a real directory still classifies "present".
export function classifyHostSkillRoot(root: string): "absent" | "unreadable" | "present" {
  try {
    statSync(root);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

// Widened form of the `linkProjectsDir`/`ensureAccountProjectsLink` skeleton
// in claude-accounts.ts: lstat/isSymbolicLink/readlink, but ownership is a
// PREFIX/structure test instead of exact-target equality, and a conflicting
// directory or file is reported, never merged or thrown.
//
// Ownership is self-describing from the link text alone — never
// `samePathOnDisk`, never `realpathSync` on the link or its target. The
// `statSync` below (on the resolved target) exists solely to detect a
// PROVEN-ENOENT dangling link; a target that does not exist at all, whose
// link text still looks like `<root>/skills/<name>`, is Spur-owned and gets
// replaced with no warning — this reclaims a link across install roots (npm
// global root, main-deploy source root, a dev worktree) even after the old
// root is gone. Any other errno (EACCES from an unreadable parent, an
// unmounted volume, a stale NFS mount) means the target may be alive and
// Spur just can't see it — never reclaim on that, classify foreign instead.
// A target that DOES exist is never re-checked for the ownership decision;
// `<root>/dist/cli.js` presence is the only other permitted `existsSync`,
// and it answers a different question (is the root still alive), not
// whether the target exists.
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

  // Reclaim ownership only on a PROVEN ENOENT (or a PROVEN self-referential
  // ELOOP — a link pointing at itself never resolves to anything either, so
  // it is dangling in effect, same as ENOENT). Linux also raises ELOOP for a
  // RESOLVABLE chain deeper than 40 hops — that is a live target Spur just
  // can't see, not proof of nothing there, so it must never be inferred from
  // the errno alone: only `resolvedTarget === link` (immediate self-loop)
  // counts as proven. `existsSync` would also read `false` for EACCES (an
  // unreadable parent — an unmounted volume, a not-yet-cloned dotfiles
  // checkout, a stale NFS mount, a root-owned 0700 directory), which would
  // misclassify a live target the caller simply cannot see as
  // dangling-and-Spur-owned and silently delete the user's link. Any other
  // errno, or an unproven ELOOP, means "live, unknown" — foreign.
  let targetIsDangling: boolean;
  try {
    statSync(resolvedTarget);
    targetIsDangling = false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const provenDangling = code === "ENOENT" || (code === "ELOOP" && resolvedTarget === link);
    if (!provenDangling) {
      return "foreign-symlink";
    }
    targetIsDangling = true;
  }

  if (targetIsDangling) {
    // Dangling. Never existsSync/statSync the target again from here — only
    // the structure of the RESOLVED target decides ownership (never the raw
    // link text: a relative dangling text like `./spur` or `spur` resolves
    // to the right directory but has no `skills` component of its own).
    return basename(dirname(resolvedTarget)) === "skills" ? "owned" : "foreign-symlink";
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

  if (!isAbsolute(home)) {
    // `os.homedir()` returns `$HOME` verbatim when it is set but empty —
    // only an UNSET HOME falls back to the passwd entry. An empty or
    // otherwise relative resolved home would make both host roots relative
    // to `process.cwd()`; on the daemon (`WorkingDirectory` = the source
    // checkout) that writes symlinks into a git working tree. Never resolve
    // a root against a non-absolute home — skip everything, warn once.
    return skillNames.map((name) => ({
      skill: name,
      dir: home,
      status: "skipped",
      reason: "home-not-absolute",
    }));
  }

  const outcomes: HostSkillOutcome[] = [];
  const hostRoots = [join(home, ".claude", "skills"), join(home, ".codex", "skills")];

  for (const root of hostRoots) {
    // Spur never creates a missing host skills dir — the dir itself, not
    // the agent home, is the existence gate (see host-skills spec). Absent
    // and unreadable (EACCES on the root or a parent) are distinct: only
    // "absent" gets the `mkdir -p` fix, since that command cannot repair a
    // permissions problem.
    const rootState = classifyHostSkillRoot(root);
    if (rootState !== "present") {
      for (const name of skillNames) {
        outcomes.push({
          skill: name,
          dir: join(root, name),
          status: "skipped",
          reason: rootState === "absent" ? "host-dir-absent" : "host-dir-unreadable",
        });
      }
      continue;
    }

    for (const name of skillNames) {
      const pkgSkillDir = join(skillsDir, name);
      const link = join(root, name);
      try {
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
  const lines: string[] = [];

  const homeNotAbsolute = outcomes.filter(
    (outcome) => outcome.status === "skipped" && outcome.reason === "home-not-absolute",
  );
  if (homeNotAbsolute.length > 0) {
    const home = homeNotAbsolute[0]?.dir ?? "";
    const skills = homeNotAbsolute.map((outcome) => outcome.skill).join(", ");
    lines.push(
      `spur: host skills not linked — HOME resolved to '${home}', which is not an absolute path, so Spur will not guess a target (skipped: ${skills}). Fix HOME and run \`spur reinit\`.`,
    );
  }

  // One collapsed line per absent root, not one per skill — a packaged
  // skill count growing must not multiply stderr lines on every daemon
  // boot and every `spur update`.
  const absentRoots = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (outcome.status === "skipped" && outcome.reason === "host-dir-absent") {
      const root = dirname(outcome.dir);
      const skills = absentRoots.get(root) ?? [];
      skills.push(outcome.skill);
      absentRoots.set(root, skills);
    }
  }
  for (const [root, skills] of absentRoots) {
    lines.push(
      `spur: host skills not linked — ${root} does not exist and Spur does not create it (skipped: ${skills.join(", ")}). If this agent is installed here, run \`mkdir -p ${root} && spur reinit\`. Otherwise ignore.`,
    );
  }

  // Unreadable roots get their own line — no `mkdir -p`, that command fails
  // on a permissions problem, it does not fix one.
  const unreadableRoots = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (outcome.status === "skipped" && outcome.reason === "host-dir-unreadable") {
      const root = dirname(outcome.dir);
      const skills = unreadableRoots.get(root) ?? [];
      skills.push(outcome.skill);
      unreadableRoots.set(root, skills);
    }
  }
  for (const [root, skills] of unreadableRoots) {
    lines.push(
      `spur: host skills not linked — ${root} is unreadable (permission denied), so Spur cannot tell whether it exists (skipped: ${skills.join(", ")}). Check its permissions and its parent directories', then run \`spur reinit\`.`,
    );
  }

  for (const outcome of outcomes) {
    if (outcome.status === "error") {
      lines.push(
        `spur: failed to install host skill '${outcome.skill}' at ${outcome.dir}: ${outcome.error}`,
      );
    } else if (outcome.status === "conflict") {
      lines.push(
        `spur: host skill '${outcome.skill}' conflict at ${outcome.conflictPath} (${outcome.conflictKind})`,
      );
    }
  }

  return lines;
}
