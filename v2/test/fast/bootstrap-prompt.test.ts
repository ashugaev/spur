import { describe, expect, it } from "vitest";
import { renderBootstrapPrompt } from "../../src/bootstrap-prompt.js";

describe("renderBootstrapPrompt", () => {
  it("renders a deterministic prompt for fixed inputs", () => {
    const prompt = renderBootstrapPrompt({
      id: "demo-app",
      displayName: "Demo App",
      prefix: "demo",
      path: "/repo/demo",
      port: 4310,
      referencePath: "/repo/spur.yaml.reference",
    });
    expect(prompt).toMatchInlineSnapshot(`
      "You are configuring a new Spur project named "Demo App".

      Inputs (do not change these values):
      - project id: demo-app
      - sessionPrefix: demo
      - project path: /repo/demo

      Goal: write a spur.yaml at the project root that registers this project, then ask Spur to connect it.

      Steps:
      1. Read the capability reference at /repo/spur.yaml.reference in full. It is a parse-valid catalog of every key spur.yaml
         supports; do not invent a key that is not in it. Recon the project at /repo/demo: README.md, package.json,
         Cargo.toml, go.mod, pyproject.toml, .github/workflows/*. Identify the default branch by running
         \`git -C /repo/demo symbolic-ref --short HEAD\` or \`git -C /repo/demo remote show origin\`. Do not run network
         commands beyond \`git remote show\`.
      2. Detect capability signals: dev/test/build commands, a dev-server command and port, untracked local artifacts
         (.env, node_modules, target/, .venv), the \`git remote get-url origin\` host (no auth probe), and any
         .claude/skills/*/SKILL.md files.
      3. Write the file /repo/demo/spur.yaml with every key copied verbatim from the reference, restricted to:
         id/name/path/defaultBranch/sessionPrefix plus the detected subset of symlinks, branchNaming, defaultAgent,
         defaultModels, reasoningEffort, sidecars (with ports), workspaceAccess, and modes. A key not present in the
         reference is forbidden. \`sources\` and \`triggers\` are FORBIDDEN in this phase: connecting reloads automation
         unconditionally and a github source starts polling immediately, which would auto-spawn sessions before the
         user has consented. They land only in step 6, after an affirmative answer to the GitHub automation question.

         projects:
           demo-app:
             name: "Demo App"
             path: .
             defaultBranch: <DETECTED_DEFAULT_BRANCH>
             sessionPrefix: demo

         Do NOT change the id "demo-app" or the sessionPrefix "demo".
      4. Call the Spur daemon to register it, then assert the response body contains "configured":true for "demo-app":

         curl -sS --fail-with-body -X POST -H 'content-type: application/json' \\
           -d '{"configPath":"/repo/demo/spur.yaml"}' \\
           http://127.0.0.1:4310/projects/connect

      5. If the call fails or the response lacks "configured":true, print the response body verbatim, fix spur.yaml
         once, and re-run the same curl once. Still failing: print the error and stop, leaving the file in place.
      6. Send this question batch as ONE message, at most 6 questions, each carrying the value you already wrote as
         its default:
         Q1. Per-session git worktree and branch-name regex — keep worktree: true and the regex above?
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
         references, which only exist in the Spur repo itself). Then re-run the same connect curl. No answer received:
         the config already connected stands; never ask again.

      Constraints:
      - Do not modify any file other than spur.yaml.
      - Do not run package managers, build tools, or tests.
      - Do not create branches, commits, or pushes.
      - Keep total output under 40 lines.
      "
    `);
  });

  it("interpolates a non-default daemon port into the curl example", () => {
    const prompt = renderBootstrapPrompt({
      id: "demo-app",
      displayName: "Demo App",
      prefix: "demo",
      path: "/repo/demo",
      port: 5511,
      referencePath: "/repo/spur.yaml.reference",
    });
    expect(prompt).toContain("http://127.0.0.1:5511/projects/connect");
    expect(prompt).not.toContain("127.0.0.1:4310");
  });

  it("interpolates the absolute reference path and keeps the connect curl unchanged in shape", () => {
    const prompt = renderBootstrapPrompt({
      id: "demo-app",
      displayName: "Demo App",
      prefix: "demo",
      path: "/repo/demo",
      port: 4310,
      referencePath: "/repo/spur.yaml.reference",
    });

    expect(prompt).toContain("/repo/spur.yaml.reference");
    expect(prompt).toContain(
      "curl -sS --fail-with-body -X POST -H 'content-type: application/json' \\",
    );
    expect(prompt).toContain('-d \'{"configPath":"/repo/demo/spur.yaml"}\' \\');
    expect(prompt).toContain("http://127.0.0.1:4310/projects/connect");
  });

  it("asks at most 6 questions in a single batch", () => {
    const prompt = renderBootstrapPrompt({
      id: "demo-app",
      displayName: "Demo App",
      prefix: "demo",
      path: "/repo/demo",
      port: 4310,
      referencePath: "/repo/spur.yaml.reference",
    });

    const questionNumbers = [...prompt.matchAll(/\bQ(\d+)\./g)].map((match) => Number(match[1]));
    expect(questionNumbers.length).toBeGreaterThan(0);
    expect(Math.max(...questionNumbers)).toBeLessThanOrEqual(6);
    expect(new Set(questionNumbers).size).toBe(questionNumbers.length);
  });

  it("forbids sources/triggers in the write step and authorizes them only in the edit step", () => {
    const prompt = renderBootstrapPrompt({
      id: "demo-app",
      displayName: "Demo App",
      prefix: "demo",
      path: "/repo/demo",
      port: 4310,
      referencePath: "/repo/spur.yaml.reference",
    });
    const steps = prompt.split(/\n(?=\d+\. )/).filter((step) => /^\d+\. /.test(step));
    const writeStep = steps.find((step) => step.startsWith("3. "));
    const editStep = steps.find((step) => step.includes("may add"));

    expect(writeStep).toContain("`sources` and `triggers` are FORBIDDEN in this phase");
    expect(editStep).toContain("may add `sources` and `triggers`");
    expect(steps.filter((step) => step.includes("may add `sources` and `triggers`"))).toHaveLength(
      1,
    );
    expect(writeStep).not.toBe(editStep);
  });
});
