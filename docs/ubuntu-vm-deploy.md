# Deploy Spur To An Ubuntu VM

Deploy from a GitHub checkout (not by copying the repo tree). VM needs SSH and GitHub SSH access. `v2/` is runtime source of truth. Expose the web UI through a reverse proxy for browser access beyond loopback.

## Recommended Shape

- Spur daemon on loopback: `127.0.0.1:4310`
- Web UI on loopback: `127.0.0.1:3012`
- Reverse proxy (`nginx`) on private Tailscale IP: `100.64.0.10:5555`

Keep the direct terminal websocket on loopback; set `DIRECT_TERMINAL_PUBLIC_PORT` to the externally reachable proxy port. Bind the reverse proxy to `127.0.0.1`, a Tailscale IP, or another private interface — not `0.0.0.0` unless the VM is intentionally public.

## Local Vs Portable Inventory

| Artifact                        | Path                                                        | Source of truth             | Notes                                                                    |
| ------------------------------- | ----------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| Repo checkout                   | `~/projects/spur`                                           | git                         | Clone target; `pnpm main:deploy` builds against the managed deploy clone |
| Managed deploy clone            | `~/.spur/main-deploy/repo`                                  | git (auto)                  | Created by `scripts/main-deploy.sh`; never edit directly                 |
| Last-deployed SHA stamp         | `~/.spur/main-deploy/repo/.git/main-deploy-last-successful` | local                       | Override via `MAIN_DEPLOY_STAMP_FILE`                                    |
| Cron deploy log                 | `~/.spur/main-cron-deploy.log`                              | local                       | Rotate manually if needed                                                |
| Instance config                 | `~/.spur/config.yaml`                                       | local                       | Host/port, dataDir, tmux socket, UI port                                 |
| Project config (this repo)      | `~/projects/spur/spur.yaml`                                 | git (tracked)               | Dogfooded; safe to commit                                                |
| Project config (generic repo)   | `<repo>/spur.yaml`                                          | per-repo policy             | Tracked or local depending on repo                                       |
| Daemon env secret               | `/etc/spur/daemon.env`                                      | local                       | Mode 0600 root:root; read via `EnvironmentFile=`                         |
| Daemon env template             | `deploy/spur-daemon.env.example`                            | git (tracked)               | Safe copyable baseline                                                   |
| Daemon systemd unit (template)  | `deploy/spur-daemon.service`                                | git (tracked)               | Placeholders substituted at install                                      |
| Web systemd unit (template)     | `deploy/spur-web.service`                                   | git (tracked)               | Placeholders substituted at install                                      |
| Daemon systemd unit (installed) | `/etc/systemd/system/spur-daemon.service`                   | written by `main-deploy.sh` | Never hand-edit                                                          |
| Web systemd unit (installed)    | `/etc/systemd/system/spur-web.service`                      | written by `main-deploy.sh` | Never hand-edit                                                          |
| Nginx site                      | `/etc/nginx/sites-enabled/spur`                             | local                       | Hand-managed                                                             |
| GitHub auth                     | `~/.config/gh/`                                             | local                       | `gh auth login`                                                          |
| Codex auth                      | `~/.codex/`                                                 | local                       | `codex login`                                                            |
| Claude auth                     | `~/.claude/`                                                | local                       | `claude login`                                                           |
| Voice secrets                   | `~/.spur/.env`                                              | local                       | Mode 0600; Azure keys for voice providers                                |
| Voice models                    | `~/.cache/whisper.cpp/`, `~/.spur/venvs/faster-whisper/`    | local                       | Per voice provider                                                       |
| Built daemon                    | `~/projects/spur/v2/dist/`                                  | local (gitignored)          | Produced by `pnpm build`                                                 |
| Web build                       | `~/projects/spur/packages/web/.next/`                       | local (gitignored)          | Produced by `pnpm build`                                                 |
| Sidecar deps                    | `~/projects/spur/.next-sidecars/`, sidecar `node_modules`   | local (gitignored)          | Installed on first sidecar start                                         |
| Worktrees root                  | `~/.spur/worktrees`                                         | local                       | Per `worktreeDir` in instance config                                     |

## Quick Start

