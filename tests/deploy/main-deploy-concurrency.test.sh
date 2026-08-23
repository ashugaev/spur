#!/usr/bin/env bash
# Hermetic tests for scripts/main-deploy.sh deploy hardening:
#   - flock serialization across overlapping runs
#   - verify_and_heal self-heal of an inactive spur-web
#   - loud non-zero failure when spur-web cannot be brought up
#
# No real systemd / network / pnpm. systemctl/ss/curl are replaced by stubs
# (tests/deploy/stubs) that read/write a shared $SPUR_DEPLOY_STATE log. The
# script is driven down its fast path (deployed sha == remote head, services
# active, service files changed -> restart) so it never runs a build.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stub_dir="$repo_root/tests/deploy/stubs"
script="$repo_root/scripts/main-deploy.sh"

pass=0
fail=0
ok() {
  printf 'ok - %s\n' "$1"
  pass=$((pass + 1))
}
bad() {
  printf 'NOT OK - %s\n' "$1"
  fail=$((fail + 1))
}

# Build a self-contained git deploy clone with origin pointing at itself, the
# deploy/ unit templates, and a stamp matching HEAD so the fast path triggers.
make_deploy_root() {
  local root="$1"
  git init -q "$root"
  git -C "$root" config user.email t@t && git -C "$root" config user.name t
  mkdir -p "$root/deploy" "$root/scripts"
  cp "$repo_root/deploy/spur-daemon.service" "$root/deploy/"
  cp "$repo_root/deploy/spur-web.service" "$root/deploy/"
  cp "$script" "$root/scripts/main-deploy.sh"
  git -C "$root" add -A
  git -C "$root" commit -qm init
  git -C "$root" branch -M main
  git -C "$root" remote add origin "$root"
  git -C "$root" config receive.denyCurrentBranch ignore
  git -C "$root" rev-parse HEAD
}

# Shared env for a hermetic run. $1 = workdir.
setup_env() {
  local work="$1"
  local sudo_dir="$work/sudobin"
  mkdir -p "$sudo_dir"
  # `sudo` passthrough so the script's literal `sudo ss` (rogue-port check)
  # never escalates; it execs the remaining args directly.
  cat >"$sudo_dir/sudo" <<EOF
#!/usr/bin/env bash
exec "\$@"
EOF
  chmod +x "$sudo_dir/sudo"

  export PATH="$sudo_dir:$stub_dir:$PATH"
  export HOME="$work/home"
  mkdir -p "$HOME"
  # Do NOT preset MAIN_DEPLOY_REEXECED: let the script acquire the deploy lock
  # and re-exec from $deploy_root exactly as in prod, so the test exercises the
  # real lock placement + FD-9 inheritance across exec.
  export MAIN_DEPLOY_ROOT="$work/repo"
  export MAIN_DEPLOY_SYSTEMD_DIR="$work/units"
  export MAIN_DEPLOY_DAEMON_ENV_FILE="$work/daemon.env"
  export SYSTEMCTL="$stub_dir/systemctl"
  export SPUR_DEPLOY_SS="$stub_dir/ss"
  export SPUR_DEPLOY_CURL="$stub_dir/curl"
  export SPUR_DEPLOY_LOCKFILE="$work/main-deploy.lock"
  export SPUR_DEPLOY_STATE="$work/state.log"
  # Temp stand-in for packages/web/.next. web_chunks_consistent resolves served
  # /_next/static refs against this dir. Tests seed/remove files to drive the
  # consistent / stale paths.
  export SPUR_DEPLOY_WEB_NEXT_DIR="$work/next"
  unset SPUR_DEPLOY_DAEMON_PORT_PID
  unset SPUR_DEPLOY_DAEMON_MAIN_PID
  unset SPUR_DEPLOY_DAEMON_REBIND_PID
  unset SPUR_DEPLOY_HTML_CHUNKS
  unset SPUR_DEPLOY_HTML_BUILD_ID
  mkdir -p "$SPUR_DEPLOY_WEB_NEXT_DIR/static"
  printf 'test\n' >"$SPUR_DEPLOY_WEB_NEXT_DIR/BUILD_ID"
  : >"$MAIN_DEPLOY_DAEMON_ENV_FILE"
  mkdir -p "$MAIN_DEPLOY_SYSTEMD_DIR"
}

