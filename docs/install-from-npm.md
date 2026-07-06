# Install Spur from npm (agent runbook)

Audience: autonomous agents installing `@shugaev/spur` on a Linux host without cloning the repo.
Every step is a supported path (npm, files shipped in the package, `systemctl --user`, Spur CLI). No undocumented shortcuts.

## Security (mandatory)

- Never copy `~/.spur/daemon.env`, project `.env` files, API keys, SSH keys, or `NPM_TOKEN` from another host.
- Never `scp` / `rsync` credential material from openclaw-dev or any other machine onto the target.
- Secrets on the target host only: create `~/.spur/daemon.env` on that machine (mode `0600`) with values that already belong on that host, or `${VAR}` placeholders resolved from that host's environment.
- Project repos may symlink `.env` in `spur.yml`; those files must already exist on the target repo checkout — do not import them from elsewhere.
- Agent auth (Codex API key, `gh auth login`, etc.) must be configured on the target host only.

## Prerequisites (verify before install)

Run on the target host:

```bash
node -v    # require ^20.19 || ^22.13 || >=24 (see package engines)
npm -v
systemctl --user status >/dev/null 2>&1 && echo user-systemd-ok
command -v tmux git node npm
loginctl show-user "$USER" -p Linger 2>/dev/null
```

Record gaps. Install missing packages with the host's normal package manager before continuing.

## Port map (npm layout)

| Service | Bind (default) | Port |
|---------|----------------|------|
| Daemon HTTP API | `127.0.0.1` | 4310 |
| Web UI (bundled Next standalone) | `127.0.0.1` | 4311 |

This differs from source-deploy production (nginx `:5555`, web `:3012`). Do not assume `:5555` on npm installs.

For Tailscale / LAN access to the web UI, bind web to `0.0.0.0` (Step 6b). Daemon stays on `127.0.0.1:4310`.

## Step 1 — npm prefix (required)

User unit templates hardcode `%h/.local/lib/node_modules/@shugaev/spur`. The prefix must be `~/.local`.

```bash
npm config set prefix ~/.local
grep -q '$HOME/.local/bin' ~/.profile 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.local/bin:$PATH"
```

Verify: `npm config get prefix` prints `$HOME/.local` (expanded).

## Step 2 — install package

```bash
npm install -g @shugaev/spur@0.1.2
```

Use a concrete version in automation. `@latest` is allowed for humans only.

Verify (always use the npm binary path if `which spur` might resolve a dev checkout):

```bash
~/.local/bin/spur --version
test -f ~/.local/lib/node_modules/@shugaev/spur/dist/cli.js
test -f ~/.local/lib/node_modules/@shugaev/spur/web/server.js
test -f ~/.local/lib/node_modules/@shugaev/spur/deploy/spur-daemon.npm.service
```

Expected: version matches the requested tag (e.g. `0.1.2`).

## Step 3 — install agents (when spawning sessions)

Spur spawns agents from `PATH` inside tmux. System packages in `/usr/bin` may be older than Spur expects.

```bash
npm install -g @openai/codex@latest
~/.local/bin/codex --version   # must accept --dangerously-bypass-hook-trust (>= 0.14x)
```

Add `PATH` to the daemon unit so tmux sessions pick up `~/.local/bin` (Step 3b).

Codex login / API key on this host only (`codex login` or `OPENAI_API_KEY` in `~/.spur/daemon.env`). Do not copy auth from another machine.

## Step 3b — PATH in daemon unit (required when agents are in ~/.local)

After copying unit files (Step 4), add one line to `~/.config/systemd/user/spur-daemon.service` under `[Service]`:

```ini
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
```

Then `systemctl --user daemon-reload`.

Without this, systemd/tmux may resolve `/usr/bin/codex` (stale) instead of `~/.local/bin/codex`.

## Step 4 — install user systemd units (shipped in package)

There is no `spur install-systemd` subcommand. Copy the templates from the installed package:

```bash
PKG=~/.local/lib/node_modules/@shugaev/spur
mkdir -p ~/.config/systemd/user
install -m 644 "$PKG/deploy/spur-daemon.npm.service" ~/.config/systemd/user/spur-daemon.service
install -m 644 "$PKG/deploy/spur-web.npm.service"    ~/.config/systemd/user/spur-web.service
systemctl --user daemon-reload
```

Apply Step 3b (PATH line) after install.

Verify: `systemctl --user cat spur-daemon.service` shows `ExecStart=.../.local/lib/node_modules/@shugaev/spur/dist/cli.js daemon start`.

## Step 5 — linger (required for headless / SSH hosts)

Without linger, user units stop when the SSH session ends.

