#!/usr/bin/env bash
# Execute ON the dedicated itest VM. Reboot is a separate resumable checkpoint.
set -euo pipefail

mode="${1:?usage: mcp-recovery.sh check|dead-health|daemon-restart|mcp-kill|reboot-before|reboot-after|cli-update|deploy-switch|rollback}"
: "${ITEST_MCP_SCOPE:?set user or system}"
: "${ITEST_MCP_PACKAGE_ROOT:?set installed candidate package root}"
: "${ITEST_MCP_BUILD_ID:?set candidate runtime build identity}"
: "${ITEST_MCP_EVIDENCE_DIR:?set private evidence directory}"
: "${ITEST_VM_LOCK_DIR:?claim exclusive persistent-VM lock before recovery}"
[[ -s "$ITEST_VM_LOCK_DIR/owner" ]]
resolved_urls="$(node --input-type=module - "$ITEST_MCP_PACKAGE_ROOT" <<'NODE'
import { pathToFileURL } from 'node:url';
const { loadInstanceConfigReadOnly } = await import(pathToFileURL(`${process.argv[2]}/dist/config.js`).href);
const loaded = loadInstanceConfigReadOnly();
if (loaded.status !== 'ok') throw new Error('installed instance configuration required');
process.stdout.write(`http://127.0.0.1:${loaded.config.mcp.port}/mcp http://127.0.0.1:${loaded.config.server.port}`);
NODE
)"
read -r url daemon_url <<< "$resolved_urls"
[[ -z "${ITEST_MCP_URL:-}" || "$ITEST_MCP_URL" = "$url" ]]
[[ -z "${ITEST_DAEMON_URL:-}" || "$ITEST_DAEMON_URL" = "$daemon_url" ]]
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ITEST_MCP_EVIDENCE_DIR"
chmod 700 "$ITEST_MCP_EVIDENCE_DIR"
case "$ITEST_MCP_SCOPE" in
  user) systemctl_cmd=(systemctl --user) ;;
  system) systemctl_cmd=(sudo systemctl) ;;
  *) echo 'invalid scope' >&2; exit 1 ;;
esac
units=(spur-daemon.service spur-web.service spur-mcp.service)
if [[ "$ITEST_MCP_SCOPE" = user ]]; then
  tunnel_env="$HOME/.spur/mcp-tunnel.env"
else
  tunnel_env=/etc/spur/mcp-tunnel.env
fi
if [[ -f "$tunnel_env" ]]; then units+=(spur-mcp-tunnel.service); fi

