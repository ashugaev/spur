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
SPUR_DAEMON_URL=http://127.0.0.1:4311 pnpm dev
```

## `tmux` is missing

Spur's default runtime requires `tmux`. Install it, then rerun setup:

```bash
bash scripts/setup.sh
```
