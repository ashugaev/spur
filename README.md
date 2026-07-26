# Spur

Local daemon + CLI orchestrator for AI coding agents.

- Spawns agents (`claude` / `codex` / `cursor`) in `tmux` sessions, using either an owned `git worktree` or the shared project path
- Watches sources (`cron`, `github`, `gitlab`, `sentry`, `service`, `telegram`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

## Install

Spur installs itself. Hand this to your coding agent and let it drive:

```text
Install and run Spur on this machine. It is an AI-agent orchestrator, npm package @shugaev/spur.
Read its install guide at https://github.com/ashugaev/spur/blob/main/docs/install-from-npm.md
(or docs/install-from-source.md to build from source) and follow it end to end: install the CLI,
run `spur init` to lay down the systemd user units, bring up the daemon and web UI bound to
loopback/Tailscale only (never 0.0.0.0), and verify with `spur doctor`. Configure this VM as the
guide describes. Do not ask me to run steps you can run yourself.
```

Tested on an Ubuntu VM. Other environments are not guaranteed to be smooth — expect to resolve host and infrastructure differences yourself.

Prefer to run it by hand? Follow [docs/install-from-npm.md](docs/install-from-npm.md) (npm, official) or [docs/install-from-source.md](docs/install-from-source.md) (from source).

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

MIT
