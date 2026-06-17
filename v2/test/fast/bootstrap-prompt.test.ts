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
    });
    expect(prompt).toMatchInlineSnapshot(`
      "You are configuring a new Spur project named "Demo App".

      Inputs (do not change these values):
      - project id: demo-app
      - sessionPrefix: demo
      - project path: /repo/demo

      Goal: write a spur.yaml at the project root that registers this project, then ask Spur to connect it.

      Steps:
      1. Inspect the project at /repo/demo. Read these files if present: README.md, package.json, Cargo.toml, go.mod, pyproject.toml, .github/workflows/*. Identify the default branch (main, master, develop) by running \`git -C /repo/demo symbolic-ref --short HEAD\` or \`git -C /repo/demo remote show origin\`. Do not run network commands beyond \`git remote show\`.
      2. Identify the primary build/test commands. If a CLI binary is present, run its \`--help\` once to confirm. Keep notes concise.
      3. Write the file /repo/demo/spur.yaml with this exact top-level structure:

         projects:
           demo-app:
             name: "Demo App"
             path: .
             defaultBranch: <DETECTED_DEFAULT_BRANCH>
             sessionPrefix: demo

         Do NOT change the id "demo-app" or the sessionPrefix "demo". You may add optional fields (sidecars, sources, triggers) only if you are confident they are correct for this project — when in doubt, leave them out.

      4. After writing the file, call the Spur daemon to register it. Use this curl command and report the response body:

         curl -fsS -X POST -H 'content-type: application/json' \\
           -d '{"configPath":"/repo/demo/spur.yaml"}' \\
           http://127.0.0.1:4310/projects/connect

      5. If the connect call returns a non-2xx response, do not retry. Print the error verbatim and stop.

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
    });
    expect(prompt).toContain("http://127.0.0.1:5511/projects/connect");
    expect(prompt).not.toContain("127.0.0.1:4310");
  });
});
