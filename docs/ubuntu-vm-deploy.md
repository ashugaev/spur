# Deploy Spur To An Ubuntu VM

Deploy from a GitHub checkout (not by copying the repo tree). VM needs SSH and GitHub SSH access. `v2/` is runtime source of truth. Expose the web UI through a reverse proxy for browser access beyond loopback.

For an AI agent doing a full interactive install on a clean VM, start at [AI Agent Playbook — Install mode](#ai-agent-playbook) (intake questions, staged validation gates, user dialog). Human operators can follow [Quick Start](#quick-start) directly.

## Recommended Shape

- Spur daemon on loopback: `127.0.0.1:4310`.
- Web UI on loopback: `127.0.0.1:3012`.
- Terminal websocket on loopback: `127.0.0.1:14801`.
- Reverse proxy (`nginx`) on loopback by default; optionally also on a private interface (private VM IP, Tailscale IP, or VPN address) at port `5555`.

Keep daemon, web, and terminal sockets on loopback. The reverse proxy is the only externally-bound surface. Set `DIRECT_TERMINAL_PUBLIC_PORT` to the port browsers reach (`5555` for plain HTTP, `443` for TLS in front). Do not bind `0.0.0.0` unless the VM is intentionally public.

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
| Voice secrets                   | `~/.spur/.env`                                              | local                       | Mode 0600; Azure or OpenAI-compatible keys for voice providers           |
| Voice models                    | `~/.cache/whisper.cpp/`, `~/.spur/venvs/faster-whisper/`    | local                       | Per voice provider                                                       |
| Built daemon                    | `~/projects/spur/v2/dist/`                                  | local (gitignored)          | Produced by `pnpm build`                                                 |
| Web build                       | `~/projects/spur/packages/web/.next/`                       | local (gitignored)          | Produced by `pnpm build`                                                 |
| Sidecar deps                    | `~/projects/spur/.next-sidecars/`, sidecar `node_modules`   | local (gitignored)          | Installed on first sidecar start                                         |
| Worktrees root                  | `~/.spur/worktrees`                                         | local                       | Per `worktreeDir` in instance config                                     |

## Quick Start

1. Install host packages — `sudo apt-get update && sudo apt-get install -y git tmux nginx gh curl ca-certificates`. Verify: `git --version && tmux -V && nginx -v && gh --version`.
2. Install Node.js 20 (NodeSource or nvm — see Prerequisites). Verify: `node -v` prints `v20.x` or later.
3. Enable corepack and pin pnpm — `sudo corepack enable && sudo corepack prepare pnpm@9.15.4 --activate`. Verify: `pnpm -v` prints `9.15.4`. pnpm@9.15.4 is required because pnpm@11+ uses vm dynamic-import callback semantics incompatible with Node 24, producing a cryptic `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` error on startup.
4. Install user-scoped agent CLIs and authenticate (see Agent CLI Auth). Verify: `codex --version && claude --version && gh auth status`.
5. Clone repo to `~/projects/spur`, checkout `main`, run `pnpm install && pnpm build`. Verify: test -f ~/projects/spur/v2/dist/cli.js.
6. Provision `/etc/spur/daemon.env` (copy from `deploy/spur-daemon.env.example`, fill `AZURE_OPENAI_API_KEY`, chmod 0600 root:root). Verify: `sudo stat -c '%a %U:%G' /etc/spur/daemon.env` prints `600 root:root`.
7. Write `~/.spur/config.yaml` instance config (loopback 4310, UI 5555, tmux socket `spur-4310`). Verify: `node -e "require('js-yaml').load(require('fs').readFileSync(process.env.HOME+'/.spur/config.yaml','utf8'))"` exits 0 (or use any YAML linter).
8. Run `pnpm main:deploy` to install systemd units, build, and restart services. On first install also run `sudo systemctl enable --now spur-daemon.service spur-web.service`. Verify: `systemctl is-active spur-daemon.service spur-web.service` both return `active`.
9. Configure nginx site (loopback + optional private IP listeners on 5555), `sudo nginx -t && sudo systemctl reload nginx`. Verify: `curl -I http://127.0.0.1:5555`.
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

### Pre-flight: claude permission preferences

Spur launches claude with `--dangerously-skip-permissions`. On a fresh box, claude shows a one-time per-cwd "Bypass Permissions mode — accept?" prompt that blocks the spawn. Pre-populate user-level settings to skip it:

```bash
mkdir -p ~/.claude
python3 -c "
import json, os
p = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('skipDangerousModePermissionPrompt', True)
d.setdefault('skipAutoPermissionPrompt', True)
json.dump(d, open(p,'w'), indent=2)
"
```

Similarly, if your project's `CLAUDE.md` does `@`-imports of files outside the worktree, claude will show an "Allow external CLAUDE.md file imports?" prompt — same one-time flavor. Either accept it once interactively, or set `hasClaudeMdExternalIncludesApproved: true` for the project via the same mechanism.

### Optional: install gitleaks

`.husky/pre-commit` invokes `gitleaks` for secret scanning. Install it if you intend to commit from this box:

```bash
mkdir -p ~/.local/bin
gh release download --repo gitleaks/gitleaks v8.30.1 -p 'gitleaks_*_linux_x64.tar.gz' -D /tmp
tar -xzf /tmp/gitleaks_*_linux_x64.tar.gz -C ~/.local/bin gitleaks
chmod +x ~/.local/bin/gitleaks
```

### Spur tmux socket

Spur uses a dedicated tmux socket (default `spur-4310`, configured via `tmux.socketName` in `~/.spur/config.yaml`). Plain `tmux ls` looks at the wrong socket and returns no sessions. To list/attach Spur sessions:

```bash
tmux -L spur-4310 ls
tmux -L spur-4310 attach -t <session>          # Ctrl+B D to detach
tmux -L spur-4310 capture-pane -t <session> -p # snapshot
```

Adjust the `-L` value to match your `tmux.socketName` in `~/.spur/config.yaml`.

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
defaultAgent: claude
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
- `Environment=DIRECT_TERMINAL_PUBLIC_PORT=443` — set to the port browsers reach (5555 for plain HTTP via nginx, 443 when a TLS terminator sits in front). Override per VM with a systemd drop-in (see Install stage I10).
- `Requires=spur-daemon.service`

First install: Quick Start step 8 (`daemon-reload` then `enable --now`). Subsequent releases: `pnpm main:deploy` only — reloads changed units and restarts after a successful build. Inspect live units at `/etc/systemd/system/spur-*.service` or the repo templates; do not maintain a third copy in docs.

## Reverse Proxy

Bind `nginx` only to addresses you want to expose. Example: localhost plus one private interface (substitute `<private-ip>` for the VM's private/Tailscale/VPN address).

```nginx
server {
    listen 127.0.0.1:5555;
    listen <private-ip>:5555;
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

`openai_compatible` is the no-installation path: no whisper.cpp build, no faster-whisper venv, no Azure deployment. Configure `voice.baseUrl` and `voice.apiKey` and set the key in `~/.spur/.env`.

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

Local probes: Quick Start step 10. For deployments bound to a private IP, also probe from another device on the same private network:

```bash
curl -I http://<private-ip>:5555
curl http://<private-ip>:5555/api/runtime/terminal
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

This section is the install spec for an AI agent. Read it once, run stages in order, never skip a validation gate.

Two modes:

- Install mode — fresh or partial VM. Follow stages I0–I14 below.
- Operate mode — production is up. Follow [Operate mode](#operate-mode).

### Agent rules (apply to every stage)

You MUST:

- Read every stage's Do and Validate block before running anything.
- Run the Validate block after every Do block and parse the exit code and output.
- Stop on the first failed gate. Report stage id, exact command, exit code, last 50 lines of relevant log. Do not advance until the gate passes.
- Prefer defaults from this doc. Ask the user only for the values in the Intake block below.
- Re-run any stage's Do + Validate as needed; all commands are idempotent.
- Treat `~/.spur/`, `/etc/spur/`, `/etc/systemd/system/`, and `/etc/nginx/sites-enabled/spur` as the only places you write outside the repo checkout.

You MUST NOT:

- Invent secrets, repo names, IP addresses, ports, or usernames. Use intake values or defaults.
- Echo secrets (`AZURE_OPENAI_API_KEY`, auth tokens) into logs, terminal scrollback, or chat. Write them only to `/etc/spur/daemon.env` or `~/.spur/.env`.
- Hand-edit files under `/etc/systemd/system/spur-*.service`. They are overwritten by `pnpm main:deploy`. Use systemd drop-ins for per-VM overrides.
- Hand-edit anything inside `MAIN_DEPLOY_ROOT` (`~/.spur/main-deploy/repo`).
- Run `sudo npm install -g`. Agent CLIs must be user-scoped under `~/.npm-global/bin`.
- Use `kill -9` on daemon processes. `pnpm main:deploy` already cleans rogue PIDs via `kill_rogue_daemon_on_port`.
- Skip the user dialog on interactive auth (`codex login`, `claude login`, `gh auth login`). Ask the user to run them at their terminal, wait, then validate.

### Intake (single batched ask)

Send the user one message that requests these. Items marked Required MUST be answered before starting stage I0. Items marked Optional default to the value in parentheses.

Required:

1. GitHub repo to clone, as `owner/repo`.
2. `AZURE_OPENAI_API_KEY` — paste in the terminal at stage I7, NOT in chat. The agent never receives it.
3. Which agent CLIs to authenticate: `codex`, `claude`, or both. (Default: both.)

Optional (defaults are safe; only change if the user objects):

4. Service account user on the VM. (Default: current shell user, from `id -un`.)
5. Checkout path. (Default: `~/projects/spur`.)
6. Deploy branch. (Default: `main`.)
7. Network exposure: `loopback-only`, `private-ip`, or `tailscale`. (Default: `loopback-only`.)
8. Private bind IP — required only when (7) is `private-ip` or `tailscale`. No default.
9. Reverse proxy port browsers will use. (Default: `5555`.)
10. Browser-facing scheme/port for terminal websocket — `5555-http` (plain) or `443-https` (TLS proxy in front). (Default: `5555-http`.)
11. Default spawn agent in `~/.spur/config.yaml`. (Default: `claude`.)
12. Enable hourly `main:deploy` cron. (Default: `no`.)
13. Enable voice input. (Default: `no`.)
14. Extra projects to register in the running instance via `spur connect`. (Default: none beyond the cloned repo.)

If any Required item is missing, list it and stop. Do not guess.

Once intake is complete, export the answers as shell variables in your working session and reuse them throughout the stages:

```bash
export SPUR_REPO="<owner>/<repo>"
export SPUR_USER="$(id -un)"                       # or intake answer
export SPUR_CHECKOUT="$HOME/projects/spur"          # or intake answer
export SPUR_BRANCH="main"                           # or intake answer
export SPUR_EXPOSURE="loopback-only"                # loopback-only | private-ip | tailscale
export SPUR_PRIVATE_IP=""                           # set when exposure != loopback-only
export SPUR_PROXY_PORT="5555"                       # or intake answer
export SPUR_TERMINAL_PUBLIC_PORT="5555"             # 5555 if plain http, 443 if TLS
export SPUR_DEFAULT_AGENT="claude"                  # claude | codex
export SPUR_AGENT_CLIS="codex claude"               # subset of "codex claude"
```

### Install stages

Notation: each stage has an id `I<n>`, a Do block (commands the agent runs or asks the user to run), a Validate block (the gate), and a Recovery block (what to do on fail). The Validate block is authoritative — only its exit codes decide pass/fail.

#### I0 — Preconditions

Do: confirm Ubuntu, shell access, and `sudo`.

```bash
uname -a
id -un
sudo -n true 2>/dev/null || echo "sudo:needs-password"
```

Validate (pass requires all true):

```bash
[ "$(uname -s)" = "Linux" ] && [ -n "$(id -un)" ] && sudo -v
```

Recovery: if `sudo -v` fails, ask the user to run `sudo -v` interactively in the same terminal session, then re-validate.

#### I1 — Host packages

Do:

```bash
sudo apt-get update
sudo apt-get install -y git tmux nginx gh curl ca-certificates jq
```

Validate:

```bash
git --version && tmux -V && nginx -v && gh --version && curl --version | head -1 && jq --version
```

Recovery: re-run the install for any missing tool, then re-validate.

#### I2 — Node.js 20

Do (NodeSource path; pick nvm only if intake says user-scoped):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Validate:

```bash
node -v | grep -E '^v(20|2[1-9])\.' >/dev/null
```

Recovery: if `node -v` is missing or wrong major, remove the previous Node install (`sudo apt-get remove -y nodejs`) and re-run Do. For nvm path, see Prerequisites.

#### I3 — pnpm

Do:

```bash
sudo corepack enable
sudo corepack prepare pnpm@9.15.4 --activate
```

Validate:

```bash
pnpm -v | grep -E '^9\.15\.4$' >/dev/null
```

Recovery: re-run `sudo corepack prepare pnpm@9.15.4 --activate`. If `corepack` is missing, install via `sudo npm install -g corepack` and retry.

#### I4 — Agent CLIs (user-scoped) and GitHub SSH

Do (run as the service-account user, NOT root):

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
grep -qF '$HOME/.npm-global/bin' "$HOME/.profile" \
  || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.profile"
. "$HOME/.profile"

# Install only the CLIs in $SPUR_AGENT_CLIS plus gh dependency installs
for cli in $SPUR_AGENT_CLIS; do
  case "$cli" in
    codex)  npm install -g @openai/codex ;;
    claude) npm install -g @anthropic-ai/claude-code ;;
  esac
done
```

Tell the user to run these in their terminal (you cannot complete interactive auth on their behalf):

```bash
[ -n "$(echo "$SPUR_AGENT_CLIS" | grep -ow codex)" ] && codex login
[ -n "$(echo "$SPUR_AGENT_CLIS" | grep -ow claude)" ] && claude login
gh auth login
```

Validate:

```bash
case " $SPUR_AGENT_CLIS " in *" codex "*)  command -v codex  && codex  --version ;; esac
case " $SPUR_AGENT_CLIS " in *" claude "*) command -v claude && claude --version ;; esac
gh auth status
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -q "successfully authenticated"
```

Recovery:

- CLI not found: ensure `$HOME/.npm-global/bin` is on PATH for new shells (`. "$HOME/.profile"`).
- `gh auth status` fails: user re-runs `gh auth login`.
- SSH fails: user adds an SSH key to GitHub; agent does not generate or upload keys.

#### I5 — Clone

Do:

```bash
mkdir -p "$(dirname "$SPUR_CHECKOUT")"
git clone "git@github.com:${SPUR_REPO}.git" "$SPUR_CHECKOUT"
git -C "$SPUR_CHECKOUT" checkout "$SPUR_BRANCH"
```

Validate:

```bash
git -C "$SPUR_CHECKOUT" rev-parse --abbrev-ref HEAD | grep -qx "$SPUR_BRANCH"
test -f "$SPUR_CHECKOUT/package.json"
test -f "$SPUR_CHECKOUT/scripts/main-deploy.sh"
```

Recovery: if clone fails, capture the git error and revisit I4 (SSH). If branch missing, list `git -C "$SPUR_CHECKOUT" branch -a` for the user and ask which branch to deploy.

#### I6 — Install and build

Do:

```bash
cd "$SPUR_CHECKOUT"
pnpm install --frozen-lockfile
pnpm build
```

Validate:

```bash
test -f "$SPUR_CHECKOUT/v2/dist/cli.js"
test -d "$SPUR_CHECKOUT/packages/web/.next"
```

Recovery: print last 100 lines of build output, ask the user whether to retry or report a code issue. Do not modify source files to "fix" build errors during install — open a separate task.

#### I7 — Daemon secrets

Do: ask the user to paste `AZURE_OPENAI_API_KEY` directly into the terminal command below (NOT in chat). Then:

```bash
sudo install -d -m 0755 /etc/spur
sudo cp "$SPUR_CHECKOUT/deploy/spur-daemon.env.example" /etc/spur/daemon.env
sudo chown root:root /etc/spur/daemon.env
sudo chmod 0600 /etc/spur/daemon.env
sudo "$EDITOR" /etc/spur/daemon.env   # user replaces placeholder
```

Validate:

```bash
sudo test -f /etc/spur/daemon.env
sudo stat -c '%a %U:%G' /etc/spur/daemon.env | grep -qx '600 root:root'
sudo grep -Eq '^AZURE_OPENAI_API_KEY=.+' /etc/spur/daemon.env
sudo grep -Eq '^AZURE_OPENAI_API_KEY=<' /etc/spur/daemon.env && exit 1 || true
```

Recovery: if the placeholder `<paste-azure-openai-key-here>` is still present, ask the user to edit again. Never log the file contents to chat.

#### I8 — Instance config

Do:

```bash
install -d -m 0755 "$HOME/.spur"
cat > "$HOME/.spur/config.yaml" <<EOF
server:
  host: 127.0.0.1
  port: 4310

dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
defaultAgent: ${SPUR_DEFAULT_AGENT}

tmux:
  socketName: spur-4310

ui:
  port: ${SPUR_PROXY_PORT}
EOF
```

Validate:

```bash
node -e "require('js-yaml').load(require('fs').readFileSync(process.env.HOME+'/.spur/config.yaml','utf8'))"
grep -q '^defaultAgent: '"$SPUR_DEFAULT_AGENT"'$' "$HOME/.spur/config.yaml"
```

Recovery: rewrite the file with corrected values, re-validate. `js-yaml` is bundled in the checkout's `node_modules`; run from `$SPUR_CHECKOUT` if not globally available.

#### I9 — Project registration

Do (the repo ships `spur.yaml`; this stage registers it with the running instance once the daemon starts in I10):

```bash
test -f "$SPUR_CHECKOUT/spur.yaml" || { echo "missing project config"; exit 1; }
# spur connect is run in I10 after the daemon is up
```

Validate:

```bash
test -f "$SPUR_CHECKOUT/spur.yaml"
grep -Eq '^projects:' "$SPUR_CHECKOUT/spur.yaml"
```

Recovery: for a fresh repo that does not ship `spur.yaml`, scaffold one with `node "$SPUR_CHECKOUT/v2/dist/cli.js" doctor` from inside the checkout. `doctor` refuses to overwrite an existing file.

#### I10 — Optional terminal port override (drop-in)

Do this stage only when `$SPUR_TERMINAL_PUBLIC_PORT` differs from the value committed in `deploy/spur-web.service` (currently `443`).

Do:

```bash
sudo install -d -m 0755 /etc/systemd/system/spur-web.service.d
sudo tee /etc/systemd/system/spur-web.service.d/override.conf >/dev/null <<EOF
[Service]
Environment=DIRECT_TERMINAL_PUBLIC_PORT=${SPUR_TERMINAL_PUBLIC_PORT}
EOF
sudo systemctl daemon-reload
```

Validate:

```bash
sudo systemd-analyze cat-config systemd/system/spur-web.service.d/override.conf \
  | grep -q "DIRECT_TERMINAL_PUBLIC_PORT=${SPUR_TERMINAL_PUBLIC_PORT}"
