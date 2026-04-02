# Setup

This file is only for the current repository shape:

- `v2/` contains Spur's daemon and CLI.
- `packages/web/` contains the optional UI over Spur's API.
- No AO/v1 backend, plugin registry, or mobile package remains in-tree.

For the actual Spur command/config reference, use [v2/README.md](v2/README.md).

## Prerequisites

- Node.js 20+
- Git 2.25+
- tmux
- `gh` is recommended for GitHub-backed workflows
- `claude` and/or `codex` are required only for real agent runs

## Bootstrap

```bash
bash scripts/setup.sh
spur --version
```

The setup script installs dependencies, builds `v2/` and `packages/web/`, and links the `spur` CLI globally.

If `spur` is not on your `PATH` afterward, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Config

Start from Spur's example config:

```bash
cp v2/spur.yaml.example spur.yaml
$EDITOR spur.yaml
```

This repository also keeps a tracked root `spur.yaml` for dogfooding the repo itself. Use it only if its project settings match the checkout you are running.

## Run Spur

```bash
SPUR_CONFIG=./spur.yaml spur daemon start
SPUR_CONFIG=./spur.yaml spur list
```

## Run the Web UI

```bash
SPUR_CONFIG=./spur.yaml \
SPUR_DAEMON_URL=http://127.0.0.1:4310 \
pnpm --dir packages/web dev
```

The UI is optional. It does not own runtime logic or persistence; it proxies to the daemon.

## Local Validation

Run the cheapest complete set that crosses your change boundary:

```bash
pnpm build
pnpm test
pnpm test:integration
```

When agent launch or prompt delivery changes:

```bash
pnpm --dir v2 test:smoke
```

## Repo Scope

When updating docs, scripts, or workflows outside `v2/`, keep them limited to:

- developing `v2/`
- running the optional `packages/web/` UI
- validating or dogfooding this repo

Do not add back `ao` configs, parallel examples, plugin docs, or alternate product surfaces.
