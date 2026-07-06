# Install Spur from npm

Install `@shugaev/spur` on a Linux host without cloning the repo. All steps use npm, files shipped in the package, `systemctl --user`, and the Spur CLI.

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
loginctl show-user "$USER" -p Linger 2>/dev/null
```

Install anything missing with the host's package manager before continuing.

## Ports (npm layout)

| Service                          | Bind (default) | Port |
| -------------------------------- | -------------- | ---- |
| Daemon HTTP API                  | `127.0.0.1`    | 4310 |
| Web UI (bundled Next standalone) | `127.0.0.1`    | 4311 |

Source-deploy layouts often use different ports (e.g. nginx `:5555`). Do not assume them on npm installs.

For remote access to the web UI (private network, VPN, or LAN), bind web to `0.0.0.0` (optional step below). Daemon stays on `127.0.0.1:4310`.

## 1. npm prefix

User unit templates hardcode `%h/.local/lib/node_modules/@shugaev/spur`. Set prefix to `~/.local`.

```bash
npm config set prefix ~/.local
grep -q '$HOME/.local/bin' ~/.profile 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.local/bin:$PATH"
```

Verify: `npm config get prefix` → `$HOME/.local`.

## 2. Install Spur

```bash
npm install -g @shugaev/spur@<version>
```

Pin a version in automation; `@latest` is fine for manual installs.

```bash
~/.local/bin/spur --version
test -f ~/.local/lib/node_modules/@shugaev/spur/dist/cli.js
test -f ~/.local/lib/node_modules/@shugaev/spur/web/server.js
test -f ~/.local/lib/node_modules/@shugaev/spur/deploy/spur-daemon.npm.service
```

## 3. Install agents (for spawning sessions)

Spur resolves agents from `PATH` inside tmux. System packages in `/usr/bin` may be older than Spur expects.

```bash
npm install -g @openai/codex@latest
~/.local/bin/codex --version
```

Configure auth on this host only (`codex login` or `OPENAI_API_KEY` in `~/.spur/daemon.env`).

The shipped daemon unit sets `PATH=%h/.local/bin:...` so tmux picks up npm-installed agents. If you installed units from an older package without that line, add under `[Service]` in `~/.config/systemd/user/spur-daemon.service`:

```ini
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
```

## 4. Install systemd user units

There is no `spur install-systemd` subcommand. Copy templates from the installed package:

```bash
PKG=~/.local/lib/node_modules/@shugaev/spur
mkdir -p ~/.config/systemd/user
install -m 644 "$PKG/deploy/spur-daemon.npm.service" ~/.config/systemd/user/spur-daemon.service
install -m 644 "$PKG/deploy/spur-web.npm.service"    ~/.config/systemd/user/spur-web.service
systemctl --user daemon-reload
```

## 5. Linger

Required on headless / SSH hosts so user units survive logout.

```bash
loginctl enable-linger "$USER"
```

Expected: `loginctl show-user "$USER" -p Linger` → `Linger=yes`.

## 6. Daemon secrets (optional)

Only if the daemon needs API keys on this host (voice, Azure OpenAI, Codex, etc.):

```bash
install -d -m 700 ~/.spur
install -m 600 /dev/null ~/.spur/daemon.env
```

The unit loads `EnvironmentFile=-~/.spur/daemon.env` (missing file is OK).

## 7. Expose web UI remotely (optional)

Default web bind is `127.0.0.1`. For access from other machines on your network:

```bash
sed -i 's/Environment=HOSTNAME=127.0.0.1/Environment=HOSTNAME=0.0.0.0/' \
  ~/.config/systemd/user/spur-web.service
systemctl --user daemon-reload
```

Verify: `curl -fsS -o /dev/null -w '%{http_code}\n' http://<host>:4311/` → `200`.

## 8. Start services

Stop any manual `spur daemon start` or legacy source-install daemon before enabling units.

```bash
systemctl --user enable --now spur-daemon.service spur-web.service
```

Verify:

```bash
systemctl --user is-active spur-daemon.service spur-web.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4311/             # 200
```

Logs: `journalctl --user -u spur-web.service -n 40 --no-pager`.

## 9. Instance config

`~/.spur/config.yaml` is created on first daemon start — not by `spur doctor`.

Voice dependency warnings on first start are optional; core daemon works without them.

Set `defaultAgent` in `~/.spur/config.yaml` to an agent installed on this host, then restart the daemon if you change it.

## 10. Connect a project

`spur doctor` scaffolds a new `spur.yaml` in a git repo root. It fails if one already exists.

For an existing project config (`spur.yaml` / `spur.yml`):

```bash
cd <your-repo>
~/.local/bin/spur connect --config spur.yaml
```

`connect` registers the project in `~/.spur/config-registry.json`. `list` alone does not.

Verify: `curl -fsS http://127.0.0.1:4310/projects | jq '.[].id'`

Adjust `path:`, nvm paths, and sidecar commands in the project config for the target host before connecting.

## 11. Smoke test

```bash
~/.local/bin/spur list --json
~/.local/bin/spur spawn <project-id> --branch <branch> "smoke test" --json
```

If the project sets `branchNaming.regex`, pass a matching `--branch`.

Confirm one listener on `:4310` under systemd: `ss -tlnp | grep 4310`.

## Upgrade

```bash
npm install -g @shugaev/spur@<version>
systemctl --user restart spur-daemon.service spur-web.service
```

When supported, version switch via `POST /deploy/switch` (uses `scripts/install-and-restart.sh` in the package).

Re-copy unit files from the package if templates changed, then `systemctl --user daemon-reload`.

## Troubleshooting

| Symptom                                                 | Cause                             | Fix                               |
| ------------------------------------------------------- | --------------------------------- | --------------------------------- |
| `spur --version` runs wrong binary                      | `PATH` picks another spur install | `~/.local/bin/spur`               |
| systemd `status=203/EXEC`                               | npm prefix not `~/.local`         | step 1, reinstall                 |
| Web connection refused                                  | linger off or unit not started    | steps 5 + 8                       |
| `unexpected argument '--dangerously-bypass-hook-trust'` | stale system `codex`              | step 3, check PATH in unit        |
| Codex login prompt in tmux                              | no agent auth on target           | `codex login` or API key locally  |
| `branch must match regex`                               | auto branch name                  | `--branch` matching project regex |
| `doctor` errors "already exists"                        | project config present            | `connect`, skip `doctor`          |
| Two daemons on `:4310`                                  | manual daemon + systemd           | kill manual process; restart unit |
| Project missing in UI                                   | config not connected              | `spur connect --config`           |

## Reference

CLI details: [v2/README.md](../v2/README.md).
