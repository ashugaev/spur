# Deploy Spur To An Ubuntu VM

This guide is for a generic Ubuntu VM running Spur's daemon and optional web UI.

It assumes:

- you deploy from a GitHub checkout, not by copying the repo tree onto the VM
- the VM already has SSH access and GitHub SSH access
- you want `v2/` to remain the runtime source of truth
- you optionally want the web UI exposed through a reverse proxy

## Recommended Shape

Run three pieces:

- Spur daemon on loopback: `127.0.0.1:4310`
- web UI on loopback: `127.0.0.1:3012`
- reverse proxy (`nginx`) on private Tailscale IP: `100.64.0.10:5555`

Keep the direct terminal websocket server on loopback and advertise the externally reachable proxy port with `DIRECT_TERMINAL_PUBLIC_PORT`.

For private deployments, prefer binding the reverse proxy only to:

- `127.0.0.1`
- a Tailscale IP
- another private interface

Avoid `0.0.0.0` unless the VM is intentionally public.

## Prerequisites

Install the minimum host packages:

```bash
sudo apt-get update
sudo apt-get install -y git tmux nginx gh
```

Install Node.js 20+ or newer, then install `pnpm` and optional agent CLIs:

```bash
sudo corepack enable
sudo corepack prepare pnpm@9.15.4 --activate
sudo npm install -g @openai/codex
```

If you plan to run Claude sessions too:

```bash
sudo npm install -g @anthropic-ai/claude-code
```

Agent CLIs must also be authenticated on the VM. Without that, the daemon and UI can run, but real `spawn` calls will fail.

## Clone And Build

Choose a stable path, then clone from GitHub:

```bash
mkdir -p ~/projects
cd ~/projects
git clone git@github.com:<owner>/<repo>.git spur
cd spur
git checkout main
pnpm install
pnpm build
```

## Runtime Config

Create a VM-local Spur instance config such as `~/.spur/config.yaml`:

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

Then keep the repo-local project config in the checkout, for example `~/projects/spur/spur.yaml`:

```yaml
projects:
  spur:
    path: ~/projects/spur
    defaultBranch: main
    sessionPrefix: spur
    worktree: true
    symlinks: []
```

Notes:

- keep the daemon on loopback
- keep the instance config global and the project config repo-local
- point `projects.<id>.path` at the real checkout
- sidecars install their own local `node_modules` inside the worktree on first start
- add GitHub sources or triggers only after `gh auth login` is working on the VM

## Systemd Services

Provision daemon secrets out-of-band first. The unit reads them via
`EnvironmentFile=/etc/spur/daemon.env`:

```bash
sudo install -d -m 0755 /etc/spur
printf 'AZURE_OPENAI_API_KEY=<your-key>\n' | sudo tee /etc/spur/daemon.env >/dev/null
sudo chown root:root /etc/spur/daemon.env
sudo chmod 0600 /etc/spur/daemon.env
```

See `deploy/spur-daemon.env.example` for the file format. `pnpm main:deploy`
aborts if this file is missing.

Create a daemon unit:

```ini
[Unit]
Description=Spur daemon
After=network.target

[Service]
Type=simple
User=<vm-user>
WorkingDirectory=<repo-path>
Environment=HOME=<home-dir>
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node <repo-path>/v2/dist/cli.js daemon start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Create a web unit:

```ini
[Unit]
Description=Spur web UI
After=network.target spur-daemon.service
Requires=spur-daemon.service

[Service]
Type=simple
User=<vm-user>
WorkingDirectory=<repo-path>
Environment=HOME=<home-dir>
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=WEB_HOST=127.0.0.1
Environment=DIRECT_TERMINAL_BIND_HOST=127.0.0.1
Environment=DIRECT_TERMINAL_BIND_PORT=14801
Environment=DIRECT_TERMINAL_PUBLIC_PORT=443
ExecStart=/usr/bin/pnpm ui:start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable both:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spur-daemon.service spur-web.service
```

## Reverse Proxy

Bind `nginx` only to the addresses you want to expose.

Example: localhost plus a private Tailscale IP.

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

Check and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Validation

Check local process boundaries first:

```bash
curl http://127.0.0.1:4310/sessions
curl -I http://127.0.0.1:5555
curl http://127.0.0.1:5555/api/runtime/terminal
ss -ltnp | egrep ':(4310|3012|5555|14801)\b'
```

For a private Tailscale deployment, verify the UI from another tailnet device:

```bash
curl -I http://100.64.0.10:5555
curl http://100.64.0.10:5555/api/runtime/terminal
```

If the deployment should not be public, confirm the public VM IP does not answer on the proxy port.

## Release Flow

Recommended release flow:

1. Merge the repo change to `main` through GitHub.
2. SSH into the VM.
3. Run the explicit deploy command.
4. Re-run local and remote probes.

Example:

```bash
cd ~/projects/spur
pnpm main:deploy
curl http://127.0.0.1:4310/sessions
curl http://127.0.0.1:5555/api/runtime/terminal
```

`pnpm main:deploy` uses `MAIN_DEPLOY_ROOT` when set and otherwise keeps its managed release clone under `~/.spur/main-deploy/repo`. It installs the systemd units for the account running the script, or `MAIN_DEPLOY_SERVICE_USER` and `MAIN_DEPLOY_SERVICE_HOME` when those are set. It fetches the latest `origin/main`, builds there, restarts the services only after a successful build, and records the last successfully deployed SHA so the next cron run retries a failed release instead of treating a pulled-but-unreleased commit as complete.

## Automated Main Releases

To auto-release `main` every hour from an isolated release clone:

```bash
crontab -l > /tmp/spur.cron
printf '%s\n' '0 * * * * MAIN_DEPLOY_ROOT=$HOME/.spur/main-deploy/repo /usr/bin/pnpm -C $HOME/projects/spur run main:deploy >> $HOME/.spur/main-cron-deploy.log 2>&1' >> /tmp/spur.cron
crontab /tmp/spur.cron
rm /tmp/spur.cron
```

Keep the hourly cron pointed at a normal repo checkout only as the command entrypoint. The actual deploy work happens inside `MAIN_DEPLOY_ROOT`, which should stay reserved for automation and not for day-to-day editing.

## Operational Notes

- `spur-daemon.service` and `spur-web.service` should be `enabled`, not just started
- keep the daemon and Next.js app on loopback even when the UI is proxied
- do not point the browser directly at the terminal bind port
- set `DIRECT_TERMINAL_PUBLIC_PORT` to the reverse proxy port the browser will actually use
- if `gh` is not authenticated on the VM, disable GitHub sources and triggers in the runtime config
- if `codex` or `claude` is not authenticated on the VM, session spawn will fail even if the UI is healthy

## Logs

```bash
systemctl status spur-daemon.service
systemctl status spur-web.service
journalctl -u spur-daemon.service -n 100 --no-pager
journalctl -u spur-web.service -n 100 --no-pager
```