```bash
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Expected: `Linger=yes`.

## Step 6 — daemon secrets file (optional, target-local only)

Only if the daemon needs API keys on this host (voice, Azure OpenAI, Codex, etc.):

```bash
install -d -m 700 ~/.spur
touch ~/.spur/daemon.env
chmod 600 ~/.spur/daemon.env
```

Populate with keys that belong on this machine. The unit loads `EnvironmentFile=-~/.spur/daemon.env` (missing file is OK).

Do not copy content from another server's `daemon.env` or `/etc/spur/daemon.env`.

## Step 6b — expose web UI on Tailscale (optional)

Default web bind is `127.0.0.1` (local only). For access from other Tailscale devices:

```bash
sed -i 's/Environment=HOSTNAME=127.0.0.1/Environment=HOSTNAME=0.0.0.0/' \
  ~/.config/systemd/user/spur-web.service
systemctl --user daemon-reload
```

Verify from another host on Tailscale: `curl -fsS -o /dev/null -w '%{http_code}\n' http://<target-tailscale-ip>:4311/` → `200`.

## Step 7 — start services

Remove any legacy source-install daemon first (manual `node .../v2/dist/cli.js daemon start`, old `~/projects/ao` checkout, etc.).

```bash
systemctl --user enable --now spur-daemon.service spur-web.service
```

Verify:

```bash
systemctl --user is-active spur-daemon.service spur-web.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # expect 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4311/             # expect 200
```

If web is not 200: `journalctl --user -u spur-web.service -n 40 --no-pager`.

## Step 8 — instance config (automatic)

`~/.spur/config.yaml` is not created by `spur doctor`. It is created on first daemon start via `ensureInstanceConfig`.

First run may print voice dependency hints (`whisper-cli`, etc.). Those are warnings only.

Set default agent to one installed on this host (example: `codex`):

```bash
sed -i 's/defaultAgent: claude/defaultAgent: codex/' ~/.spur/config.yaml
systemctl --user restart spur-daemon.service
```

## Step 9 — connect project config

`spur doctor` scaffolds a new `spur.yaml` in a git repo root only. It does not write `~/.spur/config.yaml`. It fails if a project config already exists.

For an existing repo: place or sync `spur.yml`, fix host-specific paths (nvm, absolute `path:`), then **connect**:

```bash
cd ~/intelas-web
test -f spur.yml
~/.local/bin/spur connect --config spur.yml
```

`connect` registers the project in `~/.spur/config-registry.json`. `list` alone does not.

Verify:

```bash
curl -fsS http://127.0.0.1:4310/projects | jq '.[].id'
```

## Step 10 — smoke test

```bash
~/.local/bin/spur list --json | jq 'length'          # sessions count
~/.local/bin/spur spawn int --branch WEBDEV-9999 "smoke test" --json   # when codex authed
```

Branch names must match project `branchNaming.regex` when set (e.g. `^[A-Z]+-[0-9]+$`).

Confirm: one listener on `:4310` under systemd (`ss -tlnp | grep 4310`).

## Upgrade

```bash
npm install -g @shugaev/spur@<version>
systemctl --user restart spur-daemon.service spur-web.service
```

Or, when the running daemon supports it, version switch via `POST /deploy/switch` (uses `scripts/install-and-restart.sh` inside the package).

After upgrade, re-run Step 7 verify curls.

## Intelas devbox (validated)

| Field | Value |
|-------|-------|
| Tailscale IP | `100.119.243.94` (`int-devbox`) |
| SSH user | `aleksey` |
| Repo | `/home/aleksey/intelas-web` |
| Project id | `int` |
| Web UI | `http://100.119.243.94:4311` |

Agent SSH may require Tailscale browser approval on first connect.

`spur.yml` on this host uses absolute paths (`/home/aleksey/intelas-web`, system `yarn` — no nvm). Sidecar URLs use `*.local.intelas.tech`.

## Common failures (observed)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `spur --version` runs wrong code | `PATH` picks a dev checkout | `~/.local/bin/spur` explicitly |
| systemd `status=203/EXEC` | npm prefix not `~/.local` | Step 1, reinstall |
| Web 000 / connection refused | linger off or unit not started | Step 5 + 7 |
| `unexpected argument '--dangerously-bypass-hook-trust'` | stale `/usr/bin/codex` | Step 2–3 + Step 3b PATH |
| Codex login prompt in tmux | no agent auth on target | `codex login` or API key locally |
| `branch must match regex` | auto branch name | `--branch WEBDEV-1234` |
| `doctor` errors "already exists" | project config present | use `connect`, skip `doctor` |
| Two daemons on `:4310` | manual daemon + systemd | kill manual; restart user unit |
| Project missing in UI | config not connected | `spur connect --config spur.yml` |
| Copied secrets / wrong tenant | Security violation | recreate target-local secrets only |

## Reference

CLI details: [v2/README.md](../v2/README.md).
