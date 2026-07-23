# Install from npm

> Agent-first doc: terse and command-dense so an AI agent can run it top to bottom. Human-runnable too — it stays readable where that costs the agent nothing.

Run Spur on a fresh Linux server. Package ships the web UI prebuilt — no on-box build. Dev/maintainer setup instead: [install-from-source.md](install-from-source.md).

Verified on Ubuntu 24.04 LTS, down to a ~1GB-RAM box (no swap). Needs Node 20+ (Ubuntu's apt build is too old — use nodesource or nvm).

## Requirements

- Lower bar 2 GB RAM, 2 cores — daemon, web UI, and a few parallel agent sessions.
- Scale by concurrent agents: each session is an agent process plus whatever it runs (dev servers, builds, test suites). Size RAM/cores to how many agents you keep working at once and how heavy their per-session environment is — Spur's own footprint is small.

## Setup

```bash
npm config set prefix ~/.local      # required — see gotchas
npm install -g @shugaev/spur@latest
spur init                           # installs + starts the systemd user units
```

Two non-obvious points:

- Prefix must be `~/.local`. A system prefix (`/usr`) fails install with `EACCES` and makes the units exec the wrong path (`status=203/EXEC`). Put `~/.local/bin` on PATH and persist it for new logins so bare `spur` resolves.
- `npm install` only unpacks — it starts nothing and won't survive reboot. `spur init` installs the units, starts them, and enables linger.

Units installed:

| Unit                  | Role                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `spur-daemon.service` | HTTP API `:4310`, tmux sessions                                                 |
| `spur-web.service`    | Web UI `:4311`; terminal WebSocket in-process on `/ws` (same port, no own unit) |

Then install one agent CLI and authenticate it on this host (required to spawn sessions):

```bash
npm install -g @openai/codex && codex login    # or Claude Code: install it, run `claude`, sign in
```

`spur doctor` diagnoses host setup and points at what's missing.

### init flags

| Flag                | Effect                                      |
| ------------------- | ------------------------------------------- |
| `--no-start`        | install units + linger, don't start         |
| `--expose-web`      | bind web to `0.0.0.0` (default `127.0.0.1`) |
| `--web-port <port>` | web port (default `4311`)                   |
| `--no-tailscale`    | skip Tailscale (on by default)              |

## Private access (Tailscale, default on)

`spur init` sets up private web access over your tailnet — your devices only, never public. Opt out with `--no-tailscale`.

Auth is yours — two ways to bring the tailnet up:

- Human: `sudo tailscale up`, sign in at the printed URL.
- Unattended (agent / scripted): `sudo tailscale up --authkey <tskey-...>` — no browser. Mint a key at `https://login.tailscale.com/admin/settings/keys`. This login is the only step that otherwise blocks a hands-off install; an agent handed a key does the whole thing end to end.

Then re-run `spur init` — it resolves your tailnet IPv4 and widens `spur-web`'s `WEB_HOST` to `127.0.0.1,<tailnet-ip>`. Until the tailnet is up it stays loopback-only. `--expose-web` (public `0.0.0.0`) is a separate explicit override that supersedes Tailscale.

## Verify

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4311/           # 200
```

Terminal rides `/ws` on the web port — no separate port or check.

## Connect a project

```bash
cd <repo>
spur connect --config spur.yaml
spur spawn <project-id> --branch <branch> "smoke test" --json
```

## Upgrade

```bash
npm install -g @shugaev/spur@latest
spur init      # or: spur update
```

Re-run `spur init` / `spur update`, not a bare `systemctl restart`: restart reuses the old unit files, and unit contracts change across versions (e.g. the `/ws` move rewrote `spur-web`'s `ExecStart` and dropped a now-removed terminal unit). `install-and-restart.sh` and `POST /deploy/switch` restart only — they don't refresh units.

## Security

- Secrets stay on this host: `~/.spur/daemon.env` (mode `0600`), or `${VAR}` placeholders resolved from its env. Never copy them between hosts.
- Agent auth (`codex login`, `gh auth login`) belongs on this host only.

## Troubleshooting

| Symptom                                                | Fix                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `status=203/EXEC` or `EACCES .../usr/lib/node_modules` | npm prefix isn't `~/.local` — reset it, reinstall                                     |
| units die after SSH logout                             | linger off: `loginctl enable-linger $USER`                                            |
| web terminal `/ws` won't connect                       | `spur-web` not running: `spur init` or `systemctl --user restart spur-web`            |
| `/ws` closes immediately                               | no `pty.node` prebuild for this arch/libc — terminal disabled, UI fine; file an issue |
| web unreachable over Tailscale                         | tailnet not up: `sudo tailscale up`, then re-run `spur init`                          |

## System-wide units (advanced)

`spur init` installs user units. For system scope (`/etc/systemd/system/`, `User=`), adapt `deploy/spur-daemon.service` / `deploy/spur-web.service` and set `SYSTEMCTL="sudo systemctl"` in the daemon env. Don't run `spur update` / `spur reinit` on a system-unit host — both take the user-scope path and spin up a conflicting `:4310` daemon; restart the system units directly, and re-copy the templates when a version changes the unit contract.

## Reference

CLI and config: [README.md](../README.md).
