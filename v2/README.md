# Spur

Lean `v2/` orchestrator.

- Local daemon + CLI
- `git worktree` + symlinks + detached `tmux`
- Direct `claude` / `codex` launch
- Project-local `sources -> events -> triggers`

No UI. No tracker flow. No plugin layer.

## Surface

`info`, `spawn`, `list`, `get`, `send`, `kill`

CLI commands reuse an already running daemon on the same configured `host`/`port`.

`spawn` has one form:

```bash
spur spawn <project> <prompt...> [--agent claude|codex] [--branch <name>]
```

Agents run with full access by default:

- `claude --dangerously-skip-permissions`
- `codex --dangerously-bypass-approvals-and-sandbox`

## Start

Build:

```bash
pnpm --dir v2 build
```

Config:

- Copy [`spur.yaml.example`](./spur.yaml.example) to `spur.yaml`
- Adjust project paths

Examples:

```bash
pnpm --dir v2 exec node dist/cli.js info --config spur.yaml
pnpm --dir v2 exec node dist/cli.js spawn backend-api "Fix the flaky auth test" --config spur.yaml
pnpm --dir v2 exec node dist/cli.js list --config spur.yaml
```

## Validate

- Scenarios: [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md)