snapshot() {
  cat /proc/sys/kernel/random/boot_id
  for unit in "${units[@]}"; do
    printf '%s ' "$unit"
    "${systemctl_cmd[@]}" show "$unit" --property=MainPID --value
  done
}
verify() {
  for unit in "${units[@]}"; do
    "${systemctl_cmd[@]}" is-enabled "$unit" || return 1
  done
  if [[ "$ITEST_MCP_SCOPE" = user ]]; then
    [[ "$(loginctl show-user "$USER" -p Linger --value)" = yes ]] || return 1
  fi
  local retries="${1:-60}"
  for ((attempt = 0; attempt < retries; attempt++)); do
    units_ready=true
    for unit in "${units[@]}"; do
      if ! "${systemctl_cmd[@]}" is-active --quiet "$unit"; then units_ready=false; fi
    done
    if [[ "$units_ready" = true ]] && node "$script_root/mcp-probe.mjs" --package-root "$ITEST_MCP_PACKAGE_ROOT" --url "$url" --expected-build "$ITEST_MCP_BUILD_ID" > "$ITEST_MCP_EVIDENCE_DIR/probe.json" 2> "$ITEST_MCP_EVIDENCE_DIR/probe-error.txt"; then
      if ! node --input-type=module - "$url" <<'NODE'
import { execFileSync } from 'node:child_process';
const port = new URL(process.argv[2]).port;
const listeners = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/)[3]).filter(address => address?.endsWith(`:${port}`));
if (listeners.length !== 1 || listeners[0] !== `127.0.0.1:${port}`) throw new Error('MCP must have one loopback listener');
NODE
      then return 1; fi
      snapshot > "$ITEST_MCP_EVIDENCE_DIR/$mode.after"
      return
    fi
    sleep 2
  done
  echo 'installed MCP never became healthy' >&2
  return 1
}
case "$mode" in
  check) verify ;;
  dead-health)
    verify
    trap '"${systemctl_cmd[@]}" start spur-mcp.service' EXIT
    "${systemctl_cmd[@]}" stop spur-mcp.service
    if node "$script_root/mcp-probe.mjs" --package-root "$ITEST_MCP_PACKAGE_ROOT" --url "$url" --expected-build "$ITEST_MCP_BUILD_ID" > "$ITEST_MCP_EVIDENCE_DIR/dead-health.probe" 2>&1; then
      echo 'SDK probe accepted stopped MCP' >&2; exit 1
    fi
    node --input-type=module - "$ITEST_MCP_PACKAGE_ROOT" "$ITEST_MCP_EVIDENCE_DIR/dead-health.doctor.json" <<'NODE'
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [root, output] = process.argv.slice(2);
let raw;
try { raw = execFileSync(process.execPath, [`${root}/dist/cli.js`, 'doctor', '--json'], { encoding: 'utf8' }); }
catch (error) { raw = error.stdout; }
let result;
try { result = JSON.parse(raw); } catch { throw new Error('doctor did not emit JSON'); }
if (!result.hostChecks?.some(check => check.id === 'spur-mcp' && check.ok === false)) throw new Error('doctor accepted stopped MCP');
writeFileSync(output, JSON.stringify(result), { mode: 0o600 });
NODE
    "${systemctl_cmd[@]}" start spur-mcp.service
    trap - EXIT
    verify
    ;;
  daemon-restart|mcp-kill)
    snapshot > "$ITEST_MCP_EVIDENCE_DIR/$mode.before"
    if [[ "$mode" = daemon-restart ]]; then
      "${systemctl_cmd[@]}" restart spur-daemon.service
    else
      "${systemctl_cmd[@]}" kill --kill-whom=main --signal=SIGKILL spur-mcp.service
    fi
    verify
    target=spur-daemon.service
    [[ "$mode" = mcp-kill ]] && target=spur-mcp.service
    before_pid="$(grep "^$target " "$ITEST_MCP_EVIDENCE_DIR/$mode.before")"
    after_pid="$(grep "^$target " "$ITEST_MCP_EVIDENCE_DIR/$mode.after")"
    [[ "$before_pid" != "$after_pid" ]]
    ;;
  reboot-before)
    verify
    snapshot > "$ITEST_MCP_EVIDENCE_DIR/reboot.before"
    echo 'checkpoint saved; invoke sudo reboot through the SSH orchestrator, reconnect, run reboot-after'
    ;;
  reboot-after)
    [[ -s "$ITEST_MCP_EVIDENCE_DIR/reboot.before" ]]
    verify
    [[ "$(head -n1 "$ITEST_MCP_EVIDENCE_DIR/reboot.before")" != "$(head -n1 "$ITEST_MCP_EVIDENCE_DIR/$mode.after")" ]]
    ;;
  cli-update|deploy-switch)
    [[ "$ITEST_MCP_SCOPE" = user ]]
    : "${ITEST_MCP_TARGET_VERSION:?set selected public candidate version}"
    [[ "$ITEST_MCP_TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    snapshot > "$ITEST_MCP_EVIDENCE_DIR/$mode.before"
    if [[ "$mode" = cli-update ]]; then
      node "$ITEST_MCP_PACKAGE_ROOT/dist/cli.js" update "$ITEST_MCP_TARGET_VERSION" > "$ITEST_MCP_EVIDENCE_DIR/$mode.command" 2>&1
    else
      node --input-type=module - "$ITEST_MCP_TARGET_VERSION" "$daemon_url" > "$ITEST_MCP_EVIDENCE_DIR/$mode.command" <<'NODE'
const [version, base] = process.argv.slice(2);
const url = new URL(base);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('itest loopback daemon required');
const response = await fetch(new URL('/deploy/switch', url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-spur-origin': 'cli' }, body: JSON.stringify({ version }), signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`deploy switch rejected: ${response.status} ${await response.text()}`);
process.stdout.write(await response.text());
NODE
    fi
    ready=false
    for attempt in {1..180}; do
      if node --input-type=module - "$ITEST_MCP_PACKAGE_ROOT" "$ITEST_MCP_TARGET_VERSION" <<'NODE'
import { readFile } from 'node:fs/promises';
const [root, version] = process.argv.slice(2);
try { const meta = JSON.parse(await readFile(`${root}/package.json`, 'utf8')); if (meta.version !== version) process.exit(1); } catch { process.exit(1); }
NODE
      then
        if verify 1; then ready=true; break; fi
      fi
      sleep 2
    done
    [[ "$ready" = true ]]
    [[ "$(grep '^spur-mcp.service ' "$ITEST_MCP_EVIDENCE_DIR/$mode.before")" != "$(grep '^spur-mcp.service ' "$ITEST_MCP_EVIDENCE_DIR/$mode.after")" ]]
    ;;
  rollback)
    [[ "$ITEST_MCP_SCOPE" = user ]]
    : "${ITEST_CANDIDATE_MANIFEST:?set verified candidates.json}"
    : "${ITEST_REGISTRY_FAULT_FILE:?set fixture fault file}"
    : "${ITEST_REGISTRY_FAULT_EVIDENCE:?set fixture fault evidence file}"
    : "${ITEST_REGISTRY_LOG:?set fixture artifact request log}"
    verify
    snapshot > "$ITEST_MCP_EVIDENCE_DIR/rollback.before"
    trap 'rm -f -- "$ITEST_REGISTRY_FAULT_FILE"' EXIT
    # Force actual artifact requests; a cached package cannot activate the fault.
    npm cache clean --force > "$ITEST_MCP_EVIDENCE_DIR/rollback.cache" 2>&1
    node --input-type=module - "$url" "$daemon_url" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
const env = process.env;
const [mcpUrl, base] = process.argv.slice(2);
const endpoint = new URL(base);
if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('itest loopback daemon required');
async function jsonFile(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('invalid rollback evidence JSON'); } }
const manifest = await jsonFile(env.ITEST_CANDIDATE_MANIFEST);
const { version: previousVersion } = await jsonFile(`${env.ITEST_MCP_PACKAGE_ROOT}/package.json`);
const previous = manifest.candidates.find(candidate => candidate.version === previousVersion);
const target = manifest.candidates.find(candidate => candidate.version !== previousVersion);
if (!previous || !target || manifest.runtimeBuildId !== env.ITEST_MCP_BUILD_ID) throw new Error('rollback requires installed verified candidate');
const nonce = randomUUID();
const logBefore = (await readFile(env.ITEST_REGISTRY_LOG, 'utf8')).length;
await writeFile(env.ITEST_REGISTRY_FAULT_FILE, JSON.stringify({ nonce, targetVersion: target.version, previousVersion, mcpPort: Number(new URL(mcpUrl).port) }), { mode: 0o600 });
const response = await fetch(new URL('/deploy/switch', endpoint), { method: 'POST', headers: { 'content-type': 'application/json', 'x-spur-origin': 'cli' }, body: JSON.stringify({ version: target.version }), signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`rollback switch rejected: ${response.status}`);
let state;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await setTimeout(2000);
  try {
    const status = await fetch(new URL('/deploy/switch/status', endpoint), { signal: AbortSignal.timeout(3000) });
    if (!status.ok) continue;
    state = await status.json();
    if (state?.phase === 'failed' && state.version === target.version) break;
  } catch { /* Daemon replacement closes connections during the switch. */ }
}
if (state?.phase !== 'failed' || state.failureKind !== 'rolled_back') throw new Error(`actual rollback not proven: ${JSON.stringify(state)}`);
const installed = await jsonFile(`${env.ITEST_MCP_PACKAGE_ROOT}/package.json`);
if (installed.version !== previousVersion) throw new Error('prior candidate not restored');
const events = await jsonFile(env.ITEST_REGISTRY_FAULT_EVIDENCE);
const ownEvents = events.filter(event => event.nonce === nonce).map(event => event.event);
if (JSON.stringify(ownEvents) !== JSON.stringify(['armed-before-target-artifact', 'rollback-artifact-requested'])) throw new Error(`fault sequence failed: ${JSON.stringify(ownEvents)}`);
const served = (await readFile(env.ITEST_REGISTRY_LOG, 'utf8')).slice(logBefore).trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { throw new Error('invalid registry log'); } });
for (const candidate of [target, previous]) if (!served.some(row => row.status === 200 && row.sha256 === candidate.sha256)) throw new Error('candidate artifact delivery not proven');
await writeFile(`${env.ITEST_MCP_EVIDENCE_DIR}/rollback.state.json`, JSON.stringify({ state, previousVersion, targetVersion: target.version, events: ownEvents, sourceSha: manifest.sourceSha, runtimeBuildId: manifest.runtimeBuildId }), { mode: 0o600 });
NODE
    rm -f -- "$ITEST_REGISTRY_FAULT_FILE"
    trap - EXIT
    verify
    [[ "$(grep '^spur-mcp.service ' "$ITEST_MCP_EVIDENCE_DIR/rollback.before")" != "$(grep '^spur-mcp.service ' "$ITEST_MCP_EVIDENCE_DIR/rollback.after")" ]]
    ;;
  *) echo 'unknown recovery checkpoint' >&2; exit 1 ;;
esac