# --- Case (a): concurrency ------------------------------------------------
test_concurrency() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  # Stamp == head and both services start active -> fast path with restart.
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  # Two overlapping runs sharing the lockfile + state log.
  bash "$script" >"$work/a.out" 2>&1 &
  local p1=$!
  bash "$script" >"$work/b.out" 2>&1 &
  local p2=$!
  local r1=0 r2=0
  wait "$p1" || r1=$?
  wait "$p2" || r2=$?

  if [[ "$r1" == 0 && "$r2" == 0 ]]; then
    ok "concurrency: both runs exit 0"
  else
    bad "concurrency: runs exited r1=$r1 r2=$r2"
    cat "$work/a.out" "$work/b.out"
  fi

  # No stop must ever land between another run's start and its verify. With the
  # lock the only verbs are restart/start/is-active; assert no `stop` verb and
  # that the last spur-web verb is start/restart (active).
  if grep -qE '^stop ' "$SPUR_DEPLOY_STATE"; then
    bad "concurrency: unexpected stop interleave"
    cat "$SPUR_DEPLOY_STATE"
  else
    ok "concurrency: no stop-after-start interleave"
  fi
  local last_web
  last_web=$(grep -E ' spur-web\.service$' "$SPUR_DEPLOY_STATE" | tail -n1 | cut -d' ' -f1)
  if [[ "$last_web" == "start" || "$last_web" == "restart" ]]; then
    ok "concurrency: final spur-web state active ($last_web)"
  else
    bad "concurrency: final spur-web state not active ($last_web)"
  fi

  # Serialization proof. The deploy lock spans git + install_service_files +
  # restart. Whichever run acquires it first writes the unit files (empty units
  # dir -> SERVICES_CHANGED -> exactly one restart) and stamps them; the run that
  # waits for the lock then sees the files unchanged and takes the "Already
  # deployed" fast exit with NO restart. So a held lock yields exactly ONE
  # `restart spur-daemon.service`. If the lock were dropped (e.g. the re-execed
  # child reopened FD 9), both runs would restart -> 2 restarts and this fails.
  local daemon_restarts
  daemon_restarts=$(grep -cxE 'restart spur-daemon\.service' "$SPUR_DEPLOY_STATE") || true
  if [[ "$daemon_restarts" == 1 ]]; then
    ok "concurrency: lock serialized restart (exactly 1 daemon restart)"
  else
    bad "concurrency: expected 1 serialized daemon restart, got $daemon_restarts"
    cat "$SPUR_DEPLOY_STATE"
  fi
}

# --- Case (b): heal an inactive spur-web ----------------------------------
test_heal() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  # A wrapper systemctl that simulates a restart leaving spur-web inactive:
  # it records `restart spur-daemon` and `stop spur-web` instead of restarting
  # web. verify_and_heal must then `start spur-web.service` and recover.
  local heal_sc="$work/systemctl-heal"
  cat >"$heal_sc" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$1" == restart ]]; then
  shift
  for u in "\$@"; do
    if [[ "\$u" == spur-web.service ]]; then
      printf 'stop %s\n' "\$u" >>"\$SPUR_DEPLOY_STATE"
    else
      printf 'restart %s\n' "\$u" >>"\$SPUR_DEPLOY_STATE"
    fi
  done
  exit 0
fi
exec "$stub_dir/systemctl" "\$@"
EOF
  chmod +x "$heal_sc"
  export SYSTEMCTL="$heal_sc"

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "heal: exits 0 after healing"
  else
    bad "heal: exited $rc"
    cat "$work/out"
  fi
  if grep -qx 'start spur-web.service' "$SPUR_DEPLOY_STATE"; then
    ok "heal: issued start spur-web.service"
  else
    bad "heal: no start spur-web.service"
    cat "$SPUR_DEPLOY_STATE"
  fi
  local last_web
  last_web=$(grep -E ' spur-web\.service$' "$SPUR_DEPLOY_STATE" | tail -n1 | cut -d' ' -f1)
  if [[ "$last_web" == "start" ]]; then
    ok "heal: final spur-web active via start"
  else
    bad "heal: final spur-web verb $last_web"
  fi
}

