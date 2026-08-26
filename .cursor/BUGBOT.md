SPUR BUGBOT REVIEW SCOPE

PROJECT
  Spur: TypeScript monorepo, local daemon plus CLI, optional Next.js UI in packages/web/ proxying to the daemon HTTP API.

STACK
  TypeScript strict, ESM with .js import extensions.
  Node.js 20+, node: prefix for builtins.
  pnpm workspaces.
  Next.js 15 App Router for the web UI.
  Commander.js for the CLI.
  vitest for tests.

REVIEW FOCUS
  Security: command injection (shell/tmux/git commands), unsanitized user input in API routes, GraphQL injection.
  Shell execution: execFile over exec. Flag exec or string-concatenated shell commands.
  Type safety: flag as unknown as T casts and unguarded JSON.parse.
  Resource leaks: uncleared intervals/timeouts, uncleaned event listeners, missing cancel() on streams.
  ESM compliance: .js extension on local imports, node: prefix on builtins.
  State detection order: session state and rate-limit detection reads structured agent sources first (transcript/rollout JSONL, status files); tmux pane scan is fallback only. Flag tmux-first detection.
  Config docs: flag config or interface changes that skip docs/configuration.md, docs/commands.md, docs/daemon-api.md, or the spur SKILL.md mirrors.
  Docs drift (docs skill rules): new user-facing functionality shipped undocumented, content duplicated instead of linked, or docs over-explaining what a mid dev or agent already knows.

IGNORE
  scripts/ — bash deploy and sidecar helpers, outside the TypeScript codebase.
