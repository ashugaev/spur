# Install from npm

> Agent-first doc: terse and command-dense so an AI agent can run it top to bottom. Human-runnable too — it stays readable where that costs the agent nothing.

Run Spur on a fresh Linux server. This is the required path for coding-agent installs. Use source only for contributors/maintainers, and only when the user explicitly asks for source: [install-from-source.md](install-from-source.md).

Package ships the web UI prebuilt — no on-box build.

Verified on Ubuntu 24.04 LTS, down to a ~1GB-RAM box (no swap). Node version: range in [`package.json`](../package.json) `engines.node` (Ubuntu's apt build is too old — use nodesource or nvm).

## Requirements

- Lower bar 2 GB RAM, 2 cores — daemon, web UI, and a few parallel agent sessions.
- Scale by concurrent agents: each session is an agent process plus whatever it runs (dev servers, builds, test suites). Size RAM/cores to how many agents you keep working at once and how heavy their per-session environment is — Spur's own footprint is small.

## Setup

```bash
npm config set prefix ~/.local      # required — see gotchas
npm install -g @shugaev/spur@latest
spur init                           # installs + starts the systemd user units, links host skills
```

Two non-obvious points:

- Prefix must be `~/.local` — a system prefix (`/usr`) fails install with `EACCES` and makes the units exec the wrong path (`status=203/EXEC`). Put `~/.local/bin` on PATH, persisted for new logins. The `npm config set prefix ~/.local` above writes into `~/.npmrc`, needed once to land the very first `npm install -g @shugaev/spur` before Spur exists to pin anything. After the daemon's first boot (`spur init`/`update`/`reinit`, a reboot, or `systemctl restart`), the pin moves to Spur's own `~/.spur/npmrc` as npm's `--globalconfig` — never `~/.npmrc`, which `nvm` refuses to load once it carries a `prefix=`/`globalconfig=` line. `spur init`/`update`/`reinit` strip that line back out of `~/.npmrc` only on hosts with nvm installed — on a host without nvm the line stays, since it's what makes a bare `npm install -g` (outside any agent session) land in `~/.local` at all, and nothing there conflicts with it. A plain daemon boot leaves `~/.npmrc` alone either way. `spur doctor`'s `npmrc-nvm-conflict` check applies the same nvm gate and gives the one-liner to remove a leftover line (system-unit hosts, see below, can't run `spur reinit`).
- `npm install` only unpacks — it starts nothing and won't survive reboot. `spur init` installs the units, starts them, and enables linger. `spur init` also links the packaged Spur agent skills into `~/.claude/skills` and `~/.codex/skills` when that `skills` directory already exists — never creating an absent one — replacing its own links (including a dangling one under any `.../skills/<name>` path) on every release, and leaving a real file, directory, or foreign symlink untouched. An absent dir is skipped with a warning naming the path and the fix (`mkdir -p <path> && spur reinit`). See [Doctor](commands.md#doctor)'s `skills-symlinks` check.
- Every agent session carries `NPM_CONFIG_GLOBALCONFIG=~/.spur/npmrc` (both env casings) in its env, so `claude`/`codex` self-update (`npm install -g ...`) resolves `~/.local` even mid-session. That only holds as long as `~/.npmrc` carries no `prefix=` line pointing anywhere other than `~/.local` — a Spur-authored `prefix=~/.local` line left there (non-nvm hosts, see above) is harmless since it resolves to the same value; an operator-set line to any other value outranks this pin and self-update would follow that instead. Sidecars, project services, and the Claude OAuth login pane do NOT inherit this pin — Spur strips it (along with `NPM_CONFIG_PREFIX`/`PREFIX`) so those panes can source `~/.nvm/nvm.sh` without tripping nvm's own incompatibility guards; a bare `npm install -g` in one of those panes falls back to npm's system prefix. A bare `npm install -g` in a plain login shell (not an agent session) needs an explicit `--prefix ~/.local`, or use `spur update` (below), which derives it automatically.

Units installed:

