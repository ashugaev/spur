#!/usr/bin/env bash
set -euo pipefail

# Prefixed so sourcing this file never clobbers a caller's own SCRIPT_DIR or
# REPO_ROOT (spur-isolated-daemon.sh already defines REPO_ROOT). Derived from
# this file's own BASH_SOURCE, not the caller's, so it is correct regardless
# of which sidecar sources it or what cwd it runs from. Same `realpath`
# derivation spur-isolated-daemon.sh:4-6 uses for its own REPO_ROOT, so a
# symlinked scripts/ resolves to the identical tree for both sidecars.
SIDECAR_REPO_ROOT="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.."
SIDECAR_REPO_ROOT="$(realpath "$SIDECAR_REPO_ROOT")"

NVMRC_FILE="$SIDECAR_REPO_ROOT/.nvmrc"
ROOT_PACKAGE_JSON="$SIDECAR_REPO_ROOT/package.json"
NODE_ENGINES_RANGE=""
NODE_CHECK_ERROR=""

# True when the `node` on PATH right now satisfies the root package.json's
# engines.node range. Mirrors satisfiesClause in v2/src/host-install.ts:460-483
# — same two clause forms (`^X.Y.Z` and `>=X[.Y[.Z]]`), anything else is
# false — so minor/patch precision is real; bash arithmetic can't tell
# 22.13.0 from 22.5.0. The fast test pins this check's verdicts against the
# exported satisfiesNodeEngineRange so the two implementations cannot drift
# apart.
# The version compared is `node -v`'s own output, passed as an argv string,
# rather than that same process's `process.versions.node` — the two are
# always identical for a real node binary, and going through argv is what
# lets the fast test swap in a fake `node -v` without needing a real install
# of every version under test.
#
# Sets two globals as a side effect, read only by ensure_node_ready's failure
# message, never printed here:
#   NODE_ENGINES_RANGE — the literal engines.node string. Only ever assigned
#     that string, refreshed each time the check below actually runs to
#     completion; never prose, never a placeholder.
#   NODE_CHECK_ERROR — empty on a clean verdict (satisfied, or a genuine
#     engines mismatch the check evaluated and rejected); a short reason
#     when the check could not be run at all (node missing, `node -v`
#     failing or unparseable, or `node -e` produced no output regardless of
#     its exit status) so the caller can withhold the "nvm install <pin>" remedy —
#     picking a different node version does not fix a node install that
#     cannot execute the check in the first place.
node_satisfies_engines() {
  NODE_CHECK_ERROR=""

  if ! command -v node >/dev/null 2>&1; then
    NODE_CHECK_ERROR="node not found on PATH"
    return 1
  fi

  local current_version
  local version_status=0
  current_version="$(node -v 2>/dev/null)" || version_status=$?
  if (( version_status != 0 )); then
    NODE_CHECK_ERROR="node -v exited $version_status instead of reporting a version"
    return 1
  fi
  if [[ ! "$current_version" =~ ^v[0-9]+(\.[0-9]+){0,2}$ ]]; then
    NODE_CHECK_ERROR="node -v produced unparseable output: '$current_version'"
    return 1
  fi

  local status=0
  local output
  output="$(node -e '
    const fs = require("fs");
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (error) {
      console.error("spur-sidecar: cannot read " + process.argv[1] + ": " + error.message);
      process.exit(2);
    }
    const range = pkg.engines && pkg.engines.node;
    if (typeof range !== "string") {
      console.error("spur-sidecar: " + process.argv[1] + " is missing engines.node");
      process.exit(2);
    }

    function parseVersionTuple(value) {
      const parts = String(value).replace(/^v/, "").split(".");
      const major = Number.parseInt(parts[0] || "0", 10);
      const minor = Number.parseInt(parts[1] || "0", 10);
      const patch = Number.parseInt(parts[2] || "0", 10);
      return [
        Number.isNaN(major) ? 0 : major,
        Number.isNaN(minor) ? 0 : minor,
        Number.isNaN(patch) ? 0 : patch,
      ];
    }

    function compareTuples(a, b) {
      for (let index = 0; index < 3; index += 1) {
        const diff = a[index] - b[index];
        if (diff !== 0) return diff;
      }
      return 0;
    }

    function satisfiesClause(clause, current) {
      const trimmed = clause.trim();
      const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
      if (caret) {
        const major = Number.parseInt(caret[1], 10);
        const min = [major, Number.parseInt(caret[2], 10), Number.parseInt(caret[3], 10)];
        const max = [major + 1, 0, 0];
        return compareTuples(current, min) >= 0 && compareTuples(current, max) < 0;
      }
      const gte = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
      if (gte) {
        const min = [
          Number.parseInt(gte[1], 10),
          Number.parseInt(gte[2] || "0", 10),
          Number.parseInt(gte[3] || "0", 10),
        ];
        return compareTuples(current, min) >= 0;
      }
      return false;
    }

    const current = parseVersionTuple(process.argv[2]);
    const satisfied = range.split("||").some((clause) => satisfiesClause(clause, current));
    process.stdout.write(range);
    process.exitCode = satisfied ? 0 : 1;
  ' "$ROOT_PACKAGE_JSON" "$current_version")" || status=$?

  if (( status == 2 )); then
    echo "spur-sidecar: broken checkout — cannot read engines.node from $ROOT_PACKAGE_JSON" >&2
    exit 1
  fi

  # The only success condition is exit 0 AND non-empty output that is the
  # engines range — a node that exits 0 (or any other status) while printing
  # nothing ran the invocation but never reached process.stdout.write(range),
  # so it did not evaluate the check and must not read as satisfied.
  if [[ -z "$output" ]]; then
    NODE_CHECK_ERROR="node $current_version could not run the engines check (node -e exited $status with no output)"
    return 1
  fi

  NODE_ENGINES_RANGE="$output"
  return "$status"
}

