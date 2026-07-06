# Install Spur from npm

Install `@shugaev/spur` on a Linux host without cloning the repo.

## npm install does not start services

`npm install -g` only downloads the package into your npm prefix (by default `~/.local`). It does **not**:

- register systemd units
- enable `loginctl linger`
- start the daemon or web UI
- survive reboot by itself

On Ubuntu (and most Linux distros), long-running Spur processes are managed by **systemd user units** you install once per host. After every `npm install -g`, the binary updates; units keep pointing at `%h/.local/lib/node_modules/@shugaev/spur` and pick up the new version on restart.

## Quick setup

```bash
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"

npm install -g @shugaev/spur@<version>

# one-time host setup: units + linger + start
spur init
```

Options:

| Flag                | Effect                                                      |
| ------------------- | ----------------------------------------------------------- |
| `--no-start`        | Install units and linger only; do not enable/start services |
| `--expose-web`      | Bind web UI to `0.0.0.0` (default `127.0.0.1`)              |
| `--web-port <port>` | Web listen port (default `4311`)                            |

`spur doctor` runs the same host checks and suggests `spur init` when something is missing.

Verify:

```bash
systemctl --user is-active spur-daemon.service spur-web.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4311/             # 200
```

Upgrade (units already installed):

```bash
npm install -g @shugaev/spur@<version>
systemctl --user restart spur-daemon.service spur-web.service
```

Or use `scripts/install-and-restart.sh <version>` (same steps, logs to `~/.spur/logs/install-and-restart.log`). When the running daemon supports it, `POST /deploy/switch` invokes that script.

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

Install anything missing with the host's package manager before continuing.

## Ports (default npm layout)

| Service         | Bind (default) | Port |
| --------------- | -------------- | ---- |
| Daemon HTTP API | `127.0.0.1`    | 4310 |
| Web UI          | `127.0.0.1`    | 4311 |

Source-deploy layouts may use different ports (e.g. nginx front `:5555`, web `:3012`). Override with `spur init --web-port` when fronting with an existing reverse proxy.

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

## Troubleshooting

| Symptom                             | Cause                                 | Fix                                                 |
| ----------------------------------- | ------------------------------------- | --------------------------------------------------- |
| Nothing listens after `npm install` | expected — npm does not start systemd | run `spur init`                                     |
| Units stop after SSH logout         | linger off                            | `loginctl enable-linger $USER`                      |
| `spur --version` runs wrong binary  | `PATH` picks another install          | `~/.local/bin/spur`                                 |
| systemd `status=203/EXEC`           | npm prefix not `~/.local`             | step 1, reinstall                                   |
| stale system `codex` in sessions    | `/usr/bin` before `~/.local/bin`      | npm-install codex; check PATH in unit               |
| Codex login prompt                  | no agent auth on host                 | `codex login` or API key locally                    |
| Two daemons on `:4310`              | manual daemon + systemd               | kill manual; `systemctl --user restart spur-daemon` |
| Project missing in UI               | config not connected                  | `spur connect --config`                             |

## Reference

CLI details: [v2/README.md](../v2/README.md).