| Unit                  | Role                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `spur-daemon.service` | HTTP API `:4310`, tmux sessions                                                 |
| `spur-web.service`    | Web UI `:5555`; terminal WebSocket in-process on `/ws` (same port, no own unit) |

Daemon unit bounds the shared fleet cgroup with `MemoryHigh=75%`, `MemoryMax=85%`, and `MemorySwapMax=2G`. On a 62 GiB host, reclaim starts near 46.5 GiB and the hard cap lands near 52.7 GiB, leaving about 15.5 GiB and 9.3 GiB for the host. The daemon shares this cgroup, so sustained pressure can throttle its guard; the gap preserves control-path room. Set `MemorySwapMax=0` in a systemd drop-in for no fleet swap. Package templates have no live effect until `spur init` or `spur update` reinstalls units.

Spur drives Claude Code, Codex, and OpenCode. Install whichever the host doesn't already have; keep any that are present:

```bash
command -v claude >/dev/null || npm install -g --prefix ~/.local @anthropic-ai/claude-code
command -v codex  >/dev/null || npm install -g --prefix ~/.local @openai/codex
command -v opencode >/dev/null || npm install -g --prefix ~/.local opencode-ai
```

Authenticate OpenCode once before spawning it:

```bash
opencode auth login
```

Claude and Codex still need a login under your own account (`claude`, or `codex login`) before they can spawn sessions — interactive, not scriptable. A setup agent or unattended install can't log you in, so it leaves every login to the operator TODO below.

`spur doctor` diagnoses host setup and points at what's missing.

### init flags

| Flag                | Effect                                      |
| ------------------- | ------------------------------------------- |
| `--no-start`        | install units + linger, don't start         |
| `--expose-web`      | bind web to `0.0.0.0` (default `127.0.0.1`) |
| `--web-port <port>` | web port (default `5555`)                   |
| `--no-tailscale`    | skip Tailscale (on by default)              |

## Private access (Tailscale, default on)

`spur init` sets up private web access over your tailnet — your devices only, never public. Opt out with `--no-tailscale`.

Auth is yours — two ways to bring the tailnet up:

- Human: `sudo tailscale up`, sign in at the printed URL.
- Unattended (agent / scripted): `sudo tailscale up --authkey <tskey-...>` — no browser. Mint a key at `https://login.tailscale.com/admin/settings/keys`. This login is the only step that otherwise blocks a hands-off install; an agent handed a key does the whole thing end to end.

Then re-run `spur init` — it resolves your tailnet IPv4 and widens `spur-web`'s `WEB_HOST` to `127.0.0.1,<tailnet-ip>`. Until the tailnet is up it stays loopback-only. `--expose-web` (public `0.0.0.0`) is a separate explicit override that supersedes Tailscale.

### HTTPS (voice input only)

Wanted voice input? Tailnet up → terminate TLS on the tailnet hostname, verify `200`: [https-tailscale.md](https-tailscale.md). Voice also needs its own server deps ([voice.md](voice.md)); the UI, terminal, and agents all work over plain HTTP, so skip this whole step when voice is not wanted.

Skip too when another service holds 443 — never displace it. On failure report that doc's blocker message; the rest of the install stands.

## Identity steps (operator TODO)

A few steps use your own accounts and each needs one interactive action — they can't be scripted, and a setup agent must not hack around them. Do everything else first, then hand the operator this list:

- Log in an agent — `claude` (sign in) or `codex login` — then run it once interactively to completion. A logged-in-but-never-run-interactively `claude` still breaks the first spawn: Spur's injected prompt lands in the unfinished first-run onboarding screen instead of the agent, surfacing as `OAuth error: Invalid code`. At least one agent, fully onboarded, is required before Spur can spawn sessions.
- Bring up private web access — `sudo tailscale up` (browser login), then re-run `spur init`. Skip only if you used `--authkey` (above) or `--expose-web`.
- Voice input only: enable MagicDNS and HTTPS Certificates for the tailnet — admin console → DNS, owner/admin only. Nothing else needs them.

Spur installs and its services start without these; until the first two are done it stays loopback-only and can't spawn sessions. Where a non-interactive credential exists (Tailscale `--authkey`, an agent API key via `codex login --with-api-key`), an unattended install uses it instead of deferring.

