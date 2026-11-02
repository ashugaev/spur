#!/usr/bin/env bash
# Install Spur user systemd units and start services after `npm install -g`.
# npm does not register or start systemd services — run once per host:
#   spur init
# or:
#   npm-init.sh [--no-start] [--expose-web] [--web-port <port>] [--tailscale|--no-tailscale]

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NO_START=0
EXPOSE_WEB=0
WEB_PORT=""
TAILSCALE=1
CONFIG_PATH=""

usage() {
  sed -n '3,8p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start) NO_START=1; shift ;;
    --expose-web) EXPOSE_WEB=1; shift ;;
    --config) CONFIG_PATH="${2:?--config requires a path}"; shift 2 ;;
    --web-port)
      WEB_PORT="${2:-}"
      [[ -n "$WEB_PORT" ]] || {
        echo "npm-init: --web-port requires a value" >&2
        exit 2
      }
      shift 2
      ;;
    --tailscale) TAILSCALE=1; shift ;;
    --no-tailscale) TAILSCALE=0; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "npm-init: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

die() {
  echo "npm-init: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_cmd node
require_cmd npm
require_cmd systemctl
require_cmd loginctl

# `--userconfig` pins the exact file this gate means to read: an inherited
# `npm_config_userconfig` (npx/`npm exec`/`npm run` all set one) outranks
# `$HOME` as npm's userconfig source and would otherwise read a different
# file than `$HOME/.npmrc`. `--globalconfig` reads the persisted prefix pin:
# it lives in Spur's own `$HOME/.spur/npmrc`, not `$HOME/.npmrc` — nvm greps
# `~/.npmrc` for a `prefix=`/`globalconfig=` line and refuses to load when it
# finds one, so Spur never writes the pin there.
# This check runs inside `spur init`/`update`/`reinit` itself (`runNpmInit`
# already called `ensureNpmPinFile` before invoking this script), so a
# failure here means an explicit prefix pin or a userconfig conflict is
# overriding it — the fix is the manual command below, not another `spur
# init` (which would just repeat the same write). Match host-install.ts's
# `npm-prefix` doctor fix in intent: `--location=global` chmods its target
# 0666 regardless of umask, so the fix must chmod it back to 0600.
npm_prefix="$(npm config get prefix --userconfig "$HOME/.npmrc" --globalconfig "$HOME/.spur/npmrc")"
if [[ "$npm_prefix" != "$HOME/.local" ]]; then
  die "npm prefix must be ~/.local (got: $npm_prefix). Run: npm config set prefix ~/.local --location=global --globalconfig \"\$HOME/.spur/npmrc\" && chmod 600 \"\$HOME/.spur/npmrc\""
fi

bash "$PKG_ROOT/scripts/verify-package-files.sh" "$PKG_ROOT" || die "package validation failed (reinstall @shugaev/spur)"

if ! systemctl --user status >/dev/null 2>&1; then
  die "user systemd is unavailable (systemctl --user status failed)"
fi

selected_config="$(node --input-type=module - "$PKG_ROOT" "$UNIT_DIR" "$CONFIG_PATH" "${WEB_PORT:-5555}" <<'NODE'
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [root, unitDir, explicit, webPort] = process.argv.slice(2);
const { resolveInstallationConfig, prepareInstallationConfig } = await import(pathToFileURL(`${root}/dist/installed-instance.js`));
const home = homedir();
const path = resolveInstallationConfig({ home, workingDirectory: home, scope: 'user',
  daemonEnvFile: join(home, '.spur', 'daemon.env'), daemonUnitPath: join(unitDir, 'spur-daemon.service'),
  configModulePath: `${root}/dist/config.js`, ...(explicit ? { configPath: explicit } : {}) });
const config = prepareInstallationConfig(path, Number(webPort));
process.stdout.write(config.configPath);
NODE
)" || die "instance configuration selection failed; existing units preserved"
[[ -n "$selected_config" ]] || die "instance configuration selection returned no path"
export SPUR_CONFIG="$selected_config"