# --- Case (c): loud failure when web never comes up -----------------------
test_loud_failure() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  # systemctl that records spur-web restart/start as a `stop` (web never comes
  # up) but behaves normally for the daemon. verify_and_heal's start of web is
  # also recorded as stop, so web stays inactive and the script must hard-fail.
  local dead_sc="$work/systemctl-dead"
  cat >"$dead_sc" <<EOF
#!/usr/bin/env bash
set -euo pipefail
verb="\$1"; shift || true
if [[ "\$verb" == restart || "\$verb" == start ]]; then
  for u in "\$@"; do
    if [[ "\$u" == spur-web.service ]]; then
      printf 'stop %s\n' "\$u" >>"\$SPUR_DEPLOY_STATE"
    else
      printf '%s %s\n' "\$verb" "\$u" >>"\$SPUR_DEPLOY_STATE"
    fi
  done
  exit 0
fi
exec "$stub_dir/systemctl" "\$verb" "\$@"
EOF
  chmod +x "$dead_sc"
  export SYSTEMCTL="$dead_sc"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  if [[ "$rc" != 0 ]]; then
    ok "loud-failure: non-zero exit ($rc)"
  else
    bad "loud-failure: exited 0"
  fi
  if grep -q 'FATAL: spur-web not serving' <<<"$out"; then
    ok "loud-failure: FATAL message printed"
  else
    bad "loud-failure: missing FATAL message"
    printf '%s\n' "$out"
  fi
}

# --- Case (d): full build path, build hook does not abort the deploy --------
# Drives the deploy's build branch (no stamp -> deployed != remote). A pnpm stub
# stands in for install/build. The build runs the REAL bin mjs under
# SPUR_DISABLE_AUTOSTART=1 (which, post-fix, exits 0 instead of aborting the
# deploy) and seeds the temp .next + served chunks consistently. Asserts the
# deploy reaches restart_and_verify and spur-web ends active & consistent.
test_build_hook_no_abort() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  # No stamp file -> deployed_head != remote_head -> build path.
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  local ref="/_next/static/chunks/main-abc123.js"
  # pnpm stub: install is a no-op; build runs the real mjs under the deploy's
  # SPUR_DISABLE_AUTOSTART=1 export, then seeds the fresh .next + served HTML.
  local pnpm_stub="$work/sudobin/pnpm"
  cat >"$pnpm_stub" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Args look like: -C <root> install --frozen-lockfile   OR   -C <root> build
verb=""
for a in "\$@"; do
  case "\$a" in install|build) verb="\$a";; esac
done
if [[ "\$verb" == build ]]; then
  node "$MAIN_DEPLOY_ROOT/v2/bin/restart-daemon-if-running.mjs"
  mkdir -p "\$SPUR_DEPLOY_WEB_NEXT_DIR/static/chunks"
  : >"\$SPUR_DEPLOY_WEB_NEXT_DIR/${ref#/_next/}"
fi
exit 0
EOF
  chmod +x "$pnpm_stub"
  # The build runs the REAL bin mjs from the deploy root. The deploy does
  # `reset --hard origin/main` + `clean -fd` first, wiping untracked files, so
  # the mjs (and a minimal ../dist/config.js it imports) must be COMMITTED.
  # config.js is never reached when SPUR_DISABLE_AUTOSTART=1 (skip is first).
  mkdir -p "$MAIN_DEPLOY_ROOT/v2/bin" "$MAIN_DEPLOY_ROOT/v2/dist"
  cp "$repo_root/v2/bin/restart-daemon-if-running.mjs" "$MAIN_DEPLOY_ROOT/v2/bin/"
  printf 'export function instanceConfigExists(){return false}\nexport function resolveInstanceConfigPath(){return ""}\n' \
    >"$MAIN_DEPLOY_ROOT/v2/dist/config.js"
  git -C "$MAIN_DEPLOY_ROOT" add -A
  git -C "$MAIN_DEPLOY_ROOT" commit -qm "v2 bin"
  export SPUR_DEPLOY_HTML_CHUNKS="$ref"

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "build-hook: deploy exits 0 (build hook did not abort)"
  else
    bad "build-hook: deploy exited $rc"
    cat "$work/out"
  fi
  if grep -qxE 'restart spur-daemon\.service' "$SPUR_DEPLOY_STATE"; then
    ok "build-hook: reached restart_and_verify"
  else
    bad "build-hook: never restarted (build aborted before restart)"
    cat "$SPUR_DEPLOY_STATE"
  fi
  local last_web
  last_web=$(grep -E ' spur-web\.service$' "$SPUR_DEPLOY_STATE" | tail -n1 | cut -d' ' -f1)
  if [[ "$last_web" == "start" || "$last_web" == "restart" ]]; then
    ok "build-hook: final spur-web active ($last_web)"
  else
    bad "build-hook: final spur-web verb $last_web"
  fi
}