## Verify

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5555/           # 200
```

Terminal rides `/ws` on the web port — no separate port or check.

After a start/restart the units can take up to ~2 min to answer on a ~1 GB host — poll, don't fail on the first refusal.

## Connect a project

```bash
cd <repo>
spur connect --config spur.yaml
spur spawn <project-id> --branch <branch> "smoke test" --json
```

## Upgrade

```bash
spur update
```

`spur update` runs `npm install -g` itself with the correct `--prefix` derived from the current install (not a bare `npm install -g`, which would need its own explicit `--prefix ~/.local` now that `~/.npmrc` no longer carries the prefix — see the setup gotchas), then reinstalls units and makes up to 60 daemon and web readiness polls. A failed reinit exits the command; after a successful reinit, the detached health monitor owns auto-rollback. Not a bare `systemctl restart`: restart reuses the old unit files, and unit contracts change across versions (e.g. the `/ws` move rewrote `spur-web`'s `ExecStart` and dropped a now-removed terminal unit). Deploy switch route behavior lives in [daemon-api.md](daemon-api.md#daemon-http-api).

With [`autoUpdate: true`](configuration.md#auto-update) the daemon self-updates once a newer version publishes, through the same deploy-switch path. Pin a version by hand in this order:

1. Set `autoUpdate: false` in `~/.spur/config.yaml`. No daemon restart needed.
2. Then `spur update <version>` — add `--force` if it refuses.

Pin first and the flag is still armed: within the next 5-minute tick the daemon sees a newer published version and moves the host straight off the pin. A CLI pin writes no deploy-switch status record, so it suppresses nothing on its own — clearing the flag is what stops the daemon.

`spur update` logs each attempt and its outcome — event names in [configuration.md#auto-update](configuration.md#auto-update).

## Security

- Secrets stay on this host: `~/.spur/daemon.env` (mode `0600`), or `${VAR}` placeholders resolved from its env. Never copy them between hosts.
- Agent auth (`codex login`, `gh auth login`) belongs on this host only.

## Troubleshooting

| Symptom                                                | Fix                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `status=203/EXEC` or `EACCES .../usr/lib/node_modules` | npm prefix isn't `~/.local` — run `spur init` (re-writes `~/.spur/npmrc`), or reset it manually and reinstall |
| units die after SSH logout                             | linger off: `loginctl enable-linger $USER`                                                                    |
| web terminal `/ws` won't connect                       | `spur-web` not running: `spur init` or `systemctl --user restart spur-web`                                    |
| `/ws` closes immediately                               | no `pty.node` prebuild for this arch/libc — terminal disabled, UI fine; file an issue                         |
| web unreachable over Tailscale                         | tailnet not up: `sudo tailscale up`, then re-run `spur init`                                                  |
| mic button dead on the tailnet URL                     | page served over plain HTTP — [https-tailscale.md](https-tailscale.md)                                        |
| first spawn: `OAuth error: Invalid code`               | `claude` logged in but never run interactively to completion — run it once to finish onboarding               |

## System-wide units (advanced)

`spur init` installs user units. For system scope (`/etc/systemd/system/`, `User=`), adapt `deploy/spur-daemon.service` / `deploy/spur-web.service` and set `SYSTEMCTL="sudo systemctl"` in the daemon env. Don't run `spur update` / `spur reinit` on a system-unit host — both take the user-scope path and spin up a conflicting `:4310` daemon. When a version changes the unit contract, re-copy the adapted templates, run `systemctl daemon-reload`, then restart the system units in a maintenance window. The `~/.spur/npmrc` pin file itself still gets created here — every `daemon start` writes it, regardless of scope. Only the `~/.npmrc` heal is `spur init`/`update`/`reinit`-only (unsupported on this scope): if `spur doctor`'s `npmrc-nvm-conflict` check fires, remove the reported `prefix=`/`globalconfig=` line from `~/.npmrc` by hand — the check's `fix` field spells out the exact line to look for.

## Reference

CLI: [commands.md](commands.md). Config: [configuration.md](configuration.md).
