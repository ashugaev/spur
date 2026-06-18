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

test_concurrency
test_heal
test_loud_failure

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
