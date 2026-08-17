import { fileURLToPath } from "node:url";

// Package payload, resolved relative to this module exactly like
// runtime-tmux.ts resolves tmux.conf: identical path from v2/src (tests) and
// v2/dist (published). Resolved lazily (not at module load) because
// packages/web's Vite-based test transform rewrites import.meta.url to a
// non-file scheme for modules it loads, and this module is imported there
// (session-prompt.test.ts, session-search.test.ts) purely for
// renderBootstrapPrompt, which never needs this path itself.
let referencePathCache: string | undefined;
export function resolveBootstrapConfigReferencePath(): string {
  return (referencePathCache ??= fileURLToPath(new URL("../spur.yaml.reference", import.meta.url)));
}

export interface BootstrapPromptContext {
  id: string;
  displayName: string;
  prefix: string;
  path: string;
  port: number;
  referencePath: string;
}

export function renderBootstrapPrompt(ctx: BootstrapPromptContext): string {
  const { id, displayName, prefix, path, port, referencePath } = ctx;
  return `You are configuring a new Spur project named "${displayName}".

Inputs (do not change these values):
- project id: ${id}
- sessionPrefix: ${prefix}
- project path: ${path}

Goal: write a spur.yaml at the project root that registers this project, then ask Spur to connect it.

Steps:
1. Read the capability reference at ${referencePath} in full. It is a parse-valid catalog of every key spur.yaml
   supports; do not invent a key that is not in it. Recon the project at ${path}: README.md, package.json,
   Cargo.toml, go.mod, pyproject.toml, .github/workflows/*. Identify the default branch by running
   \`git -C ${path} symbolic-ref --short HEAD\` or \`git -C ${path} remote show origin\`. Do not run network
   commands beyond \`git remote show\`.
2. Detect capability signals: dev/test/build commands, a dev-server command and port, untracked local artifacts
   (.env, node_modules, target/, .venv), the \`git remote get-url origin\` host (no auth probe), and any
   .claude/skills/*/SKILL.md files.
3. Write the file ${path}/spur.yaml using only the keys listed below, each one copied verbatim from the
   reference when you use it: id/name/path/defaultBranch/sessionPrefix plus the detected subset of symlinks,
   branchNaming, defaultAgent, defaultModels, reasoningEffort, sidecars (with ports), workspaceAccess, and
   modes. A key not in this list is forbidden. \`sources\` and \`triggers\` are FORBIDDEN in this phase:
   connecting reloads automation unconditionally and a github source starts polling immediately, which would
   auto-spawn sessions before the user has consented. They land only in step 7, after an affirmative answer to
   the GitHub automation question.

   projects:
     ${id}:
       name: "${displayName}"
       path: .
       defaultBranch: <DETECTED_DEFAULT_BRANCH>
       sessionPrefix: ${prefix}

   Do NOT change the id "${id}" or the sessionPrefix "${prefix}".
4. Call the Spur daemon to register it. The trailing line of the output is the HTTP status code; assert it is
   2xx and that the body above it contains "configured":true for "${id}":

   curl -sS -w '\\n%{http_code}' -X POST -H 'content-type: application/json' \\
     -d '{"configPath":"${path}/spur.yaml"}' \\
     http://127.0.0.1:${port}/projects/connect

5. If the status code is not 2xx or the body lacks "configured":true, print the output verbatim, fix spur.yaml
   once, and re-run the same curl once. Still failing: print the error and stop, leaving the file in place.
6. Send this question batch as ONE message, at most 6 questions, each stating its default — the value you wrote
   in step 3, or Spur's own schema default when step 3 left the key out:
   Q1. Per-session git worktree (default: true, the schema default, unless you wrote worktree: false) and
       branch-name regex (default: the regex you wrote in step 3, if any) — keep them?
   Q2. Default agent and model — keep the detected defaults above?
   Q3. Run the dev/preview server as a sidecar, with a port range — add it, or skip it?
   Q4. Any files to symlink into each worktree (e.g. .env, node_modules) beyond what you already added?
   Q5. Enable GitHub PR automation (a github source plus lifecycle triggers that wake an agent on review
       comments, CI failures, and merge)? Ask only if \`git remote get-url origin\` resolves to a github.com host.
   Q6. A default mode/skill for new sessions? Ask only if .claude/skills/*/SKILL.md exists in the project.
   Send the questions as one message, then stop and wait for the reply. Do not answer them yourself, do not
   continue working, and do not send a second message. If the reply never comes, the configuration you already
   connected is final.
7. On a reply: edit spur.yaml with the answers. This is the only step that may add \`sources\` and \`triggers\`,
   and only on an affirmative Q5 (a github source plus plain-English lifecycle triggers — no $skill or /command
   references, which only exist in the Spur repo itself). Then re-run the same connect curl and check its status
   code and body exactly as in step 5. If it still fails after one fix-and-retry, restore spur.yaml to the
   version connected in step 4 — the file on disk must never diverge from what the daemon has registered — and
   stop. No answer received: the config already connected in step 4 stands; never ask again.

Constraints:
- Do not modify any file other than spur.yaml.
- Do not run package managers, build tools, or tests.
- Do not create branches, commits, or pushes.
- Keep total output under 40 lines.
`;
}
