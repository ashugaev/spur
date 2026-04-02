# Troubleshooting

## `spur` not found after setup

`scripts/setup.sh` uses `npm link` from `v2/`. If your global npm bin directory is not on `PATH`, the link succeeds but the shell cannot find `spur`.

Check the prefix:

```bash
npm prefix -g
```

Then add its `bin/` directory to your shell profile.

## Web UI shows no projects

The UI reads project labels from a Spur config file. Set one of:

- `SPUR_CONFIG`
- `SPUR_CONFIG_PATH`

Example:

```bash
SPUR_CONFIG=./spur.yaml pnpm dev
```

## Web UI cannot reach the daemon

By default the UI calls `http://127.0.0.1:4310`.

Verify the daemon:

```bash
curl http://127.0.0.1:4310/info
```

If your config uses another port, start the UI with the matching daemon URL:

```bash
SPUR_DAEMON_URL=http://127.0.0.1:4311 pnpm dev
```

## `tmux` is missing

Spur's default runtime requires `tmux`. Install it, then rerun setup:

```bash
bash scripts/setup.sh
```

## CI or onboarding drift after repo cleanup

The supported root surfaces are only:

- `v2/`
- `packages/web/`
- the root docs/scripts/workflows that support them

If a workflow or script refers to `ao`, `agent-orchestrator.yaml`, `packages/mobile`, or a deleted plugin/package tree, it is stale and should be removed or rewritten.
