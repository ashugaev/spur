# Spur

This repository has two supported product surfaces:

- `v2/` is the Spur daemon and CLI.
- `packages/web/` is an optional web UI that proxies to Spur's HTTP API.

The old AO/v1 backend, mobile app, plugin tree, example configs, and parallel docs have been removed from the repo. Runtime behavior lives in `v2/`. The web package stays a thin view layer over that daemon.

## Quick Start

```bash
bash scripts/setup.sh
cp v2/spur.yaml.example spur.yaml
SPUR_CONFIG=./spur.yaml spur daemon start
SPUR_CONFIG=./spur.yaml pnpm dev
```

If the daemon is not running on `http://127.0.0.1:4310`, set `SPUR_DAEMON_URL` before starting the web UI.

For a production-like UI server:

```bash
pnpm ui:build
SPUR_CONFIG=./spur.yaml \
SPUR_DAEMON_URL=http://127.0.0.1:4310 \
DIRECT_TERMINAL_PORT=14801 \
PORT=3011 \
pnpm ui:start
```

The web package also reads `SPUR_CONFIG` (or `SPUR_CONFIG_PATH`) to populate project filters and branding from a real Spur config.

## Repo Layout

- `v2/` — Spur daemon, CLI, automation runtime, tests, config example
- `packages/web/` — Next.js UI over the Spur daemon API
- `scripts/setup.sh` — bootstrap for local development and dogfooding
- `tests/integration/` — onboarding smoke environment
- `spur.yaml` — repo-local dogfood config for this checkout

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
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — current failure modes and fixes
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution scope and required checks
- [docs/architecture-v2.md](docs/architecture-v2.md) — high-level architecture intent
- [AGENTS.md](AGENTS.md) — repo-specific implementation rules

## License

MIT
