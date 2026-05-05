# Spur

This repository has two supported product surfaces:

- `v2/` is the Spur daemon and CLI.
- `packages/web/` is an optional web UI that proxies to Spur's HTTP API.

## Quick Start

```bash
npm pack ./v2
npm install -g ./composio-spur-<version>.tgz
spur doctor
spur list
spur spawn <project> "your task"
```

Registry package install uses the same command shape when a published release exists:

```bash
npm install -g @composio/spur
```

`spur doctor` writes a local `spur.yaml` at the git repo root for the current checkout. It does not
create `~/.spur/config.yaml`. The first normal Spur command still auto-initializes that global
instance config, and `spur list` / `spur spawn` auto-connect the local project config when present.

The web UI is optional. It defaults to the instance `ui.port` from that same global config; the default is `5555`.

## Contributor Setup

Use the repo bootstrap only when developing Spur itself:

```bash
bash scripts/setup.sh
pnpm dev
```

That path installs repo dependencies, builds `v2/`, and links the local CLI for dogfooding.
Contributor setup details live in [SETUP.md](SETUP.md).

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

For reverse-proxy deployments, keep the Next.js app and direct terminal server bound to loopback and set
`DIRECT_TERMINAL_PUBLIC_PORT` to the externally reachable proxy port.

For an explicit production update on a host that runs `spur-daemon.service` and `spur-web.service`:

```bash
pnpm main:deploy
```

`pnpm main:deploy` syncs a dedicated release clone to the latest `origin/main`, builds there, restarts the services only after a successful build, and records the last successfully deployed SHA.

## Repo Layout

- `v2/` — Spur daemon, CLI, automation runtime, tests, config example
- `packages/web/` — Next.js UI over the Spur daemon API
- `scripts/setup.sh` — contributor bootstrap for local development and dogfooding
- `scripts/main-deploy.sh` — deploys the latest `origin/main` from a dedicated release clone on a production host
- `tests/integration/` — onboarding smoke environment
- `spur.yaml` — repo-local project config for this checkout

## Validation

```bash
pnpm build
pnpm test
pnpm test:integration
```

When agent launch or prompt delivery changes, also run:

```bash
pnpm --dir v2 test:smoke
```

## Docs

- [v2/README.md](v2/README.md) — Spur install, commands, config, automation, validation
- [SETUP.md](SETUP.md) — contributor bootstrap and web UI development
- [docs/ubuntu-vm-deploy.md](docs/ubuntu-vm-deploy.md) — generic Ubuntu VM deploy and release guide
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — current failure modes and fixes
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution scope and required checks
- [AGENTS.md](AGENTS.md) — repo-specific implementation rules

## License

MIT
