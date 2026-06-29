# Install Spur from npm

The published `spur` tarball ships the daemon, CLI, and bundled web UI (Next.js
standalone build) in a single package. Use this path when you do not want to
clone the repo.

## Install

```bash
npm config set prefix ~/.local
npm install -g spur
```

`spur` lands at `~/.local/bin/spur`. Ensure `~/.local/bin` is on `PATH`.

Sanity check:

```bash
spur --version
```

## systemd (Linux)

The npm-layout unit templates live under `deploy/` in this repo. Install them
once:

```bash
sudo install -m 644 deploy/spur-daemon.npm.service /etc/systemd/system/spur-daemon-npm.service
sudo install -m 644 deploy/spur-web.npm.service    /etc/systemd/system/spur-web-npm.service
sudo systemctl daemon-reload
sudo systemctl enable --now spur-daemon-npm.service spur-web-npm.service
```

Secrets (for example `AZURE_OPENAI_API_KEY`) belong in `/etc/spur/daemon.env`
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