mkdir -p "$UNIT_DIR"
install -m 644 "$PKG_ROOT/deploy/spur-daemon.npm.service" "$UNIT_DIR/spur-daemon.service"
install -m 644 "$PKG_ROOT/deploy/spur-web.npm.service" "$UNIT_DIR/spur-web.service"
install -m 644 "$PKG_ROOT/deploy/spur-mcp.npm.service" "$UNIT_DIR/spur-mcp.service"
install -m 644 "$PKG_ROOT/deploy/spur-mcp-tunnel.npm.service" "$UNIT_DIR/spur-mcp-tunnel.service"
node --input-type=module - "$PKG_ROOT" "$UNIT_DIR" "$selected_config" <<'NODE'
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const [root, unitDir, configPath] = process.argv.slice(2);
const { renderPinnedUnit } = await import(pathToFileURL(`${root}/dist/installed-instance.js`));
for (const name of ['daemon', 'web', 'mcp', 'mcp-tunnel']) {
  const path = `${unitDir}/spur-${name}.service`;
  writeFileSync(path, renderPinnedUnit(readFileSync(path, 'utf8'), configPath, name === 'web'));
}
NODE
required_units=(spur-daemon.service spur-web.service spur-mcp.service)
if [[ -f "$HOME/.spur/mcp-tunnel.env" ]]; then
  required_units+=(spur-mcp-tunnel.service)
else
  systemctl --user disable --now spur-mcp-tunnel.service 2>/dev/null || true
fi

# Remove the obsolete direct-terminal unit left by pre-#573 installs. Its
# ExecStart now points at attach-only library code (the terminal WS is served
# in-process by spur-web), so under Restart=always it would crash-loop silently.
# A re-run of this script (e.g. via `spur update`) must clean it up.
systemctl --user stop spur-direct-terminal.service 2>/dev/null || true
systemctl --user disable spur-direct-terminal.service 2>/dev/null || true
rm -f "$UNIT_DIR/spur-direct-terminal.service"

if [[ "$EXPOSE_WEB" -eq 1 ]]; then
  sed -i 's/Environment=WEB_HOST=127.0.0.1/Environment=WEB_HOST=0.0.0.0/' "$UNIT_DIR/spur-web.service"
fi

if [[ -n "$WEB_PORT" ]]; then
  if grep -q '^Environment=PORT=' "$UNIT_DIR/spur-web.service"; then
    sed -i "s/^Environment=PORT=.*/Environment=PORT=$WEB_PORT/" "$UNIT_DIR/spur-web.service"
  else
    sed -i "/^\\[Service\\]/a Environment=PORT=$WEB_PORT" "$UNIT_DIR/spur-web.service"
  fi
fi

