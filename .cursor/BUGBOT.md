# BugBot Configuration

## Project Context

Spur is a TypeScript monorepo: a local daemon plus CLI, and an optional Next.js UI in `packages/web/` that proxies to the daemon HTTP API.

## Tech Stack

- TypeScript (strict mode, ESM with `.js` extensions in imports)
- Node.js 20+ (use `node:` prefix for built-in modules)
- pnpm workspaces
- Next.js 15 (App Router) for the web UI
- Commander.js for CLI
- vitest for testing

## Review Focus

- **Security**: command injection (especially in shell/tmux/git commands), unsanitized user input in API routes, GraphQL injection
- **Shell execution**: prefer `execFile` over `exec`. Flag any `exec` or string concatenation in shell commands
- **Type safety**: flag `as unknown as T` casts and unguarded `JSON.parse`
- **Resource leaks**: uncleared intervals/timeouts, uncleaned event listeners, missing `cancel()` on streams
- **ESM compliance**: imports must use `.js` extension for local files, `node:` prefix for builtins
- **State detection order**: session state and rate-limit detection must read structured agent sources first (transcript/rollout JSONL, status files); the tmux pane scan is a fallback only. Flag tmux-first detection.
- Config or interface changes that do not update the config docs (README.md `## Config` and the `spur` SKILL.md mirrors)
- Docs drift (rules: the `docs-management` skill): new user-facing functionality shipped without documenting it, content duplicated instead of linked, or docs that over-explain what a mid dev or agent already knows

## Ignore

- `scripts/` — bash deploy and sidecar helpers, not part of the TypeScript codebase
