# Spur

Local daemon + CLI orchestrator. `v2/` ships the runtime. `packages/web/` is an optional UI over Spur's HTTP API.

## Installation

- npm: `npm install -g @shugaev/spur` — see [docs/install-from-npm.md](docs/install-from-npm.md) for systemd setup and first-run notes.

## Run From Source

```bash
pnpm --dir v2 build
node v2/dist/cli.js doctor
node v2/dist/cli.js list
node v2/dist/cli.js spawn <project> "your task"
```

Repo bootstrap for active development:

```bash
bash scripts/setup.sh
pnpm dev
```

`spur doctor` writes a local `spur.yaml` in the current repo. The first normal Spur command still auto-initializes `~/.spur/config.yaml`, and `spur list` / `spur spawn` auto-connect the local project config when present.

Full runtime reference lives in [v2/README.md](v2/README.md).

## Develop Spur

```bash
bash scripts/setup.sh
pnpm dev
spur doctor
```

Use [SETUP.md](SETUP.md) for repo bootstrap, local config, and web UI development. Use [CONTRIBUTING.md](CONTRIBUTING.md) for PR checks.

## Repo Surfaces

- `v2/` — Spur daemon, CLI, automation runtime, tests, config example
- `packages/web/` — Next.js UI over the Spur daemon API
- `scripts/setup.sh` — contributor bootstrap for local development and dogfooding
- `tests/integration/` — onboarding smoke environment
- `docs/ubuntu-vm-deploy.md` — deployment guide
- `spur.yaml` — repo-local project config for this checkout

## Docs

- [v2/README.md](v2/README.md) — Spur commands, config, automation, validation
- [SETUP.md](SETUP.md) — contributor bootstrap and local web UI development
- [CONTRIBUTING.md](CONTRIBUTING.md) — PR scope and required checks
- [docs/ubuntu-vm-deploy.md](docs/ubuntu-vm-deploy.md) — generic Ubuntu VM deploy and release guide
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — short fixes for common local failures
- [AGENTS.md](AGENTS.md) — repo-specific implementation rules

## License

MIT
