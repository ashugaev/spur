export interface BootstrapPromptContext {
  id: string;
  displayName: string;
  prefix: string;
  path: string;
  port: number;
}

export function renderBootstrapPrompt(ctx: BootstrapPromptContext): string {
  const { id, displayName, prefix, path, port } = ctx;
  return `You are configuring a new Spur project named "${displayName}".

Inputs (do not change these values):
- project id: ${id}
- sessionPrefix: ${prefix}
- project path: ${path}

Goal: write a spur.yaml at the project root that registers this project, then ask Spur to connect it.

Steps:
1. Inspect the project at ${path}. Read these files if present: README.md, package.json, Cargo.toml, go.mod, pyproject.toml, .github/workflows/*. Identify the default branch (main, master, develop) by running \`git -C ${path} symbolic-ref --short HEAD\` or \`git -C ${path} remote show origin\`. Do not run network commands beyond \`git remote show\`.
2. Identify the primary build/test commands. If a CLI binary is present, run its \`--help\` once to confirm. Keep notes concise.
3. Write the file ${path}/spur.yaml with this exact top-level structure:

   projects:
     ${id}:
       name: "${displayName}"
       path: .
       defaultBranch: <DETECTED_DEFAULT_BRANCH>
       sessionPrefix: ${prefix}

   Do NOT change the id "${id}" or the sessionPrefix "${prefix}". You may add optional fields (sidecars, sources, triggers) only if you are confident they are correct for this project — when in doubt, leave them out.

4. After writing the file, call the Spur daemon to register it. Use this curl command and report the response body:

   curl -fsS -X POST -H 'content-type: application/json' \\
     -d '{"configPath":"${path}/spur.yaml"}' \\
     http://127.0.0.1:${port}/projects/connect

5. If the connect call returns a non-2xx response, do not retry. Print the error verbatim and stop.

Constraints:
- Do not modify any file other than spur.yaml.
- Do not run package managers, build tools, or tests.
- Do not create branches, commits, or pushes.
- Keep total output under 40 lines.
`;
}