```

Recovery: re-write the drop-in. Never edit `deploy/spur-web.service` to flip a per-VM port.

#### I11 — First deploy

Do:

```bash
cd "$SPUR_CHECKOUT"
pnpm main:deploy
sudo systemctl daemon-reload
sudo systemctl enable --now spur-daemon.service spur-web.service
```

Note: services use `WorkingDirectory={{SPUR_ROOT}}` substituted to `MAIN_DEPLOY_ROOT` (`~/.spur/main-deploy/repo`), not `$SPUR_CHECKOUT`. The checkout is only the entrypoint for `pnpm main:deploy`.

Validate:

```bash
test "$(systemctl is-active spur-daemon.service)" = active
test "$(systemctl is-active spur-web.service)" = active
test "$(systemctl is-enabled spur-daemon.service)" = enabled
test "$(systemctl is-enabled spur-web.service)" = enabled
curl -fsS http://127.0.0.1:4310/sessions | jq -e '.' >/dev/null
curl -fsSI http://127.0.0.1:3012 | head -1 | grep -q '200 OK'
```

Recovery:

```bash
journalctl -u spur-daemon.service -n 200 --no-pager
journalctl -u spur-web.service -n 200 --no-pager
```

Common fixes:

- `EADDRINUSE :4310` → re-run `pnpm main:deploy` (script kills rogue listener).
- Missing `/etc/spur/daemon.env` → return to I7.
- `status=217/USER` on unit → service user mismatch; redeploy with `MAIN_DEPLOY_SERVICE_USER=<user>` env when invoking `pnpm main:deploy`.

#### I12 — Connect project to running instance

Do:

```bash
node "$SPUR_CHECKOUT/v2/dist/cli.js" connect "$SPUR_CHECKOUT/spur.yaml"
```

Validate:

```bash
curl -fsS http://127.0.0.1:4310/projects \
  | jq -e --arg p "$SPUR_CHECKOUT" '.[] | select(.path==$p)' >/dev/null
