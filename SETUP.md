# Setup

Contributor bootstrap for this repo.

For package install, first run, runtime behavior, and deployment, use [v2/README.md](v2/README.md).

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

The setup script installs repo dependencies, builds `v2/`, and links the local `spur` CLI globally for dogfooding. It is not the primary product install path.

If `spur` is not on your `PATH` afterward, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Local Config

Start from Spur's example config:

```bash
cp v2/spur.yaml.example spur.yaml
$EDITOR spur.yaml
```

The first Spur command auto-creates the global instance config at `~/.spur/config.yaml`.
Keep repo-local `spur.yaml` focused on `projects:` only. This repository also keeps a tracked root `spur.yaml` for dogfooding the repo itself. Use it only if its project settings match the checkout you are running.

## Run This Repo

```bash
spur list
spur spawn <project> "your task"
pnpm dev
```

`spur list` and `spur spawn` auto-connect the nearest local `spur.yaml` / `spur.yml` when present.
`pnpm dev` starts the optional web UI against the active Spur daemon config. Use [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if the UI cannot see projects or reach the daemon.

## Before A PR

Required checks live in [CONTRIBUTING.md](CONTRIBUTING.md).