# --- Case (e): stale chunks healed by a restart ---------------------------
# spur-web serves HTML referencing a chunk missing from the temp .next. The
# systemctl stub, on `restart spur-web`, writes the missing chunk (simulating a
# reload onto the fresh build). verify must detect the mismatch, issue a heal
# restart, re-verify consistent, and exit 0.
test_stale_chunks_heal() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  local ref="/_next/static/chunks/main-stale.js"
  # Served HTML references the chunk, but it is NOT on disk yet -> stale.
  export SPUR_DEPLOY_HTML_CHUNKS="$ref"

  # systemctl wrapper: leave the chunk missing through the INITIAL restart (in
  # restart_and_verify) so verify sees the stale state; only the stop/start
  # heal — the first start after stop — writes the chunk (fresh build now
  # served). A counter file distinguishes the two starts.
  local heal_sc="$work/systemctl-chunkheal"
  local web_starts="$work/web-start-count"
  : >"$web_starts"
  cat >"$heal_sc" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$1" == start ]]; then
  for u in "\$@"; do
    [[ "\$u" == spur-web.service ]] || continue
    printf 'x' >>"$web_starts"
    if [[ "\$(wc -c <"$web_starts")" -ge 1 ]]; then
      mkdir -p "\$SPUR_DEPLOY_WEB_NEXT_DIR/static/chunks"
      : >"\$SPUR_DEPLOY_WEB_NEXT_DIR/${ref#/_next/}"
    fi
  done
fi
exec "$stub_dir/systemctl" "\$@"
EOF
  chmod +x "$heal_sc"
  export SYSTEMCTL="$heal_sc"

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "stale-heal: exits 0 after heal restart"
  else
    bad "stale-heal: exited $rc"
    cat "$work/out"
  fi
  if grep -q 'serving stale chunks — restarting' "$work/out"; then
    ok "stale-heal: detected stale chunks and restarted"
  else
    bad "stale-heal: no stale-chunk heal log"
    cat "$work/out"
  fi
}

# --- Case (f): stale chunks that the heal restart cannot fix -> loud fail ---
test_stale_chunks_loud_fail() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  # Served HTML references a chunk that never lands on disk. The default
  # systemctl stub restarts (web stays "serving") but never writes the chunk,
  # so verify stays inconsistent after the single heal -> FATAL.
  export SPUR_DEPLOY_HTML_CHUNKS="/_next/static/chunks/main-missing.js"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  if [[ "$rc" != 0 ]]; then
    ok "stale-fail: non-zero exit ($rc)"
  else
    bad "stale-fail: exited 0"
  fi
  if grep -q 'FATAL: spur-web serving stale chunks' <<<"$out"; then
    ok "stale-fail: FATAL chunk message printed"
  else
    bad "stale-fail: missing FATAL chunk message"
    printf '%s\n' "$out"
  fi
  if grep -q 're-run main:deploy to retry the same commit' <<<"$out"; then
    ok "stale-fail: retry-path line printed"
  else
    bad "stale-fail: missing retry-path line"
    printf '%s\n' "$out"
  fi
}