```

Recovery: if no match, re-run `node "$SPUR_CHECKOUT/v2/dist/cli.js" connect "$SPUR_CHECKOUT/spur.yaml"` and re-validate. Verify the daemon is up (`systemctl is-active spur-daemon.service`) before retrying.

#### I13 — Reverse proxy

Skip if `$SPUR_EXPOSURE` is `loopback-only` and the user accesses the UI through SSH port-forwarding.

Do:

```bash
LISTEN_LINES="    listen 127.0.0.1:${SPUR_PROXY_PORT};"
case "$SPUR_EXPOSURE" in
  private-ip|tailscale)
    LISTEN_LINES="$LISTEN_LINES"$'\n'"    listen ${SPUR_PRIVATE_IP}:${SPUR_PROXY_PORT};"
    ;;
esac

sudo tee /etc/nginx/sites-available/spur >/dev/null <<EOF
server {
${LISTEN_LINES}
    server_name _;

    location /ws {
        proxy_pass http://127.0.0.1:14801/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
    location /terminal-health {
        proxy_pass http://127.0.0.1:14801/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
    location / {
        proxy_pass http://127.0.0.1:3012;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/spur /etc/nginx/sites-enabled/spur
sudo nginx -t
sudo systemctl reload nginx
```

Validate:

```bash
sudo nginx -t
curl -fsSI "http://127.0.0.1:${SPUR_PROXY_PORT}" | head -1 | grep -q '200 OK'
curl -fsS "http://127.0.0.1:${SPUR_PROXY_PORT}/api/runtime/terminal" | jq -e 'type=="object"' >/dev/null
case "$SPUR_EXPOSURE" in
  private-ip|tailscale)
    curl -fsSI "http://${SPUR_PRIVATE_IP}:${SPUR_PROXY_PORT}" | head -1 | grep -q '200 OK'
    ;;
esac
```

Recovery: capture `sudo nginx -T 2>&1` and `sudo tail -n 100 /var/log/nginx/error.log`.

#### I14 — Acceptance

Do: ask the user to open the UI in a browser and start one test session with `$SPUR_DEFAULT_AGENT`.

Validate (programmatic):

```bash
ss -ltnp | grep -E ":(4310|3012|${SPUR_PROXY_PORT}|14801)\b"
curl -fsS http://127.0.0.1:4310/sessions | jq -e 'type=="array"' >/dev/null
curl -fsS "http://127.0.0.1:${SPUR_PROXY_PORT}/api/runtime/terminal" | jq -e 'type=="object"' >/dev/null
```

Validate (user-confirmed):

- User reports UI loads on `http://${SPUR_PRIVATE_IP:-127.0.0.1}:${SPUR_PROXY_PORT}`.
- User reports a test session spawns and the agent terminal is interactive.

Recovery: if UI loads but spawn fails → return to I4 (agent auth). If terminal stream is dead → return to I10 (terminal public port). If proxy returns 502 → check `systemctl is-active spur-web.service`.

Hand-off summary to the user:

- Checkout: `$SPUR_CHECKOUT`. Managed deploy clone: `~/.spur/main-deploy/repo`.
- Services: `spur-daemon.service`, `spur-web.service` (both `active enabled`).
- Daemon URL: `http://127.0.0.1:4310`. Web: `http://127.0.0.1:3012`. Public: `http://${SPUR_PRIVATE_IP:-127.0.0.1}:${SPUR_PROXY_PORT}`.
- Authenticated agent CLIs: list which were activated.
- Optional features status: voice (skipped/configured), cron (skipped/configured).

#### I15 — Optional: voice input

Run only if intake (13) is `yes`. Follow [v2/README.md — Voice Input](../v2/README.md#voice-input). Validate per the provider section there. Microphone in the browser requires HTTPS or `localhost`.

#### I16 — Optional: hourly auto-deploy

Run only if intake (12) is `yes`.

Do:

```bash
( crontab -l 2>/dev/null; \
  echo "0 * * * * MAIN_DEPLOY_ROOT=\$HOME/.spur/main-deploy/repo \
/usr/bin/pnpm -C $SPUR_CHECKOUT run main:deploy >> \$HOME/.spur/main-cron-deploy.log 2>&1" \
) | crontab -
```

Validate:

```bash
crontab -l | grep -q 'pnpm -C .* main:deploy'
test -d "$HOME/.spur/main-deploy/repo"
```

Recovery: rewrite the crontab line; ensure `pnpm` path exists (resolve with `command -v pnpm` and substitute).

### Operate mode

Use when install is done. Every probe targets `127.0.0.1` unless verifying access through the private bind IP.

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
- Output of the four validation curls (4310 sessions, 5555 HEAD, 5555 terminal API, plus private-IP probe if applicable).
- Last 50 lines of each unit's journalctl when either is not `active`.
- Path of any file changed and whether it is portable (repo-tracked) or local (VM-only).
- Install mode: which stages passed, which failed, and open questions still unanswered from intake.

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
