# Deploy Spur To An Ubuntu VM

This guide is for a generic Ubuntu VM running Spur's daemon and optional web UI.

It assumes:

- you deploy from a GitHub checkout, not by copying the repo tree onto the VM
- the VM already has SSH access and GitHub SSH access
- you want `v2/` to remain the runtime source of truth
- you optionally want the web UI exposed through a reverse proxy

## Recommended Shape

Run three pieces:

- Spur daemon on loopback, for example `127.0.0.1:4311`
- web UI on loopback, for example `127.0.0.1:3012`
- reverse proxy on the VM, for example `nginx`, bound only where you want the UI reachable

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

Create a VM-local Spur config such as `~/projects/spur/spur.vm.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 4311

dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
defaultAgent: codex

projects:
  spur:
    path: ~/projects/spur
    defaultBranch: main
    sessionPrefix: spur
    worktree: true
    symlinks:
      - node_modules
```

Notes:

- keep the daemon on loopback
- point `projects.<id>.path` at the real checkout
- keep `node_modules` as a symlink when using worktrees for this repo
- add GitHub sources or triggers only after `gh auth login` is working on the VM

## Systemd Services

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
ExecStart=/usr/bin/node <repo-path>/v2/dist/cli.js daemon start --config <repo-path>/spur.vm.yaml
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
Environment=SPUR_CONFIG=<repo-path>/spur.vm.yaml
Environment=SPUR_DAEMON_URL=http://127.0.0.1:4311
Environment=WEB_HOST=127.0.0.1
Environment=DIRECT_TERMINAL_BIND_HOST=127.0.0.1
Environment=DIRECT_TERMINAL_BIND_PORT=14801
Environment=DIRECT_TERMINAL_PUBLIC_PORT=3011
Environment=PORT=3012
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
    listen 127.0.0.1:3011;
    listen 100.x.y.z:3011;
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
curl http://127.0.0.1:4311/sessions
curl -I http://127.0.0.1:3011
curl http://127.0.0.1:3011/api/runtime/terminal
ss -ltnp | egrep ':(3011|3012|4311|14801)\b'
```

For a private Tailscale deployment, verify the UI from another tailnet device:

```bash
curl -I http://100.x.y.z:3011
curl http://100.x.y.z:3011/api/runtime/terminal
```

If the deployment should not be public, confirm the public VM IP does not answer on the proxy port.

## Release Flow

Recommended release flow:

1. Merge the repo change to `main` through GitHub.
2. SSH into the VM.
3. Pull the new `main`.
4. Reinstall dependencies if the lockfile changed.
5. Rebuild.
6. Restart the services.
7. Re-run local and remote probes.

Example:

```bash
cd ~/projects/spur
git fetch origin
git checkout main
git pull --ff-only origin main
pnpm install
pnpm build
sudo systemctl restart spur-daemon.service spur-web.service
curl http://127.0.0.1:4311/sessions
curl http://127.0.0.1:3011/api/runtime/terminal
```

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