# --- Case (o): stale-chunk FATAL names a build-id mismatch -----------------
# Served HTML carries a build id that differs from $web_next_dir/BUILD_ID on
# disk (host serving out of a different .next entirely). The FATAL path must
# name the mismatch as a serving-directory issue, not just "stale chunks".
test_stale_chunks_fatal_names_build_id_mismatch() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  # Served HTML references a chunk that never lands on disk (same as the loud
  # -fail case), plus a build id that differs from the on-disk BUILD_ID.
  export SPUR_DEPLOY_HTML_CHUNKS="/_next/static/chunks/main-missing.js"
  export SPUR_DEPLOY_HTML_BUILD_ID="served-build-id"
  printf 'disk-build-id\n' >"$SPUR_DEPLOY_WEB_NEXT_DIR/BUILD_ID"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  if [[ "$rc" != 0 ]]; then
    ok "build-id-mismatch: non-zero exit ($rc)"
  else
    bad "build-id-mismatch: exited 0"
  fi
  if grep -q 'FATAL: spur-web serving stale chunks' <<<"$out"; then
    ok "build-id-mismatch: FATAL chunk message still printed"
  else
    bad "build-id-mismatch: missing FATAL chunk message"
    printf '%s\n' "$out"
  fi
  if grep -q 'serving build served-build-id, but .*BUILD_ID is disk-build-id — the missing refs are a serving-directory mismatch' <<<"$out"; then
    ok "build-id-mismatch: mismatch diagnostic printed"
  else
    bad "build-id-mismatch: missing mismatch diagnostic"
    printf '%s\n' "$out"
  fi
}

# --- Case (p): matching build id prints no mismatch diagnostic -------------
# Confirms the existing loud-fail case, which emits no served build id at
# all, stays silent on the diagnostic — never fabricate a mismatch from a
# partial read.
test_stale_chunks_no_diagnostic_without_build_id() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  export SPUR_DEPLOY_HTML_CHUNKS="/_next/static/chunks/main-missing.js"

  local out
  out="$(bash "$script" 2>&1)" || true
  if grep -q 'serving-directory mismatch' <<<"$out"; then
    bad "no-build-id: unexpected mismatch diagnostic"
    printf '%s\n' "$out"
  else
    ok "no-build-id: no mismatch diagnostic printed"
  fi
}

# --- Case (l): RSC-escaped chunk refs are not reported missing -------------
# Prod's Next 15 flight payload double-escapes quotes, so an escaped ref emits
# a `\`-suffixed twin alongside (or instead of) the clean one. The extractor
# must exclude a trailing backslash so the escaped ref resolves to the same
# on-disk file as the clean one.
test_escaped_chunk_refs_not_reported_missing() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  local ref="/_next/static/css/esc-test.css"
  mkdir -p "$SPUR_DEPLOY_WEB_NEXT_DIR/static/css"
  : >"$SPUR_DEPLOY_WEB_NEXT_DIR/${ref#/_next/}"
  export SPUR_DEPLOY_HTML_ESCAPED_CHUNKS="$ref"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "escaped-refs: deploy exits 0"
  else
    bad "escaped-refs: deploy exited $rc"
    printf '%s\n' "$out"
  fi
  if grep -q 'references missing chunk' <<<"$out"; then
    bad "escaped-refs: reported missing chunk"
    printf '%s\n' "$out"
  else
    ok "escaped-refs: no missing-chunk report"
  fi
  if grep -q 'FATAL: spur-web serving stale chunks' <<<"$out"; then
    bad "escaped-refs: unexpected stale-chunk FATAL"
    printf '%s\n' "$out"
  else
    ok "escaped-refs: no stale-chunk FATAL"
  fi
}

# --- Case (m): a mid-deploy build abort leaves spur-web active -------------
# The pre-build stop must be undone by the EXIT trap when the build itself
# aborts (pnpm build exits non-zero) before install_service_files/restart ever
# runs.
test_build_abort_leaves_web_active() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  # No stamp file -> deployed_head != remote_head -> build path.
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  local pnpm_stub="$work/sudobin/pnpm"
  cat >"$pnpm_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
verb=""
for a in "$@"; do
  case "$a" in install|build) verb="$a";; esac
done
if [[ "$verb" == build ]]; then
  exit 1
