# Install Spur from npm

This is the official guide to install Spur on a fresh Linux server (e.g. Ubuntu 24.04). The npm package ships the web UI prebuilt — there is no on-box build step, so the install works on a minimal 1 GB VM (e.g. GCP e2-micro) with no swap. Maintainers doing source/dev deploys: see [ubuntu-vm-deploy.md](ubuntu-vm-deploy.md).

## npm install does not start services

`npm install -g` only downloads the package into your npm prefix (by default `~/.local`). It does **not**:

- register systemd units
- enable `loginctl linger`
- start the daemon or web UI
- survive reboot by itself

On Ubuntu (and most Linux distros), long-running Spur processes are managed by **two systemd user units** installed by `spur init`:

| Unit                  | Role                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `spur-daemon.service` | HTTP API on `:4310`, tmux sessions                                                                 |
| `spur-web.service`    | Web UI on `:4311`, serves the terminal WebSocket in-process on `/ws` (same port, no separate unit) |

`npm install -g` alone does not register or start either of them.

## Quick setup

```bash
# Node 20+ is required — fresh Ubuntu ships no node/npm, and apt's nodejs is v18
# (below the ^20.19 || ^22.13 || >=24 engine requirement).
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # expect v20.x or later

npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"

npm install -g @shugaev/spur@<version>

# one-time host setup: units + linger + start
spur init

# install an agent CLI and authenticate it ON THIS HOST (required to spawn sessions)
npm install -g @openai/codex@latest
codex login          # or install Claude Code and run `claude` to sign in
```

Options:

| Flag                | Effect                                                         |
| ------------------- | -------------------------------------------------------------- |
| `--no-start`        | Install units and linger only; do not enable/start services    |
| `--expose-web`      | Bind web UI to `0.0.0.0` (default `127.0.0.1`)                 |
| `--web-port <port>` | Web listen port (default `4311`)                               |
| `--no-tailscale`    | Skip Tailscale private-access setup (see below; on by default) |

`spur doctor` runs the same host checks and suggests `spur init` when something is missing.

### Private access with Tailscale

