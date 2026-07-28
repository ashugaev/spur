# Spur

Local daemon + CLI orchestrator for AI coding agents.

- Spawns agents (`claude` / `codex` / `cursor`) in `tmux` sessions, using either an owned `git worktree` or the shared project path
- Watches sources (`cron`, `github`, `gitlab`, `sentry`, `service`, `telegram`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

## Install

Spur installs itself. Hand this to your coding agent:

```text
Read https://github.com/ashugaev/spur/blob/main/docs/install-from-npm.md and install and run
Spur on this machine end to end, following the guide. Do the steps yourself; don't ask me to run
what you can run.
```

Everything — ports, Tailscale, verification — is in that guide. Tested on Ubuntu; elsewhere, expect to sort out host differences yourself.

By hand: [docs/install-from-npm.md](docs/install-from-npm.md) (npm) · [docs/install-from-source.md](docs/install-from-source.md) (source).

## Docs

- [docs/commands.md](docs/commands.md) — CLI reference (spawn, wake, list, service, sidecars)
- [docs/configuration.md](docs/configuration.md) — config layers, fields, sources/triggers, events
- [docs/voice.md](docs/voice.md) — voice input setup
- [docs/install-from-npm.md](docs/install-from-npm.md) — install from npm (official)
- [docs/install-from-source.md](docs/install-from-source.md) — install from source
- [SETUP.md](SETUP.md) — contributor bootstrap and local web UI development
- [CONTRIBUTING.md](CONTRIBUTING.md) — PR scope and required checks
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — fixes for common local failures
- [SECURITY.md](SECURITY.md) — reporting and network posture
- [AGENTS.md](AGENTS.md) — repo-specific implementation rules

## Repo layout

- `v2/` — Spur daemon, CLI, automation runtime, tests, config example
- `packages/web/` — Next.js UI over the Spur daemon API
- `scripts/setup.sh` — contributor bootstrap
- `tests/integration/` — onboarding smoke environment
- `spur.yaml` — repo-local project config for this checkout

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
