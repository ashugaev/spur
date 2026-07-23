# Install from source

> Agent-first doc: terse and command-dense so an AI agent can run it top to bottom. Human-runnable too — it stays readable where that costs the agent nothing.

Deploy from a GitHub checkout (dev / maintainers). `v2/` is the runtime source of truth; `pnpm main:deploy` builds and installs the systemd units. For a normal server, use [install-from-npm.md](install-from-npm.md) instead — this path is for hacking on Spur or running your own build.

## Topology

- Daemon on loopback `127.0.0.1:4310`.
- Web UI on loopback `127.0.0.1:3012` — serves the terminal WebSocket on the same port at `/ws`.
- `nginx` is the only externally-bound surface: loopback by default, optionally a private interface (VM/Tailscale/VPN IP) on `5555`. Never bind `0.0.0.0` unless the VM is intentionally public.

Any proxy that forwards `/` covers `/ws` (same origin) — no extra port or env to coordinate.

## Prerequisites

- Host packages: `git tmux nginx gh curl`.
- Node 20+.
- pnpm pinned to `9.15.4` via corepack. This exact version matters: pnpm 11+ uses vm dynamic-import semantics incompatible with Node 24 and crashes on startup with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.
- GitHub SSH access on the VM (for the clone).
- Agent CLIs installed user-scoped, not `sudo npm -g`: set `npm config set prefix ~/.npm-global`, put `~/.npm-global/bin` on PATH. The daemon unit's `PATH` includes that dir; a system-wide install won't be found. Then `codex login` / `claude login` / `gh auth login` on the host.

### claude permission prompt

Spur launches claude with `--dangerously-skip-permissions`, which triggers a one-time per-cwd "Bypass Permissions mode" prompt that blocks the spawn. Pre-seed user settings to skip it:

```bash
mkdir -p ~/.claude
node -e 'const f=require("os").homedir()+"/.claude/settings.json";const fs=require("fs");const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};d.skipDangerousModePermissionPrompt=true;d.skipAutoPermissionPrompt=true;fs.writeFileSync(f,JSON.stringify(d,null,2))'
```

If your `CLAUDE.md` `@`-imports files outside the worktree, claude also prompts once for external imports — accept it once, or set `hasClaudeMdExternalIncludesApproved: true` for the project.

## Build

```bash
git clone git@github.com:<owner>/<repo>.git ~/projects/spur
cd ~/projects/spur && git checkout main && pnpm install && pnpm build
```

## Config

Instance config `~/.spur/config.yaml` (VM-local):

```yaml
server:
  host: 127.0.0.1
  port: 4310
dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
defaultAgent: claude
tmux:
  socketName: spur-4310
ui:
  port: 5555
```

Spur uses a dedicated tmux socket (`spur-4310`), so plain `tmux ls` shows nothing — use `tmux -L spur-4310 ls`.

Project config stays repo-local (`<repo>/spur.yaml`): `projects.<id>.path` points at the checkout. Register it after the daemon is up with `spur connect <repo>/spur.yaml`.

Daemon secret `/etc/spur/daemon.env` (mode `0600 root:root`), copied from `deploy/spur-daemon.env.example`. The daemon unit reads it via `EnvironmentFile=`; `pnpm main:deploy` aborts if it's missing. Voice keys go in `~/.spur/.env`, not here.

## Deploy

Systemd units are templates (`deploy/spur-daemon.service`, `deploy/spur-web.service`) with `{{SPUR_ROOT}}` / `{{SPUR_SERVICE_USER}}` / `{{SPUR_SERVICE_HOME}}` placeholders. `pnpm main:deploy` (`scripts/main-deploy.sh`) substitutes them, writes to `/etc/systemd/system/`, builds in the managed clone `~/.spur/main-deploy/repo` (override with `MAIN_DEPLOY_ROOT`), restarts only after a successful build, and records the deployed SHA so cron retries a failed release. Never hand-edit the installed units (overwritten every deploy) — use systemd drop-ins for per-VM overrides.

Load-bearing unit fields:

- Daemon: `EnvironmentFile=/etc/spur/daemon.env`; `PATH` includes `~/.npm-global/bin`; `KillMode=process` (restart kills only the node process, tmux sessions survive).
- Web: `WEB_HOST=127.0.0.1`, `PORT=3012` (one server for HTTP + `/ws`); `Requires=spur-daemon.service`.

First install:

```bash
pnpm main:deploy
sudo systemctl daemon-reload
sudo systemctl enable --now spur-daemon.service spur-web.service
```

Subsequent releases: `pnpm main:deploy` only (don't `pnpm build` or `systemctl restart` by hand).

## Reverse proxy

Bind `nginx` only to addresses you want exposed (substitute `<private-ip>` for the VM's private/Tailscale/VPN address; drop that line for loopback-only):

```nginx
server {
    listen 127.0.0.1:5555;
    listen <private-ip>:5555;
    server_name _;

    # One upstream serves the UI and the terminal WebSocket (/ws); the
    # Upgrade/Connection headers let the WS handshake pass through `/`.
    location / {
        proxy_pass http://127.0.0.1:3012;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

`sudo nginx -t && sudo systemctl reload nginx`.

## Verify

```bash
systemctl is-active spur-daemon.service spur-web.service   # active active
curl -fsS http://127.0.0.1:4310/sessions                   # JSON array
curl -fsSI http://127.0.0.1:3012 | head -1                 # 200
ss -ltnp | grep -E ':(4310|3012|5555)\b'
```

For a private-bound deploy, also probe `http://<private-ip>:5555` from another device, and confirm the public IP does not answer.

## Release + auto-deploy

Release: merge to `main`, SSH in, `pnpm main:deploy`, re-verify. A failed deploy doesn't advance the SHA stamp — the next run retries the same commit; don't delete the stamp to force it.

Optional hourly auto-release from the managed clone:

```bash
( crontab -l 2>/dev/null; echo '0 * * * * MAIN_DEPLOY_ROOT=$HOME/.spur/main-deploy/repo /usr/bin/pnpm -C $HOME/projects/spur run main:deploy >> $HOME/.spur/main-cron-deploy.log 2>&1' ) | crontab -
```

## Operational notes

- Commit from a separate worktree under `~/.spur/worktrees/`, never from the deployed checkout and never from `MAIN_DEPLOY_ROOT` (it's reset hard to `origin/main` every run).
- Never `kill -9` the daemon — `main:deploy` clears orphan PIDs (`kill_rogue_daemon_on_port`). `EADDRINUSE :4310` → just re-run `pnpm main:deploy`.
- `status=217/USER` on a unit → service-user mismatch; redeploy with `MAIN_DEPLOY_SERVICE_USER=<user>` (and `MAIN_DEPLOY_SERVICE_HOME`).
- Interactive auth (`codex login`, `claude login`, `gh auth login`) is done by a human at the terminal, not scripted. Never echo secrets to logs or chat — write them only to `/etc/spur/daemon.env` or `~/.spur/.env`.
- Voice input is optional and needs extra host deps; `openai_compatible` is the no-install path (key in `~/.spur/.env`). See [README.md — Voice Input](../README.md#voice-input).

## Logs

```bash
journalctl -u spur-daemon.service -n 100 --no-pager
journalctl -u spur-web.service -n 100 --no-pager
```