# Private remote access over the user's own tailnet, on by default. This is
# additional to the always-on loopback bind (never a replacement) and is
# skipped when --expose-web already opted into the public 0.0.0.0 bind (that
# is a separate, more permissive, explicit override).
if [[ "$EXPOSE_WEB" -eq 0 && "$TAILSCALE" -eq 1 ]]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "npm-init: tailscale not found, installing (curl -fsSL https://tailscale.com/install.sh | sh)"
    curl -fsSL https://tailscale.com/install.sh | sh || {
      echo "npm-init: tailscale install failed — install manually: https://tailscale.com/download (continuing without it)" >&2
    }
  fi

  ts_ip=""
  if command -v tailscale >/dev/null 2>&1; then
    ts_ip="$(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
  fi

  # Tailscale always assigns IPv4 from the CGNAT range 100.64.0.0/10, so
  # require a 100.x address here — a wildcard/public value (e.g. 0.0.0.0)
  # must never be baked into WEB_HOST and collapse to a public bind.
  if [[ "$ts_ip" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    sed -i "s/^Environment=WEB_HOST=.*/Environment=WEB_HOST=127.0.0.1,$ts_ip/" "$UNIT_DIR/spur-web.service"
    echo "npm-init: web UI will bind 127.0.0.1 and tailnet $ts_ip"
  else
    echo "npm-init: Tailscale not up yet — web UI stays on 127.0.0.1 only. Run: sudo tailscale up  (authenticate in browser), then re-run: spur init"
  fi
fi

loginctl enable-linger "$USER" >/dev/null

systemctl --user daemon-reload
node --input-type=module - "$PKG_ROOT" "$selected_config" <<'NODE'
import { pathToFileURL } from 'node:url';
const { writeInstalledInstance } = await import(pathToFileURL(`${process.argv[2]}/dist/installed-instance.js`));
writeInstalledInstance(process.argv[3]);
NODE

if [[ "$NO_START" -eq 0 ]]; then
  systemctl --user enable "${required_units[@]}"
  systemctl --user stop spur-web.service 2>/dev/null || true
  systemctl --user restart spur-daemon.service
  sleep 2
  systemctl --user start spur-web.service
  systemctl --user restart spur-mcp.service
  if [[ -f "$HOME/.spur/mcp-tunnel.env" ]]; then
    systemctl --user restart spur-mcp-tunnel.service
  fi
fi

echo "npm-init: units installed in $UNIT_DIR"
loginctl show-user "$USER" -p Linger

if [[ "$NO_START" -eq 1 ]]; then
  echo "npm-init: skipped start (--no-start). Run:"
  echo "  systemctl --user enable --now ${required_units[*]}"
  exit 0
fi

web_port="$(grep -E '^Environment=PORT=' "$UNIT_DIR/spur-web.service" | tail -1 | cut -d= -f3-)"
[[ -n "$web_port" ]] || web_port=5555

# Poll instead of sampling is-active once immediately after `start` returns
# (F2: a racy immediate check reported false-positive "active" before a
# later crash).
active_daemon=0
active_web=0
active_mcp=0
# A registry with many configs and sources can take over 20 seconds to become
# reachable after systemd reports the unit active. Keep the install alive long
# enough for that normal boot path before update treats it as a failed deploy.
for _ in $(seq 1 60); do
  active_daemon=0
  active_web=0
  systemctl --user is-active --quiet spur-daemon.service && active_daemon=1
  systemctl --user is-active --quiet spur-web.service && active_web=1
  active_mcp=0
  systemctl --user is-active --quiet spur-mcp.service && active_mcp=1
  daemon_code=000
  if node --input-type=module - "$PKG_ROOT" <<'NODE'
import { pathToFileURL } from 'node:url';
const entrypoint = `${process.argv[2]}/dist/cli.js`;
const { createRealUpdateDeps } = await import(pathToFileURL(`${process.argv[2]}/dist/update.js`));
const deps = createRealUpdateDeps(entrypoint);
const { makeTargets, SERVICE_UNITS } = await import(pathToFileURL(`${process.argv[2]}/dist/update-health.js`));
const targets = makeTargets({ daemon: deps.readDaemonPort(), web: deps.readWebPort(), mcp: deps.readMcpPort() });
const results = await Promise.all(deps.requiredServices().map(async id => {
  const [probe, state] = await Promise.all([deps.probe(targets[id]), deps.unitState(SERVICE_UNITS[id])]);
  return probe.ok && state === 'active';
}));
process.exitCode = results.every(Boolean) ? 0 : 1;
NODE
  then
    daemon_code=200
  fi
  web_code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${web_port}/" 2>/dev/null || echo 000)"
  if [[ "$active_daemon" -eq 1 && "$active_web" -eq 1 && "$active_mcp" -eq 1 && "$daemon_code" = "200" && "$web_code" = "200" ]]; then
    break
  fi
  sleep 1
done

echo "npm-init: spur-daemon active=$active_daemon spur-web active=$active_web spur-mcp active=$active_mcp"
echo "npm-init: verify:"
echo "  curl -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:4310/sessions"
echo "  curl -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${web_port}/"

if [[ "$active_daemon" -ne 1 || "$active_web" -ne 1 || "$active_mcp" -ne 1 || "$daemon_code" != "200" || "$web_code" != "200" ]]; then
  web_active_state="$(systemctl --user show -p ActiveState --value spur-web.service 2>/dev/null || echo unknown)"
  web_last_log="$(journalctl --user -u spur-web -n 5 --no-pager 2>/dev/null | tail -1)"
  die "one or more units failed to start — spur-web ActiveState=$web_active_state, last log: ${web_last_log:-<none>} — check: journalctl --user -u spur-daemon -u spur-web -u spur-mcp -u spur-mcp-tunnel -n 40 --no-pager"
fi
