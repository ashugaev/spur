# Install Spur from npm

The published `@shugaev/spur` tarball ships the daemon, CLI, and bundled web
UI (Next.js standalone build) in a single package. Use this path when you do
not want to clone the repo.

## Channels

- stable: `X.Y.Z`, npm dist-tag `latest`, published from the `stable` branch.
- alpha: `X.Y.Z-alpha.N`, npm dist-tag `alpha`, published from every merge to
  `main`.

The web UI's version menu offers a Stable | Alpha toggle for switching between
channels at runtime.

## Layout

Each version installs into its own npm prefix so a switch never mutates the
running install:

```
~/.spur/versions/<version>/   per-version npm prefix
~/.spur/current               symlink to the active package dir
~/.spur/deploy/               switch-state.json, lock, pre-switch backups
```

Systemd units exec through `~/.spur/current`, so activating a version is an
atomic symlink flip plus a service restart. Version switches (from the web UI
or `POST /deploy/switch`) install the target version, flip the symlink,
restart the units, and healthcheck the daemon; on failure they flip back and
restart the previous version automatically.

Note: the units hardcode `%h/.spur/current`. A custom `dataDir` requires
editing the unit files.

## Bootstrap

One-time setup (the switch script ships inside the package, so the first
version is installed with plain npm):

```bash
V="$(npm view @shugaev/spur version)"   # or: npm view @shugaev/spur dist-tags.alpha
npm install -g --prefix "$HOME/.spur/versions/$V" "@shugaev/spur@$V"
ln -s "$HOME/.spur/versions/$V/lib/node_modules/@shugaev/spur" "$HOME/.spur/current.new"
mv -T "$HOME/.spur/current.new" "$HOME/.spur/current"
mkdir -p ~/.local/bin
printf '#!/usr/bin/env bash\nexec node "$HOME/.spur/current/dist/cli.js" "$@"\n' > ~/.local/bin/spur
chmod +x ~/.local/bin/spur
```

`spur` resolves through the `current` symlink, so it always runs the active
version. Ensure `~/.local/bin` is on `PATH`.

Sanity check:

```bash
spur --version
```

## systemd (Linux)

Spur runs as user-level systemd units so the daemon can restart itself during
version switches without root. The unit templates ship inside the npm package
under `deploy/` (source: `v2/deploy/` in this repo). Install them once:

```bash
PKG=~/.spur/current
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

## Switches, rollback, and backups

- Switch progress lands in `~/.spur/deploy/switch-state.json`
  (`installing | restarting | done | rolled_back | failed`); the web UI reads
  it through `GET /deploy/versions`.
- The switch log is `~/.spur/logs/install-and-restart.log`.
- Before every flip the script copies `~/.spur/config.yaml` and root-level
  `~/.spur/*.json` to `~/.spur/deploy/backup-<version>/`. Restore is manual:
  copy the files back and `systemctl --user restart spur-daemon.service
spur-web.service`.
- The last three version dirs are kept under `~/.spur/versions/` for instant
  rollback; older ones are pruned after a healthy switch.

## Migrating from a `~/.local` global install

Earlier installs used `npm install -g` into the `~/.local` prefix. To migrate:
run the bootstrap above, reinstall the units (they now point at
`~/.spur/current`), restart both services, then remove the old copy with
`npm uninstall -g @shugaev/spur --prefix ~/.local`.