1. Install host packages — `sudo apt-get update && sudo apt-get install -y git tmux nginx gh curl ca-certificates`. Verify: `git --version && tmux -V && nginx -v && gh --version`.
2. Install Node.js 20 (NodeSource or nvm — see Prerequisites). Verify: `node -v` prints `v20.x` or later.
3. Enable corepack and pin pnpm — `sudo corepack enable && sudo corepack prepare pnpm@9.15.4 --activate`. Verify: `pnpm -v` prints `9.15.4`.
4. Install user-scoped agent CLIs and authenticate (see Agent CLI Auth). Verify: `codex --version && claude --version && gh auth status`.
5. Clone repo to `~/projects/spur`, checkout `main`, run `pnpm install && pnpm build`. Verify: test -f ~/projects/spur/v2/dist/cli.js.
6. Provision `/etc/spur/daemon.env` (copy from `deploy/spur-daemon.env.example`, fill `AZURE_OPENAI_API_KEY`, chmod 0600 root:root). Verify: `sudo stat -c '%a %U:%G' /etc/spur/daemon.env` prints `600 root:root`.
7. Write `~/.spur/config.yaml` instance config (loopback 4310, UI 5555, tmux socket `spur-4310`). Verify: `node ~/projects/spur/v2/dist/cli.js doctor`.
8. Run `pnpm main:deploy` to install systemd units, build, and restart services. On first install also run `sudo systemctl enable --now spur-daemon.service spur-web.service`. Verify: `systemctl is-active spur-daemon.service spur-web.service` both return `active`.
9. Configure nginx site (loopback + Tailscale IP listeners on 5555), `sudo nginx -t && sudo systemctl reload nginx`. Verify: `curl -I http://127.0.0.1:5555`.
10. End-to-end probes — `curl http://127.0.0.1:4310/sessions && curl http://127.0.0.1:5555/api/runtime/terminal && ss -ltnp | egrep ':(4310|3012|5555|14801)\b'`.

## Prerequisites

Host packages and pnpm: Quick Start steps 1 and 3. Configure GitHub SSH keys on the VM before cloning.

Install Node.js 20 before enabling corepack. Pick one path:

NodeSource (system-wide):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # expect v20.x or later
```

nvm (user-scoped):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell, then:
nvm install 20
nvm use 20
node -v   # expect v20.x or later
```

## Clone And Build

Clone from GitHub to a stable path (Quick Start step 5). Replace `<owner>/<repo>` with your repository:

```bash
mkdir -p ~/projects && cd ~/projects
git clone git@github.com:<owner>/<repo>.git spur
cd spur && git checkout main && pnpm install && pnpm build
```

## Daemon Secrets

Provision before the first `pnpm main:deploy`. The spur-daemon unit reads `EnvironmentFile=/etc/spur/daemon.env` (Quick Start step 6). Format: `deploy/spur-daemon.env.example`. `pnpm main:deploy` aborts if the file is missing.

