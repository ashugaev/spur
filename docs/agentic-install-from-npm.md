# Agentic install from npm

Official guide to run Spur on a fresh Linux server. The npm package ships the web UI prebuilt, so there is no on-box build. Maintainers doing source/dev deploys: see [ubuntu-vm-deploy.md](ubuntu-vm-deploy.md).

Tested on Ubuntu 24.04 LTS (Noble), down to the smallest e2-micro-class VM (~1GB RAM, no swap). Other distros and versions may work but are unverified; use them at your own risk.

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

npm install -g @shugaev/spur@latest   # or pin a specific version: @shugaev/spur@<version>
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
npm install -g @shugaev/spur@latest   # or pin a specific version: @shugaev/spur@<version>
spur init   # refresh units, then restart
```

Re-run `spur init` (or `spur update`), not just `systemctl restart`: a restart reuses old unit files. Crossing the in-process `/ws` change, the old `spur-web.service` still runs `server.js` and a dead `spur-direct-terminal.service` crash-loops. `spur init` rewrites the web unit (`ExecStart` → `web-server.js`, `HOSTNAME` → `WEB_HOST`), removes the stale terminal unit, and preserves your port/expose/Tailscale bind. Later same-topology upgrades can just restart both units. `install-and-restart.sh` and `POST /deploy/switch` restart only — they don't refresh units.

## Recovering a stuck host (manual migration)

Hosts on a pre-0.24.3 installer run `npm install -g` without `--prefix`. If the host's ambient npm prefix resolves outside the Spur install root (a system service env with no `npm_config_prefix` resolves to `/usr`), install fails with `EACCES mkdir /usr/lib/node_modules/@shugaev` and the host stays on the old version. The old installer can never ship its own fix — the upgrade must be applied once by hand, pinning the prefix to the real install root.

User units (default `spur init` scope):

```bash
npm_config_prefix="$HOME/.local" npm install -g @shugaev/spur@<version>
npm_config_prefix="$HOME/.local" ~/.local/bin/spur reinit
```

System units (`User=`, `/etc/systemd/system/`, `SYSTEMCTL="sudo systemctl"`):

```bash
npm_config_prefix="$HOME/.local" npm install -g @shugaev/spur@<version>
sudo systemctl restart spur-daemon.service spur-web.service
```

Do not run `spur reinit` or `spur update` on a system-unit host: both take the user-scope path (`npm-init.sh` + `systemctl --user`), which writes user units and starts a second daemon on `:4310` conflicting with the system one. On system units, update via the UI (`POST /deploy/switch`) or the manual commands above, and restart the system units directly.

Verify:

```bash
~/.local/bin/spur --version                                                # <version>
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions  # 200
ls /usr/lib/node_modules/@shugaev 2>/dev/null && echo LEAKED || echo clean # clean
```

Once the host runs 0.24.3 or later the prefix bug is gone: `install-and-restart.sh` (UI deploy/switch) and `spur update` both pin `--prefix` from the install location, so no `EACCES` on future installs. See [System-wide units](#system-wide-units-advanced) for the two remaining system-scope caveats (which update command to use, and refreshing unit files).

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

`spur init` installs user units. For system scope (`/etc/systemd/system/`, `User=`, `/etc/spur/daemon.env`), adapt the templates in `deploy/spur-daemon.service` and `deploy/spur-web.service` manually. For UI version switch on system units, set `SYSTEMCTL="sudo systemctl"` in the daemon env — then `install-and-restart.sh` skips the user-scope `spur reinit` and runs `sudo systemctl restart` instead.

Updating a system-unit host:

- Use the UI version switch (`POST /deploy/switch`) or a manual pinned install (see [Recovering a stuck host](#recovering-a-stuck-host-manual-migration)). Never `spur update` / `spur reinit` — they are user-scope and will spin up a conflicting `:4310` daemon.
- Neither path rewrites unit files. When a Spur version changes the unit contract (`ExecStart`, a newly required `Environment=`, a removed unit), the system units go stale and a plain restart runs the new code against the old unit. Re-copy the changed `deploy/spur-*.service` template into `/etc/systemd/system/`, keep your host's `User=`/`WEB_HOST`/`PORT`/`EnvironmentFile`, then `sudo systemctl daemon-reload && sudo systemctl restart spur-daemon.service spur-web.service`. (This is what the `/ws` topology change — `server.js` → `web-server.js`, dropped `spur-direct-terminal.service` — required.)

## Troubleshooting

| Symptom                                                                         | Cause                                                                                                                                   | Fix                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Nothing listens after `npm install`                                             | expected — npm does not start systemd                                                                                                   | run `spur init`                                                                                          |
| Units stop after SSH logout                                                     | linger off                                                                                                                              | `loginctl enable-linger $USER`                                                                           |
| `spur --version` runs wrong binary                                              | `PATH` picks another install                                                                                                            | `~/.local/bin/spur`                                                                                      |
| systemd `status=203/EXEC`                                                       | npm prefix not `~/.local`                                                                                                               | reset prefix, reinstall                                                                                  |
| stale system `codex` in sessions                                                | `/usr/bin` before `~/.local/bin`                                                                                                        | npm-install codex; check unit PATH                                                                       |
| Two daemons on `:4310`                                                          | manual daemon + systemd                                                                                                                 | kill manual; `systemctl --user restart spur-daemon`                                                      |
| Web terminal `/ws` won't connect                                                | `spur-web.service` not running (in-process WS)                                                                                          | `spur init` or `systemctl --user restart spur-web`                                                       |
| Terminal `/ws` closes immediately                                               | `pty.node` prebuild missing for this host (non-glibc/non-x64)                                                                           | UI unaffected, terminal disabled — file an issue with `uname -m`/libc                                    |
| Web UI not reachable over Tailscale                                             | tailnet not up yet                                                                                                                      | `sudo tailscale up`, authenticate, then re-run `spur init`                                               |
| `spur init` skipped Tailscale                                                   | ran with `--no-tailscale`, or `--expose-web` superseded it                                                                              | re-run without `--no-tailscale`/`--expose-web`                                                           |
| `spur update` fails preflight for `terminal`                                    | old updater (pre-#573) probes the removed terminal unit                                                                                 | run `spur update --force`                                                                                |
| Web down after a UI version switch (`/deploy/switch`) on a pre-#573 host        | deploy/switch restarts only; a stale pre-#573 `spur-web.service` keeps its `ExecStartPre` node-pty build, which fails with no toolchain | run `spur init` (or `spur update`) once to refresh the unit                                              |
| `EACCES mkdir /usr/lib/node_modules/@shugaev` on deploy/switch or `spur update` | host on a pre-0.24.3 installer; ambient npm prefix resolves to `/usr`                                                                   | one-time manual pinned install, see [Recovering a stuck host](#recovering-a-stuck-host-manual-migration) |

## Reference

CLI details: [v2/README.md](../v2/README.md).
