# Setup

This file is only for the current repository shape:

- `v2/` contains Spur's daemon and CLI.
- `packages/web/` contains the optional UI over Spur's API.

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

The first Spur command auto-creates the global instance config at `~/.spur/config.yaml`.
Keep repo-local `spur.yaml` focused on `projects:` only. This repository also keeps a tracked root `spur.yaml` for dogfooding the repo itself. Use it only if its project settings match the checkout you are running.

## Run Spur

```bash
spur list
spur spawn <project> "your task"
```

`spur list` and `spur spawn` auto-connect the nearest local `spur.yaml` / `spur.yml` when present.

## Run the Web UI

```bash
pnpm dev
```

The web UI reads the global instance config by default and uses its `ui.port` value. The default UI port is `5555`.

For a production-like UI server:

```bash
pnpm ui:build
WEB_HOST=127.0.0.1 \
DIRECT_TERMINAL_BIND_HOST=127.0.0.1 \
DIRECT_TERMINAL_BIND_PORT=14801 \
DIRECT_TERMINAL_PUBLIC_PORT=3011 \
PORT=3011 \
pnpm ui:start
```

The UI is optional. It does not own runtime logic or persistence; it proxies to the daemon.
For reverse-proxy deployments, leave Next.js and the terminal server on loopback and advertise the proxy port with
`DIRECT_TERMINAL_PUBLIC_PORT`.

For a generic Ubuntu VM deployment and release flow, use [docs/ubuntu-vm-deploy.md](docs/ubuntu-vm-deploy.md).

For an explicit production update on a host that runs `spur-daemon.service` and `spur-web.service`:

```bash
pnpm main:deploy
```

That command deploys the latest `origin/main` from a dedicated release clone. It does not rely on the current checkout being clean or on `main`.

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