By default, `spur init` sets up private remote access to the web UI over your own [Tailscale](https://tailscale.com) tailnet — reachable only from your own devices, never the public internet. Decline it with `spur init --no-tailscale` (web UI stays on `127.0.0.1` only).

What happens:

1. `spur init` installs Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`) if the `tailscale` command isn't already on the host. This step is best-effort — if it fails, `spur init` continues without it.
2. You authenticate the host on your tailnet yourself: `sudo tailscale up`, then open the printed URL in a browser and sign in. This is a user-side interactive gate (like agent CLI login) — `spur init` cannot do this for you and does not run `sudo tailscale up` itself.
3. Re-run `spur init` once the tailnet is up. It resolves your tailnet IPv4 address and widens `spur-web.service`'s `WEB_HOST` to `127.0.0.1,<tailnet-ip>` — the web UI now also serves on that address, reachable only within your tailnet.

If the tailnet isn't up yet when `spur init` runs, it leaves `WEB_HOST` on `127.0.0.1` only and prints the `sudo tailscale up` hint instead of failing.

`--expose-web` (bind to `0.0.0.0`, reachable from the public internet) is a separate, more permissive, explicit override — it supersedes Tailscale and is not the recommended default. Tailscale (loopback + tailnet, never public) is the recommended safe default for remote access.

Verify:

```bash
systemctl --user is-active spur-daemon.service spur-web.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4311/             # 200
```

The web UI at `http://127.0.0.1:4311/` opens the terminal over `/ws` on the
same port — no separate port or health check needed.

Upgrade (units already installed):

```bash
npm install -g @shugaev/spur@<version>
systemctl --user restart spur-daemon.service spur-web.service
```

Or use `scripts/install-and-restart.sh <version>` (same steps, logs to `~/.spur/logs/install-and-restart.log`). When the running daemon supports it, `POST /deploy/switch` invokes that script.

On Linux, `npm install -g` may ship `node-pty` without a native binding; `spur-web.service`'s `ExecStartPre` builds it when missing. After a manual `npm install -g`, restart both units so the in-process terminal reloads `node-pty`.

## Security

- Never copy `~/.spur/daemon.env`, project `.env` files, API keys, SSH keys, or `NPM_TOKEN` from another host.
- Never `scp` / `rsync` credential material between machines.
- Secrets on the target host only: create `~/.spur/daemon.env` on that machine (mode `0600`) with values that belong there, or `${VAR}` placeholders resolved from that host's environment.
- Project repos may symlink `.env` in `spur.yml`; those files must already exist in the target repo checkout.
- Agent auth (Codex API key, `gh auth login`, etc.) must be configured on the target host only.

## Prerequisites

```bash
node -v    # require ^20.19 || ^22.13 || >=24 (see package engines)
npm -v
systemctl --user status >/dev/null 2>&1 && echo user-systemd-ok
command -v tmux git node npm
```

Install `tmux`/`git` with the host's package manager if missing. For Node, use the NodeSource/nvm step in Quick setup above — apt's packaged `nodejs` on Ubuntu 24.04 is v18, below the required engine range.

## Ports

| Service         | Bind (default) | Port |
| --------------- | -------------- | ---- |
| Daemon HTTP API | `127.0.0.1`    | 4310 |
| Web UI          | `127.0.0.1`    | 4311 |

Override the web port with `spur init --web-port <port>` if `:4311` is taken or you front Spur with an existing reverse proxy.

## Manual setup (what `spur init` does)

Use this when you need full control or automation cannot run the script.

### 1. npm prefix

User unit templates hardcode `%h/.local/lib/node_modules/@shugaev/spur`.

```bash
npm config set prefix ~/.local
grep -q '$HOME/.local/bin' ~/.profile 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.local/bin:$PATH"
```

### 2. Install package

```bash
npm install -g @shugaev/spur@<version>
```

### 3. Install agents (for spawning sessions)

```bash
npm install -g @openai/codex@latest
```

Configure auth on this host only (`codex login` or `OPENAI_API_KEY` in `~/.spur/daemon.env`). The shipped daemon unit sets `PATH=%h/.local/bin:...` so tmux resolves npm-installed agents.

### 4. Copy systemd user units

```bash
PKG=~/.local/lib/node_modules/@shugaev/spur
mkdir -p ~/.config/systemd/user
install -m 644 "$PKG/deploy/spur-daemon.npm.service" ~/.config/systemd/user/spur-daemon.service
install -m 644 "$PKG/deploy/spur-web.npm.service"    ~/.config/systemd/user/spur-web.service
systemctl --user daemon-reload
```

### 5. Linger

```bash
loginctl enable-linger "$USER"
```

Required on SSH/headless hosts so units survive logout.

### 6. Daemon secrets (optional)

```bash
install -d -m 700 ~/.spur
install -m 600 /dev/null ~/.spur/daemon.env
```

Unit loads `EnvironmentFile=-~/.spur/daemon.env` (missing file is OK).

### 7. Start services

```bash
systemctl --user enable --now spur-daemon.service spur-web.service
```

Stop any manual `spur daemon start` first — only one process may bind `:4310`.

## After install

**Instance config** — `~/.spur/config.yaml` is created on first daemon start, not by `spur doctor`.

**Connect a project:**

```bash
cd <your-repo>
~/.local/bin/spur connect --config spur.yaml
```

`connect` registers the project in `~/.spur/config-registry.json`.

**Smoke test:**

```bash
~/.local/bin/spur list --json
~/.local/bin/spur spawn <project-id> --branch <branch> "smoke test" --json
```

## System-wide units (advanced)

`spur init` installs **user** units (`systemctl --user`). Some hosts use **system** units under `/etc/systemd/system/` with `User=` and `/etc/spur/daemon.env` — that layout is not created by npm or `spur init`. Adapt the templates in `deploy/*.npm.service` manually if you need system scope.

For UI version switch (`POST /deploy/switch`) on system units, set in `/etc/spur/daemon.env` (or `~/.spur/daemon.env` for user units):

```bash
SYSTEMCTL=sudo systemctl
```

`install-and-restart.sh` reads `SYSTEMCTL` from the environment when the daemon spawns it.

## Troubleshooting

| Symptom                                 | Cause                                                      | Fix                                                                   |
| --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Nothing listens after `npm install`     | expected — npm does not start systemd                      | run `spur init`                                                       |
| Units stop after SSH logout             | linger off                                                 | `loginctl enable-linger $USER`                                        |
| `spur --version` runs wrong binary      | `PATH` picks another install                               | `~/.local/bin/spur`                                                   |
| systemd `status=203/EXEC`               | npm prefix not `~/.local`                                  | step 1, reinstall                                                     |
| stale system `codex` in sessions        | `/usr/bin` before `~/.local/bin`                           | npm-install codex; check PATH in unit                                 |
| Codex login prompt                      | no agent auth on host                                      | `codex login` or API key locally                                      |
| Two daemons on `:4310`                  | manual daemon + systemd                                    | kill manual; `systemctl --user restart spur-daemon`                   |
| Project missing in UI                   | config not connected                                       | `spur connect --config`                                               |
| Web terminal `/ws` 404 or won't connect | `spur-web.service` not running (in-process WS)             | `spur init` or `systemctl --user restart spur-web`                    |
| Terminal connects then closes           | `node-pty` not built on Linux                              | restart `spur-web.service` (`ExecStartPre` runs the build)            |
| UI switch "not confirmed"               | `systemctl --user` on system units                         | set `SYSTEMCTL=sudo systemctl` in daemon env                          |
| Web UI not reachable over Tailscale     | tailnet not up yet                                         | `sudo tailscale up`, authenticate in browser, then re-run `spur init` |
| `spur init` skipped Tailscale setup     | ran with `--no-tailscale`, or `--expose-web` superseded it | re-run `spur init` without `--no-tailscale`/`--expose-web`            |

## Reference

CLI details: [v2/README.md](../v2/README.md).
