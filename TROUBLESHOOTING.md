# Troubleshooting

## `spur` not found after install or setup

Package installs and contributor setup both use your global npm bin directory.

Check the prefix:

```bash
npm prefix -g
```

Then add its `bin/` directory to your shell profile.

## Web UI shows no projects

The UI reads project labels from the daemon's `/projects` response. Verify that the repo has been auto-connected to the active Spur instance:

```bash
spur list
```

If you need to attach a specific local config file manually:

```bash
spur connect /path/to/spur.yaml
```

If you use multiple instance configs, point both CLI and web at the same global config:

```bash
SPUR_CONFIG=~/.spur/config.yaml pnpm dev
```

## Web UI cannot reach the daemon

By default the UI resolves the daemon URL from the active global Spur config, then falls back to `http://127.0.0.1:4310`.

Verify the daemon:

```bash
curl http://127.0.0.1:4310/info
```

If your config uses another port, either update the global config or override the URL explicitly:

```bash
SPUR_DAEMON_URL=http://127.0.0.1:4400 pnpm dev
```

## `tmux` is missing

Spur's default runtime requires `tmux`. Install it, then rerun setup:

```bash
bash scripts/setup.sh
```

## Session stays `spawning` with a shell prompt in the pane

The agent launches through your login + interactive shell rc (`$SHELL -lic`). An rc prompt on startup (oh-my-zsh `Would you like to update? [Y/n]`) blocks it. Answer in the session's web terminal before the agent's ready timeout, or the spawn fails. Permanent fix: your rc tool's non-interactive update mode.

## Codex reviewer cannot run commands or write QA output

- Inspect reviewer [spawn configuration](docs/configuration.md#field-reference) for `restrictWrites: true` at spawn or block level; also check [CLI spawn](docs/commands.md#spawn) restrictions.
- A read-only write rejection is expected with restrictions enabled.
- A `bwrap` / `RTM_NEWADDR` error before command execution indicates host sandbox startup failure.
- Preserve intentional restrictions and repair host sandbox support. For operator-approved full access, set `restrictWrites: false` on the Codex spawn block; this bypasses Codex sandbox and approval checks, granting host command and file access.
- Keep reviewer source-edit policy separate from disposable QA/evidence writes; verify command execution and artifact write/read/cleanup.
- Reload with [connect](docs/commands.md#connect-disconnect), then launch a new reviewer. Existing sessions retain stored restrictions, including on restore.