Voice credentials for optional voice input belong in `~/.spur/.env`, not in `/etc/spur/daemon.env`. See [Voice input (optional)](#voice-input-optional).

## Runtime Config

Create VM-local instance config `~/.spur/config.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 4310

dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
defaultAgent: codex
tmux:
  socketName: spur-4310
ui:
  port: 5555
```

Keep repo-local project config in the checkout, e.g. `~/projects/spur/spur.yaml`:

```yaml
projects:
  spur:
    path: ~/projects/spur
    defaultBranch: main
    sessionPrefix: spur
    worktree: true
    symlinks: []
```

Keep the daemon on loopback; instance config global, project config repo-local. Point `projects.<id>.path` at the real checkout. Add GitHub sources or triggers only after `gh auth login` works.

## Systemd Services

Do not paste or hand-edit unit bodies in this doc. Canonical templates: `deploy/spur-daemon.service`, `deploy/spur-web.service`.

`pnpm main:deploy` (via `scripts/main-deploy.sh`) substitutes `{{SPUR_ROOT}}`, `{{SPUR_SERVICE_USER}}`, and `{{SPUR_SERVICE_HOME}}` into every `deploy/*.service` file and writes to `/etc/systemd/system/`. Uses `MAIN_DEPLOY_ROOT` when set; otherwise managed clone is `~/.spur/main-deploy/repo`. Service account defaults to the script runner; override with `MAIN_DEPLOY_SERVICE_USER` and `MAIN_DEPLOY_SERVICE_HOME`.

Load-bearing template fields:

Daemon (`deploy/spur-daemon.service`):

- `EnvironmentFile=/etc/spur/daemon.env`
- `Environment=PATH=.../.local/bin:.../.npm-global/bin:...` — user-scoped agent CLIs
- `KillMode=process` — restart kills only the daemon node process; tmux sessions survive
- starts with `node {{SPUR_ROOT}}/v2/dist/cli.js daemon start`

Web (`deploy/spur-web.service`):

- `Environment=WEB_HOST=127.0.0.1`, `Environment=PORT=3012`
- `Environment=DIRECT_TERMINAL_BIND_HOST=127.0.0.1`, `Environment=DIRECT_TERMINAL_BIND_PORT=14801`
- `Environment=DIRECT_TERMINAL_PUBLIC_PORT=443` — set to the port browsers reach (5555 for nginx below, or 443 with Tailscale HTTPS serve)
- `Requires=spur-daemon.service`

First install: Quick Start step 8 (`daemon-reload` then `enable --now`). Subsequent releases: `pnpm main:deploy` only — reloads changed units and restarts after a successful build. Inspect live units at `/etc/systemd/system/spur-*.service` or the repo templates; do not maintain a third copy in docs.

## Reverse Proxy

Bind `nginx` only to addresses you want to expose. Example: localhost plus a private Tailscale IP.

```nginx
server {
    listen 127.0.0.1:5555;
    listen 100.64.0.10:5555;
    server_name _;

    location /ws {
        proxy_pass http://127.0.0.1:14801/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    location /terminal-health {
        proxy_pass http://127.0.0.1:14801/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://127.0.0.1:3012;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload: Quick Start step 9. Set `DIRECT_TERMINAL_PUBLIC_PORT` in `deploy/spur-web.service` (via redeploy) to match the port browsers use.

## Voice Input (Optional)

Optional. Requires extra host dependencies, `~/.spur/.env` credentials for some providers, and HTTPS (or localhost) for microphone access. Full setup: [v2/README.md — Voice Input](../v2/README.md#voice-input).

## Sidecars (Optional)

Session-bound commands from `projects.<id>.sidecars` in worktrees. Each sidecar installs local `node_modules` on first start. Nesting limited to one level. See [v2/README.md](../v2/README.md).

## Agent CLI Auth

Install user-scoped on the service account (not `sudo npm install -g`). Daemon unit `PATH` includes `~/.npm-global/bin`:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
source ~/.profile
npm install -g @openai/codex @anthropic-ai/claude-code
codex login && claude login && gh auth login
```

Without authenticated agent CLIs, daemon and UI run but session spawns fail. Without `gh auth login`, disable GitHub sources and triggers until auth works.

## Validation

Local probes: Quick Start step 10. For private Tailscale deployments, also from another tailnet device:

```bash
curl -I http://100.64.0.10:5555
curl http://100.64.0.10:5555/api/runtime/terminal
```

Confirm the public VM IP does not answer on the proxy port when the deployment should stay private.

## Release Flow

1. Merge to `main` on GitHub.
2. SSH into the VM.
3. `cd ~/projects/spur && pnpm main:deploy`
4. Re-run Validation probes.

`pnpm main:deploy` uses `MAIN_DEPLOY_ROOT` when set; otherwise managed clone is `~/.spur/main-deploy/repo`. Installs systemd units for the script account (or `MAIN_DEPLOY_SERVICE_USER` / `MAIN_DEPLOY_SERVICE_HOME`). Fetches latest `origin/main`, builds there, restarts only after success, records last deployed SHA so cron retries failed releases.

## Automated Main Releases

Hourly auto-release from an isolated clone:

```bash
crontab -l > /tmp/spur.cron
printf '%s\n' '0 * * * * MAIN_DEPLOY_ROOT=$HOME/.spur/main-deploy/repo /usr/bin/pnpm -C $HOME/projects/spur run main:deploy >> $HOME/.spur/main-cron-deploy.log 2>&1' >> /tmp/spur.cron
crontab /tmp/spur.cron
rm /tmp/spur.cron
```

Cron entrypoint stays a normal checkout; deploy work happens in `MAIN_DEPLOY_ROOT`.

## AI Agent Playbook

Use on the VM when diagnosing or releasing production. Every probe targets `127.0.0.1`.

Ordered steps:

1. Detect tree state — `cd ~/projects/spur && git status && git log --oneline -5`. Refuse to commit if the working tree is dirty in the service-account checkout; switch to a dedicated worktree under `~/.spur/worktrees/`.
2. Read service health — `systemctl is-active spur-daemon.service spur-web.service && systemctl is-enabled spur-daemon.service spur-web.service`.
3. Read daemon health — `curl -fsS http://127.0.0.1:4310/sessions | head -c 500`.
4. Read UI health — `curl -fsSI http://127.0.0.1:5555 && curl -fsS http://127.0.0.1:5555/api/runtime/terminal | head -c 500`.
5. Read recent failure logs — `journalctl -u spur-daemon.service -n 200 --no-pager`, same for `spur-web.service`, and `tail -n 200 ~/.spur/main-cron-deploy.log`.
6. To deploy a merged change — run `pnpm main:deploy` only. Do not run `pnpm build` or restart services by hand.
7. To diagnose stale unit files — compare `/etc/systemd/system/spur-daemon.service` against the repo template with placeholders filled; if stale, run `pnpm main:deploy`.
8. To diagnose `EADDRINUSE` on 4310 — check journalctl, then re-run `pnpm main:deploy` (the script's `kill_rogue_daemon_on_port` handles orphan PIDs); do not `kill -9` by hand.
9. To diagnose missing `/etc/spur/daemon.env` — `main:deploy` aborts with a specific message; restore the file from a password manager, do not invent values.

Failure handling rules:

- A failed `pnpm main:deploy` does not advance the `main-deploy-last-successful` stamp — the next run retries the same SHA. Do not delete the stamp file to force a deploy.
- If `systemctl restart` leaves either service in `activating` or `failed`, capture `journalctl -u <unit> -n 200 --no-pager` before any further action.
- Never edit `/etc/systemd/system/spur-*.service` by hand. Edit `deploy/*.service` in the repo and rerun `pnpm main:deploy`.
- Never delete the managed deploy clone at `MAIN_DEPLOY_ROOT` to clean up; it is the deploy script's authoritative working copy.

What to report when handing off to a human:

- Current `origin/main` SHA, last-deployed SHA from the stamp file, and whether they match.
- `systemctl is-active` for both units.
- Output of the four validation curls (4310 sessions, 5555 HEAD, 5555 terminal API, plus Tailscale probe if applicable).
- Last 50 lines of each unit's journalctl when either is not `active`.
- Path of any file changed and whether it is portable (repo-tracked) or local (VM-only).

## Commit Policy

Allowed to commit (changes flow through PR to `main`, then `pnpm main:deploy` picks them up):

- `deploy/spur-daemon.service`, `deploy/spur-web.service`, `deploy/spur-daemon.env.example`
- `scripts/main-deploy.sh`
- `docs/ubuntu-vm-deploy.md`
- Source code, tests, web UI, repo configs

Never commit:

- `/etc/spur/daemon.env` or any rendered copy of it
- `~/.spur/config.yaml`, `~/.spur/.env`, `~/.spur/worktrees/`, `~/.spur/main-deploy/`
- `node_modules/`, `dist/`, `.next/`, `.next-sidecars/`, `*.tsbuildinfo` (already in `.gitignore`)
- Anonymized session fixtures pulled from the live VM data dir
- The managed deploy clone (`MAIN_DEPLOY_ROOT=~/.spur/main-deploy/repo`) — read-only; do not push from there

Where to commit from:

- Use a separate worktree under `~/.spur/worktrees/` or another path; do not commit from `~/projects/spur` if it is the service-account checkout being deployed.
- Never commit from `MAIN_DEPLOY_ROOT`. It is reset hard to `origin/main` on every run.

## Operational Notes

- `spur-daemon.service` and `spur-web.service` must be enabled, not only started
- keep the daemon and Next.js app on loopback even when the UI is proxied
- do not point the browser directly at the terminal bind port
- set `DIRECT_TERMINAL_PUBLIC_PORT` to the reverse proxy port the browser will actually use

## Logs

```bash
systemctl status spur-daemon.service
systemctl status spur-web.service
journalctl -u spur-daemon.service -n 100 --no-pager
journalctl -u spur-web.service -n 100 --no-pager
```
