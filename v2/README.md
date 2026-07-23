# @shugaev/spur

Spur is a lean orchestrator for AI coding agents: a local daemon, tmux-backed sessions, and per-project workspaces. Spawn Claude Code / Codex / Cursor sessions, drive them from a CLI or web UI, and manage them across projects.

## Install

```bash
npm install -g @shugaev/spur
spur init
```

`npm install -g` only unpacks the package; `spur init` installs the systemd user units (daemon on `:4310`, web UI on `:4311`). Fresh Linux server walkthrough — Node setup, systemd, Tailscale — in the install guide below.

## Docs

Full documentation lives in the repository (not shipped in this package):

- [Install from npm (official)](https://github.com/ashugaev/spur/blob/main/docs/install-from-npm.md)
- [Install from source](https://github.com/ashugaev/spur/blob/main/docs/install-from-source.md)
- [CLI, config, and architecture reference](https://github.com/ashugaev/spur/blob/main/README.md)

Repository: https://github.com/ashugaev/spur
