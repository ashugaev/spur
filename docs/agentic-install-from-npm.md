# Agentic install from npm

Official guide to run Spur on a fresh Linux server. The npm package ships the web UI prebuilt, so there is no on-box build. Maintainers doing source/dev deploys: see [ubuntu-vm-deploy.md](ubuntu-vm-deploy.md).

## What spur init sets up

`npm install -g` only unpacks the package into your npm prefix (default `~/.local`). It does not register systemd units, enable linger, start anything, or survive reboot. `spur init` installs two systemd user units:

| Unit                  | Role                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `spur-daemon.service` | HTTP API on `:4310`, tmux sessions                                                      |
| `spur-web.service`    | Web UI on `:4311`, terminal WebSocket in-process on `/ws` (same port, no separate unit) |

## Quick setup

```bash
# Node 20+ (fresh Ubuntu ships none; apt's is too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"

npm install -g @shugaev/spur@<version>
spur init

# an agent CLI, authenticated ON THIS HOST (required to spawn sessions)
npm install -g @openai/codex@latest
codex login   # or install Claude Code and run `claude` to sign in
```

Flags:

| Flag                | Effect                                          |
| ------------------- | ----------------------------------------------- |
| `--no-start`        | Install units + linger only; don't start        |
| `--expose-web`      | Bind web UI to `0.0.0.0` (default `127.0.0.1`)  |
| `--web-port <port>` | Web listen port (default `4311`)                |
| `--no-tailscale`    | Skip Tailscale setup (on by default; see below) |

`spur doctor` runs the same host checks and points at `spur init` when something is missing.

### Private access with Tailscale

`spur init` sets up private web-UI access over your own [Tailscale](https://tailscale.com) tailnet by default — your devices only, never public. Opt out with `--no-tailscale`.

It installs Tailscale if missing (best-effort), but auth is yours: run `sudo tailscale up` and sign in via the printed URL (`spur init` won't run it). Then re-run `spur init` — it resolves your tailnet IPv4 and widens `spur-web.service`'s `WEB_HOST` to `127.0.0.1,<tailnet-ip>`. Until the tailnet is up it stays loopback-only and prints the hint. `--expose-web` (public `0.0.0.0`) is a separate explicit override that supersedes Tailscale.

## Verify

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4311/             # 200
```

The web UI opens the terminal over `/ws` on the same port — no separate port or health check.

## Upgrade

```bash
npm install -g @shugaev/spur@<version>
spur init   # refresh units, then restart
```

Re-run `spur init` (or `spur update`), not just `systemctl restart`: a restart reuses old unit files. Crossing the in-process `/ws` change, the old `spur-web.service` still runs `server.js` and a dead `spur-direct-terminal.service` crash-loops. `spur init` rewrites the web unit (`ExecStart` → `web-server.js`, `HOSTNAME` → `WEB_HOST`), removes the stale terminal unit, and preserves your port/expose/Tailscale bind. Later same-topology upgrades can just restart both units. `install-and-restart.sh` and `POST /deploy/switch` restart only — they don't refresh units.

## Security

- Never copy `~/.spur/daemon.env`, project `.env`, API keys, SSH keys, or `NPM_TOKEN` between hosts.
- Create secrets on the target host only: `~/.spur/daemon.env` (mode `0600`), or `${VAR}` placeholders resolved from that host's env.
- Agent auth (Codex key, `gh auth login`) belongs on the target host only.

## Ports

| Service         | Bind        | Port |
| --------------- | ----------- | ---- |
| Daemon HTTP API | `127.0.0.1` | 4310 |
| Web UI          | `127.0.0.1` | 4311 |

## After install

`~/.spur/config.yaml` is created on first daemon start. Connect a project and smoke-test:

```bash
cd <your-repo> && ~/.local/bin/spur connect --config spur.yaml
~/.local/bin/spur list --json
~/.local/bin/spur spawn <project-id> --branch <branch> "smoke test" --json
```

## System-wide units (advanced)

`spur init` installs user units. For system scope (`/etc/systemd/system/`, `User=`, `/etc/spur/daemon.env`), adapt the templates in `deploy/*.npm.service` manually. For UI version switch on system units, set `SYSTEMCTL="sudo systemctl"` in the daemon env.

## Troubleshooting

| Symptom                             | Cause                                                      | Fix                                                        |
| ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Nothing listens after `npm install` | expected — npm does not start systemd                      | run `spur init`                                            |
| Units stop after SSH logout         | linger off                                                 | `loginctl enable-linger $USER`                             |
| `spur --version` runs wrong binary  | `PATH` picks another install                               | `~/.local/bin/spur`                                        |
| systemd `status=203/EXEC`           | npm prefix not `~/.local`                                  | reset prefix, reinstall                                    |
| stale system `codex` in sessions    | `/usr/bin` before `~/.local/bin`                           | npm-install codex; check unit PATH                         |
| Two daemons on `:4310`              | manual daemon + systemd                                    | kill manual; `systemctl --user restart spur-daemon`        |
| Web terminal `/ws` won't connect    | `spur-web.service` not running (in-process WS)             | `spur init` or `systemctl --user restart spur-web`         |
| Terminal `/ws` closes immediately   | `pty.node` prebuild missing for this host (non-glibc/non-x64) | UI unaffected, terminal disabled — file an issue with `uname -m`/libc |
| Web UI not reachable over Tailscale | tailnet not up yet                                         | `sudo tailscale up`, authenticate, then re-run `spur init` |
| `spur init` skipped Tailscale       | ran with `--no-tailscale`, or `--expose-web` superseded it | re-run without `--no-tailscale`/`--expose-web`             |
| `spur update` fails preflight for `terminal` | old updater (pre-#573) probes the removed terminal unit | run `spur update --force`                          |

## Reference

CLI details: [v2/README.md](../v2/README.md).
