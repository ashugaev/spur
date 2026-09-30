---
name: spur-update
description: Roll a Spur host onto a published npm version by hand and verify it, when the automatic path fails. Use when `spur update` rolled back, the UI version switch reports failed, the dashboard shows a stale or 0.0.0 version, or the daemon stays unreachable after a version change. Don't use for cutting a release, for publishing to npm, or for a Spur running from a repo checkout.
---

SPUR UPDATE BY HAND

Recover a host onto a published version when the automatic update fails. Host-generic: any box running the npm-installed Spur.

LAYOUT

  package       @shugaev/spur on npm
  install       <prefix>/lib/node_modules/@shugaev/spur, prefix derived from the running package path
  units         spur-daemon.service, spur-web.service, user scope
  helper        <install>/scripts/install-and-restart.sh <version>, the script the UI version switch spawns
  helper log    ~/.spur/logs/install-and-restart.log, the helper's only output sink
  lock          ~/.spur/install-and-restart.lock, shared with `spur update`, waits 600s
  update state  ~/.spur/rollback-state.json
  switch state  deploy-switch.json in the Spur data dir

RECOVERY PATHS

  1  spur update [version] — installs, monitors, auto-rolls-back. Flags: `spur update --help`.
  2  bash <install>/scripts/install-and-restart.sh <version> — what the UI click runs. Prints nothing to the terminal; read the helper log.
  Verify identity after either path.

DIAGNOSE FIRST

  <prefix>/bin/spur --version
  node -p "require('<install>/package.json').version"
  npm view @shugaev/spur version
  systemctl --user is-active spur-daemon spur-web
  tail -n 40 ~/.spur/logs/install-and-restart.log

Compare live `/info.version` with package.json; CLI version alone proves no restart.

VERIFY AFTER

  systemctl --user is-active spur-daemon spur-web
  systemctl --user show spur-daemon -p MainPID --value
  curl -fsS http://127.0.0.1:4310/info
  curl -fsS -o /dev/null -w 'web %{http_code}\n' http://127.0.0.1:<web-port>/

Pass: both units active, web 200, `/info.version` equals target and installed package, `/info.pid` equals nonzero MainPID. Read web port from `Environment=PORT=` in spur-web.service.

READINESS

  A registry holding many configs and sources leaves the daemon answering 503 for over 20 seconds after systemd reports the unit active. Poll both endpoints before calling a deploy failed.
  reinit rc=1 requires identity checks even with both units active. A detached stale daemon can answer 200 while systemd cannot bind. Verify PID ownership before stopping a conflicting process; re-poll after recovery.

TRAPS

  - `npm install -g` without `--prefix` lands in npm's configured prefix, not the live install. Derive the prefix from the running package path.
  - A locally packed tarball carries the repo placeholder version, and the dashboard then shows 0.0.0. Only a registry version carries a real semver. Never hand-deploy a packed tarball to a host that needs a version number.
  - Rollback matches the previous version against semver. From a placeholder install no rollback runs and the host stays on the new version.
  - A stale `running` phase in the switch state 409s each later UI switch.
  - `spur update` refuses on a live update monitor and on a failing preflight, `--force` overrides both. A daemon answering 503 fails preflight. An `inProgress` record whose monitor is dead blocks nothing.
  - `spur update` refuses a source checkout.
  - A non-default SYSTEMCTL restarts the units directly and skips the unit refresh. Unit contracts change across versions.
  - No published version carries the fix: the release pipeline is the defect. Repair it; hand-rolling reaches published versions only.
