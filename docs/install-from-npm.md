# Install Spur from npm

The published `@ashugaev/spur` tarball ships the daemon, CLI, and bundled web
UI (Next.js standalone build) in a single package. Use this path when you do
not want to clone the repo.

## Install

```bash
npm config set prefix ~/.local
npm install -g @ashugaev/spur
```

`spur` lands at `~/.local/bin/spur`. Ensure `~/.local/bin` is on `PATH`.

Sanity check:

```bash
spur --version
```

## systemd (Linux)

Spur runs as user-level systemd units so the daemon can restart itself during
version switches without root. The unit templates ship inside the npm package
under `deploy/` (source: `v2/deploy/` in this repo). Install them once:

```bash
PKG=~/.local/lib/node_modules/@ashugaev/spur
mkdir -p ~/.config/systemd/user
install -m 644 "$PKG/deploy/spur-daemon.npm.service" ~/.config/systemd/user/spur-daemon.service
install -m 644 "$PKG/deploy/spur-web.npm.service"    ~/.config/systemd/user/spur-web.service
systemctl --user daemon-reload
systemctl --user enable --now spur-daemon.service spur-web.service
loginctl enable-linger "$USER"
```

`loginctl enable-linger` keeps the units running after logout; without it the
daemon dies when your SSH session ends.

Secrets (for example `AZURE_OPENAI_API_KEY`) belong in `~/.spur/daemon.env`
with mode `0600`. The daemon unit loads it via `EnvironmentFile=`.

The web UI binds to `127.0.0.1:4311`. Front it with a reverse proxy or expose
it over Tailscale only.

## First run

```bash
spur doctor
```

`spur doctor` writes a starter `spur.yaml` in the current directory and
initializes `~/.spur/config.yaml` if missing. After that:

```bash
spur list
spur spawn <project> "your task"
```

See [v2/README.md](../v2/README.md) for full CLI reference.