# The pane runs under a non-interactive login shell (env -u ... sh -lc, see
# buildCommandSessionShellCommand in v2/src/runtime-tmux.ts), which sources no
# nvm, so the sidecar otherwise lands on whatever node is already on PATH.
# The node in hand decides everything: when it already satisfies
# engines.node this is a no-op — no nvm sourced, no pin activated. That is
# the common path, and it is what fixes the #824 QA blocker (a conformant
# node 20/22 host with no node 24 under nvm). Only a host whose node cannot
# run the tree falls through to .nvmrc, which is a remedy, not the
# predicate. Runs before the workspace dependency probe and `pnpm install`
# below so one node both builds and runs the tree.
ensure_node_ready() {
  if node_satisfies_engines; then
    return 0
  fi

  if [[ ! -f "$NVMRC_FILE" ]]; then
    echo "spur-sidecar: missing node version pin: $NVMRC_FILE" >&2
    exit 1
  fi
  local pinned
  pinned="$(tr -d '[:space:]' < "$NVMRC_FILE")"
  if [[ ! "$pinned" =~ ^[0-9]+$ ]]; then
    echo "spur-sidecar: $NVMRC_FILE must hold a bare node major, found: '$pinned'" >&2
    exit 1
  fi

  local nvm_dir
  local nvm_sourced=false
  nvm_dir="${NVM_DIR:-${SPUR_REAL_HOME:-$HOME}/.nvm}"
  if [[ -s "$nvm_dir/nvm.sh" ]]; then
    nvm_sourced=true
    export NVM_DIR="$nvm_dir"
    # nvm reports its own refusals on stderr and `nvm use --silent` is mute on
    # both streams even when the version is missing (exit 3), so tolerate both
    # statuses here and let the re-check below own the diagnostic.
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh" || true
    nvm use --silent "$pinned" || true
  fi

  if node_satisfies_engines; then
    return 0
  fi

  # NODE_CHECK_ERROR is non-empty only when node could not even run the
  # check (missing, unparseable -v, or a silent/failed -e) — activating a
  # different node major via nvm does not fix that, so this branch never
  # names "nvm install" as the remedy.
  if [[ -n "$NODE_CHECK_ERROR" ]]; then
    echo "spur-sidecar: $NODE_CHECK_ERROR — cannot verify against engines.node." >&2
    exit 1
  fi

  # Two distinct remedies below, chosen by whether nvm_dir/nvm.sh was ever
  # sourced: "nvm install <pin>" and the NPM_CONFIG_PREFIX refusal hint are
  # both unrunnable/irrelevant on a host with no nvm, which never ran a
  # refusal to check in the first place.
  if [[ "$nvm_sourced" == true ]]; then
    echo "spur-sidecar: node $(node -v 2>/dev/null || echo 'not found') does not satisfy the required range $NODE_ENGINES_RANGE. $NVMRC_FILE pins node $pinned — install it with: nvm install $pinned. If node $pinned is already installed, nvm refused to load — check NPM_CONFIG_PREFIX/PREFIX in this shell." >&2
  else
    echo "spur-sidecar: node $(node -v 2>/dev/null || echo 'not found') does not satisfy the required range $NODE_ENGINES_RANGE, and nvm was not found at $nvm_dir/nvm.sh. Install a node satisfying $NODE_ENGINES_RANGE, or install nvm to pick up the $NVMRC_FILE pin (node $pinned)." >&2
  fi
  exit 1
}