fi
exit 0
EOF
  chmod +x "$pnpm_stub"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  if [[ "$rc" != 0 ]]; then
    ok "build-abort: non-zero exit ($rc)"
  else
    bad "build-abort: exited 0"
  fi
  if grep -qx 'stop spur-web.service' "$SPUR_DEPLOY_STATE"; then
    ok "build-abort: pre-build stop recorded"
  else
    bad "build-abort: no pre-build stop recorded"
    cat "$SPUR_DEPLOY_STATE"
  fi
  local last_web
  last_web=$(grep -E ' spur-web\.service$' "$SPUR_DEPLOY_STATE" | tail -n1 | cut -d' ' -f1)
  if [[ "$last_web" == "start" ]]; then
    ok "build-abort: final spur-web active via start"
  else
    bad "build-abort: final spur-web verb $last_web"
    cat "$SPUR_DEPLOY_STATE"
  fi
  if grep -q 'with spur-web inactive — starting' <<<"$out"; then
    ok "build-abort: exit trap logged restore"
  else
    bad "build-abort: exit trap did not log restore"
    printf '%s\n' "$out"
  fi
}

# --- Case (n): a failed heal start leaves spur-web active, deploy fails loud -
# The heal loop's stop/start never brings spur-web back up (systemctl wrapper
# swallows the first post-heal start). The body fetch then fails every attempt
# (curl exit 7), so consistency is never verified; the deploy must fail loudly
# with a distinct message (not the stale-chunk FATAL, since that path is never
# reached) and the EXIT trap must still restore spur-web.
test_failed_heal_start_leaves_web_active() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  # Served HTML references a chunk that never lands on disk, so the initial
  # chunk check (while still serving from the restart) is inconsistent and the
  # heal fires. A counter file makes only the FIRST post-heal
  # `start spur-web.service` a no-op recorded as `stop` — web never comes back
  # up, so every later body fetch fails (curl sees "not serving" -> exit 7).
  export SPUR_DEPLOY_HTML_CHUNKS="/_next/static/chunks/main-missing.js"
  local dead_start_sc="$work/systemctl-deadstart"
  local start_count="$work/web-start-count-n"
  : >"$start_count"
  cat >"$dead_start_sc" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$1" == start && "\$2" == spur-web.service && ! -s "$start_count" ]]; then
  printf 'x' >>"$start_count"
  printf 'stop spur-web.service\n' >>"\$SPUR_DEPLOY_STATE"
  exit 0
fi
exec "$stub_dir/systemctl" "\$@"
EOF
  chmod +x "$dead_start_sc"
  export SYSTEMCTL="$dead_start_sc"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  if grep -q 'with spur-web inactive — starting' <<<"$out"; then
    ok "failed-heal: exit trap logged restore"
  else
    bad "failed-heal: exit trap did not log restore"
    printf '%s\n' "$out"
  fi
  local last_web
  last_web=$(grep -E ' spur-web\.service$' "$SPUR_DEPLOY_STATE" | tail -n1 | cut -d' ' -f1)
  if [[ "$last_web" == "start" ]]; then
    ok "failed-heal: final spur-web active via start"
  else
    bad "failed-heal: final spur-web verb $last_web"
    cat "$SPUR_DEPLOY_STATE"
  fi
  if grep -q 'FATAL: spur-web not serving after chunk heal — consistency unverified' <<<"$out"; then
    ok "failed-heal: unverified FATAL printed"
  else
    bad "failed-heal: missing unverified FATAL"
    printf '%s\n' "$out"
  fi
  if grep -q 'FATAL: spur-web serving stale chunks' <<<"$out"; then
    bad "failed-heal: unexpected stale-chunk FATAL (that path was not reached)"
    printf '%s\n' "$out"
  else
    ok "failed-heal: stale-chunk FATAL not printed"
  fi
  if [[ "$rc" != 0 ]]; then
    ok "failed-heal: non-zero exit ($rc)"
  else
    bad "failed-heal: exited 0"
  fi
}

