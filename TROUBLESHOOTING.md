# Troubleshooting

## `spur` not found after setup

`scripts/setup.sh` uses `npm link` from `v2/`. If your global npm bin directory is not on `PATH`, the link succeeds but the shell cannot find `spur`.

Check the prefix:

```bash
npm prefix -g
```

Then add its `bin/` directory to your shell profile.

## Web UI shows no projects

The UI reads project labels from the daemon's `/projects` response, not from a local repo file.
Verify that the repo has been connected to the active Spur instance:

```bash
spur connect
spur list
```

If you use multiple instance configs, point both CLI and web at the same global config:

```bash
SPUR_CONFIG=~/.spur/config.yaml pnpm dev
```

## Web UI cannot reach the daemon

By default the UI resolves the daemon URL from the active global Spur config (`~/.spur/config.yaml`), then falls back to `http://127.0.0.1:4310`.

Verify the daemon:

```bash
curl http://127.0.0.1:4310/info
```

If your config uses another port, either update the global config or override the URL explicitly:

```bash
SPUR_DAEMON_URL=http://127.0.0.1:4311 pnpm dev
```

## Terminal opens locally but fails through a reverse proxy

When the direct terminal server is bound to loopback behind a proxy, set:

```bash
DIRECT_TERMINAL_BIND_HOST=127.0.0.1
DIRECT_TERMINAL_BIND_PORT=14801
DIRECT_TERMINAL_PUBLIC_PORT=<public-port>
```

`DIRECT_TERMINAL_PUBLIC_PORT` must match the externally reachable proxy port that serves `/ws`.

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