# Three legs, all absolute paths so this reads correctly regardless of the
# caller's cwd: root node_modules is a real directory (not the worktree
# symlink spur.yaml:13-16 creates) containing .pnpm; v2/node_modules is a
# real directory too — the crash in #823 was ERR_MODULE_NOT_FOUND under
# v2/node_modules, and the worktree ships it as a symlink, so without this
# leg the gate can pass on exactly the tree state that kills the daemon;
# packages/web has next resolvable (including the built-in _error.js file
# next actually loads at runtime) and a working node-pty (a compiled
# binding, so its verdict is node-ABI dependent — this is why both sidecars
# must run this probe under the same node, see ensure_node_ready above).
workspace_deps_ready() {
  local root_node_modules="$SIDECAR_REPO_ROOT/node_modules"
  local web_dir="$SIDECAR_REPO_ROOT/packages/web"
  local v2_node_modules="$SIDECAR_REPO_ROOT/v2/node_modules"

  if [[ ! -d "$root_node_modules" ]] || [[ -L "$root_node_modules" ]] || [[ ! -d "$root_node_modules/.pnpm" ]]; then
    return 1
  fi

  if [[ ! -d "$v2_node_modules" ]] || [[ -L "$v2_node_modules" ]]; then
    return 1
  fi

  (
    cd "$web_dir"
    node <<'INNER'
const fs = require("fs");
const path = require("path");

const nextPackage = require.resolve("next/package.json");
const builtinErrorModule = path.join(
  path.dirname(nextPackage),
  "dist/server/route-modules/pages/builtin/_error.js",
);

if (!fs.existsSync(builtinErrorModule)) {
  process.exit(1);
}

try {
  require("node-pty");
} catch {
  process.exit(1);
}
INNER
  )
}

# Serializes the probe+repair across both sidecars with a flock on
# $SPUR_SESSION_TOOL_DIR/workspace-deps.lock so the tree is never wiped out
# from under a sidecar that already passed its own gate. The fd MUST be
# opened by the subshell redirect below, never by `exec 9>...` in the
# caller's own shell: spur-isolated-daemon.sh ends in `exec` (its daemon
# process), and an `exec`-opened fd would be inherited by that daemon for
# its entire lifetime, wedging every later sidecar start behind a lock the
# daemon never releases.
# Bounded wait, not a knob: covers a cold `pnpm install --frozen-lockfile`
# on this workspace (minutes, not seconds); a timeout is a named error and a
# nonzero exit, never a proceed-and-wipe.
WORKSPACE_DEPS_LOCK_WAIT_SECONDS=900

ensure_workspace_deps() {
  local lock_file="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}/workspace-deps.lock"

  (
    flock -w "$WORKSPACE_DEPS_LOCK_WAIT_SECONDS" 9 || {
      echo "spur-sidecar: timed out waiting up to ${WORKSPACE_DEPS_LOCK_WAIT_SECONDS}s for the workspace dependency lock: $lock_file" >&2
      exit 1
    }

    if workspace_deps_ready; then
      exit 0
    fi

    rm -rf "$SIDECAR_REPO_ROOT/node_modules" "$SIDECAR_REPO_ROOT/packages/web/node_modules" "$SIDECAR_REPO_ROOT/v2/node_modules"
    cd "$SIDECAR_REPO_ROOT"
    # 9>&- closes the lock fd for the pnpm grandchild so it cannot outlive
    # this critical section by inheriting a held lock past the subshell exit.
    env -u npm_config_virtual_store_dir HUSKY=0 pnpm install --frozen-lockfile 9>&-
  ) 9>"$lock_file"
}

find_free_port() {
  local start="$1"
  local end="$2"
  local port=""

  for candidate in $(seq "$start" "$end"); do
    if ! ss -tlnH "sport = :$candidate" | grep -q .; then
      port="$candidate"
      break
    fi
  done

  if [[ -z "$port" ]]; then
    echo "No free port in $start-$end" >&2
    return 1
  fi

  printf '%s\n' "$port"
}

resolve_sidecar_port() {
  local env_name="$1"
  local start="$2"
  local end="$3"
  local reserved="${!env_name:-}"

  if [[ -n "$reserved" ]]; then
    printf '%s\n' "$reserved"
    return 0
  fi

  find_free_port "$start" "$end"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-120}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $url" >&2
  return 1
}