# --- Case (g): missing .next at matching sha -> rebuild, not "Already deployed" -
test_missing_next_rebuild() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  make_deploy_root "$MAIN_DEPLOY_ROOT" >/dev/null
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"
  rm -f "$SPUR_DEPLOY_WEB_NEXT_DIR/BUILD_ID"

  local root="$MAIN_DEPLOY_ROOT"
  for template in "$repo_root/deploy/"*.service; do
    local name content
    name=$(basename "$template")
    content=$(<"$template")
    content="${content//\{\{SPUR_ROOT\}\}/$root}"
    content="${content//\{\{SPUR_SERVICE_USER\}\}/$(id -un)}"
    content="${content//\{\{SPUR_SERVICE_HOME\}\}/$HOME}"
    printf '%s\n' "$content" >"$MAIN_DEPLOY_SYSTEMD_DIR/$name"
  done

  local ref="/_next/static/chunks/main-rebuilt.js"
  local pnpm_stub="$work/sudobin/pnpm"
  cat >"$pnpm_stub" <<EOF
#!/usr/bin/env bash
set -euo pipefail
verb=""
for a in "\$@"; do
  case "\$a" in install|build) verb="\$a";; esac
done
if [[ "\$verb" == build ]]; then
  node "$MAIN_DEPLOY_ROOT/v2/bin/restart-daemon-if-running.mjs"
  mkdir -p "\$SPUR_DEPLOY_WEB_NEXT_DIR/static/chunks"
  printf 'fresh\n' >"\$SPUR_DEPLOY_WEB_NEXT_DIR/BUILD_ID"
  : >"\$SPUR_DEPLOY_WEB_NEXT_DIR/${ref#/_next/}"
fi
exit 0
EOF
  chmod +x "$pnpm_stub"
  mkdir -p "$MAIN_DEPLOY_ROOT/v2/bin" "$MAIN_DEPLOY_ROOT/v2/dist"
  cp "$repo_root/v2/bin/restart-daemon-if-running.mjs" "$MAIN_DEPLOY_ROOT/v2/bin/"
  printf 'export function instanceConfigExists(){return false}\nexport function resolveInstanceConfigPath(){return ""}\n' \
    >"$MAIN_DEPLOY_ROOT/v2/dist/config.js"
  git -C "$MAIN_DEPLOY_ROOT" add -A
  git -C "$MAIN_DEPLOY_ROOT" commit -qm "v2 bin"
  local head
  head="$(git -C "$MAIN_DEPLOY_ROOT" rev-parse HEAD)"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  export SPUR_DEPLOY_HTML_CHUNKS="$ref"

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "missing-next: exits 0 after rebuild"
  else
    bad "missing-next: exited $rc"
    cat "$work/out"
  fi
  if grep -q 'build missing' "$work/out"; then
    ok "missing-next: logged rebuild reason"
  else
    bad "missing-next: no rebuild log"
    cat "$work/out"
  fi
  if [[ -f "$SPUR_DEPLOY_WEB_NEXT_DIR/BUILD_ID" ]]; then
    ok "missing-next: BUILD_ID written by build"
  else
    bad "missing-next: BUILD_ID still missing"
  fi
}

# --- Case (h): active unit with stale non-MainPID listener -----------------
# Regression for prod crash-loop root cause: a stale listener can still hold
# :4310 while it is not systemd's active MainPID. Cleanup must kill by MainPID
# comparison, not cgroup membership.
test_stale_daemon_listener_killed_when_not_main_pid() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  sleep 1000 &
  local stale_pid=$!
  export SPUR_DEPLOY_DAEMON_PORT_PID="$stale_pid"
  export SPUR_DEPLOY_DAEMON_MAIN_PID=424242

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "daemon-listener: deploy exits 0 after stale listener cleanup"
  else
    bad "daemon-listener: deploy exited $rc"
    cat "$work/out"
  fi
  if kill -0 "$stale_pid" 2>/dev/null; then
    bad "daemon-listener: stale listener still alive"
    kill "$stale_pid" 2>/dev/null || true
  else
    ok "daemon-listener: stale listener killed"
  fi
  if grep -q "killing stale daemon listener pid=$stale_pid main_pid=424242" "$work/out"; then
    ok "daemon-listener: cleanup logged MainPID mismatch"
  else
    bad "daemon-listener: missing cleanup log"
    cat "$work/out"
  fi
}

