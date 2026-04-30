# Spur

This repository has two supported product surfaces:

- `v2/` is the Spur daemon and CLI.
- `packages/web/` is an optional web UI that proxies to Spur's HTTP API.

## Quick Start

```bash
bash scripts/setup.sh
spur list
pnpm dev
```

The first Spur command auto-initializes the global instance config at `~/.spur/config.yaml`.
Use repo-local `spur.yaml` only for project definitions; `spur list` / `spur spawn` auto-connect it when present.
The web UI defaults to the instance `ui.port` from that same global config; the default is `5555`.

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
- `scripts/setup.sh` — bootstrap for local development and dogfooding
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

- [v2/README.md](v2/README.md) — Spur commands, config, automation, validation
- [SETUP.md](SETUP.md) — local repo setup and web UI development
- [docs/ubuntu-vm-deploy.md](docs/ubuntu-vm-deploy.md) — generic Ubuntu VM deploy and release guide
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — current failure modes and fixes
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution scope and required checks
- [AGENTS.md](AGENTS.md) — repo-specific implementation rules

## License

MIT