# --- Case (i): listener that is active systemd MainPID is preserved --------
test_active_daemon_main_pid_preserved() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  sleep 1000 &
  local main_pid=$!
  export SPUR_DEPLOY_DAEMON_PORT_PID="$main_pid"
  export SPUR_DEPLOY_DAEMON_MAIN_PID="$main_pid"

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "daemon-listener: active MainPID deploy exits 0"
  else
    bad "daemon-listener: active MainPID deploy exited $rc"
    cat "$work/out"
  fi
  if kill -0 "$main_pid" 2>/dev/null; then
    ok "daemon-listener: active MainPID preserved"
    kill "$main_pid" 2>/dev/null || true
  else
    bad "daemon-listener: active MainPID was killed"
  fi
  if grep -q "killing stale daemon listener pid=$main_pid" "$work/out"; then
    bad "daemon-listener: active MainPID logged stale cleanup"
    cat "$work/out"
  else
    ok "daemon-listener: no stale cleanup for active MainPID"
  fi
}

# --- Case (j): systemd rebinds the port after the orphan dies -> success ----
# This is the exact regression the incident had: the wait loop must key off
# "the pid we killed is gone", not "the port is empty" — a healthy daemon
# rebind during the wait window must not be treated as failure.
test_healthy_rebind_after_kill_is_success() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  sleep 1000 &
  local orphan_pid=$!
  sleep 1000 &
  local rebind_pid=$!
  export SPUR_DEPLOY_DAEMON_PORT_PID="$orphan_pid"
  export SPUR_DEPLOY_DAEMON_MAIN_PID="$rebind_pid"
  export SPUR_DEPLOY_DAEMON_REBIND_PID="$rebind_pid"

  local rc=0
  bash "$script" >"$work/out" 2>&1 || rc=$?
  kill "$orphan_pid" "$rebind_pid" 2>/dev/null || true
  if [[ "$rc" == 0 ]]; then
    ok "healthy-rebind: deploy exits 0 after systemd rebinds the port"
  else
    bad "healthy-rebind: deploy exited $rc"
    cat "$work/out"
  fi
}

# --- Case (k): a foreign new listener after kill is still fatal ------------
test_foreign_new_listener_is_fatal() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  setup_env "$work"
  local head
  head="$(make_deploy_root "$MAIN_DEPLOY_ROOT")"
  printf '%s\n' "$head" >"$MAIN_DEPLOY_ROOT/.git/main-deploy-last-successful"
  printf 'start spur-daemon.service\nstart spur-web.service\n' >"$SPUR_DEPLOY_STATE"

  sleep 1000 &
  local orphan_pid=$!
  sleep 1000 &
  local foreign_pid=$!
  export SPUR_DEPLOY_DAEMON_PORT_PID="$orphan_pid"
  export SPUR_DEPLOY_DAEMON_MAIN_PID=424242
  export SPUR_DEPLOY_DAEMON_REBIND_PID="$foreign_pid"

  local rc=0 out
  out="$(bash "$script" 2>&1)" || rc=$?
  kill "$orphan_pid" "$foreign_pid" 2>/dev/null || true
  if [[ "$rc" != 0 ]]; then
    ok "foreign-listener: non-zero exit ($rc)"
  else
    bad "foreign-listener: exited 0"
  fi
  if grep -q 'non-MainPID listener' <<<"$out"; then
    ok "foreign-listener: FATAL message mentions non-MainPID listener"
  else
    bad "foreign-listener: missing non-MainPID FATAL message"
    printf '%s\n' "$out"
  fi
}

test_concurrency
test_heal
test_loud_failure
test_build_hook_no_abort
test_stale_chunks_heal
test_stale_chunks_loud_fail
test_stale_chunks_fatal_names_build_id_mismatch
test_stale_chunks_no_diagnostic_without_build_id
test_missing_next_rebuild
test_stale_daemon_listener_killed_when_not_main_pid
test_active_daemon_main_pid_preserved
test_healthy_rebind_after_kill_is_success
test_foreign_new_listener_is_fatal
test_escaped_chunk_refs_not_reported_missing
test_build_abort_leaves_web_active
test_failed_heal_start_leaves_web_active

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
