#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_PORT=$((9000 + ($$ % 200)))
TEST_PROJECT_DIR="/tmp/test-project"
SPUR_HOME="/tmp/spur-home"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Timing utilities
start_time=$(date +%s)
step_start=0

start_step() {
    echo -e "\n${BLUE}▶ $1${NC}"
    step_start=$(date +%s)
}

end_step() {
    local step_end=$(date +%s)
    local duration=$((step_end - step_start))
    echo -e "${GREEN}✓ $1 (${duration}s)${NC}"
}

fail_step() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

cleanup_pid() {
    local pid="${1:-}"
    if [ -z "$pid" ]; then
        return
    fi

    kill "$pid" 2>/dev/null || true
    sleep 2
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

# Test starts here
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Spur - Onboarding Integration Test                   ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo ""

start_step "Step 1: Navigate to repository"
cd "$REPO_ROOT" || fail_step "Repository not found"
end_step "Step 1: Repository accessible"

# Step 2: Install repo dependencies for the optional web smoke
start_step "Step 2: Install repo dependencies"
if ! pnpm install; then
    fail_step "Step 2: pnpm install failed"
fi
end_step "Step 2: Repo dependencies installed"

# Step 3: Pack the published CLI boundary
start_step "Step 3: Pack Spur tarball"
PACK_LOG="/tmp/spur-pack-output.log"
npm pack --json ./v2 > "$PACK_LOG"
PACK_OUTPUT="$(sed -n '/^\[$/,$p' "$PACK_LOG")"
TARBALL_NAME="$(printf '%s' "$PACK_OUTPUT" | jq -r '.[0].filename')"
if [ -z "$TARBALL_NAME" ] || [ ! -f "$REPO_ROOT/$TARBALL_NAME" ]; then
    printf '%s\n' "$PACK_OUTPUT"
    fail_step "Step 3: npm pack did not produce a tarball"
fi
end_step "Step 3: Spur tarball packed"

# Step 4: Install the packed tarball globally
start_step "Step 4: Install Spur tarball"
if ! npm install -g "$REPO_ROOT/$TARBALL_NAME"; then
    fail_step "Step 4: global tarball install failed"
fi
SPUR_BIN="$(command -v spur || true)"
if [ -z "$SPUR_BIN" ]; then
    fail_step "Step 4: spur command not found after tarball install"
fi
"$SPUR_BIN" --version || fail_step "Step 4: spur --version failed"
end_step "Step 4: Spur tarball installed"

# Step 5: Create a fresh repo outside the Spur checkout
start_step "Step 5: Create fresh test repo"
rm -rf "$TEST_PROJECT_DIR" "$SPUR_HOME"
mkdir -p "$TEST_PROJECT_DIR" "$SPUR_HOME"
cd "$TEST_PROJECT_DIR"
git init -b main
git config user.email "test@example.com"
git config user.name "Test User"
touch README.md
git add README.md
git commit -m "init" > /dev/null 2>&1
end_step "Step 5: Fresh repo created"

# Step 6: Run doctor in the fresh repo
start_step "Step 6: Run spur doctor"
DOCTOR_OUTPUT="$(HOME="$SPUR_HOME" "$SPUR_BIN" doctor --json)" || fail_step "Step 6: spur doctor failed"
PROJECT_ID="$(printf '%s' "$DOCTOR_OUTPUT" | jq -r '.projectId')"
if [ "$PROJECT_ID" != "test-project" ]; then
    printf '%s\n' "$DOCTOR_OUTPUT"
    fail_step "Step 6: spur doctor produced unexpected project id"
fi
if [ ! -f spur.yaml ]; then
    fail_step "Step 6: Config file not found"
fi
if ! grep -q "path: \." spur.yaml; then
    cat spur.yaml
    fail_step "Step 6: spur doctor did not write a usable local config"
fi
end_step "Step 6: spur doctor scaffolded a local config"

# Step 7: Verify auto-connect starts the daemon and registers the project
start_step "Step 7: Verify Spur CLI auto-connect"
if ! HOME="$SPUR_HOME" "$SPUR_BIN" list --json > /tmp/spur-list.json; then
    cat /tmp/spur-list.json 2>/dev/null || true
    fail_step "Step 7: spur list --json failed"
fi
if ! grep -q "^\[" /tmp/spur-list.json; then
    cat /tmp/spur-list.json
    fail_step "Step 7: spur list --json did not return a JSON array"
fi
echo "  Waiting for daemon to start..."
for i in {1..30}; do
    if curl -sf "http://127.0.0.1:4310/info" > /tmp/spur-info.json 2>/dev/null; then
        break
    fi
    sleep 1
done

if ! curl -sf "http://127.0.0.1:4310/projects" | jq -e --arg project_id "$PROJECT_ID" '.[] | select(.id == $project_id)' > /dev/null; then
    curl -sf "http://127.0.0.1:4310/projects" || true
    fail_step "Step 7: auto-connect did not register the project"
fi
end_step "Step 7: Spur CLI auto-connect works"

# Step 8: Start web UI dev server
start_step "Step 8: Start web UI"
cd "$REPO_ROOT"
PORT="$WEB_PORT" \
HOME="$SPUR_HOME" \
SPUR_DAEMON_URL="http://127.0.0.1:4310" \
pnpm --dir packages/web dev > /tmp/spur-web.log 2>&1 &
WEB_PID=$!

echo "  Waiting for web UI to start..."
for i in {1..30}; do
    if curl -s "http://127.0.0.1:${WEB_PORT}" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $WEB_PID 2>/dev/null; then
        cat /tmp/spur-web.log
        fail_step "Step 8: Web UI process died"
    fi
    sleep 1
done

if ! curl -s "http://127.0.0.1:${WEB_PORT}" > /dev/null 2>&1; then
    cat /tmp/spur-web.log
    fail_step "Step 8: Web UI not responding after 30s"
fi

end_step "Step 8: Web UI started successfully"

# Step 9: Verify web UI endpoints
start_step "Step 9: Verify web UI API"

for i in {1..30}; do
    if curl -sf "http://127.0.0.1:${WEB_PORT}/api/sessions" > /dev/null; then
        break
    fi
    sleep 1
done
if ! curl -sf "http://127.0.0.1:${WEB_PORT}/api/sessions" > /dev/null; then
    fail_step "Step 9: /api/sessions endpoint failed"
fi

for i in {1..30}; do
    if curl -sf "http://127.0.0.1:${WEB_PORT}/?project=${PROJECT_ID}" > /dev/null; then
        break
    fi
    sleep 1
done
# Verify the configured project filter resolves on the dashboard
if ! curl -sf "http://127.0.0.1:${WEB_PORT}/?project=${PROJECT_ID}" > /dev/null; then
    fail_step "Step 9: project dashboard filter failed"
fi

end_step "Step 9: Web UI API responding"

# Step 10: Cleanup
start_step "Step 10: Cleanup"
cleanup_pid "$WEB_PID"
HOME="$SPUR_HOME" "$SPUR_BIN" daemon stop > /tmp/spur-daemon-stop.log 2>&1 || true
pkill -f "node.*next.*dev" || true

end_step "Step 10: Cleanup completed"

# Calculate total time
end_time=$(date +%s)
total_duration=$((end_time - start_time))

# Summary
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           🎉 All Tests Passed!                         ║${NC}"
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo ""
echo -e "${BLUE}Total onboarding time: ${total_duration}s${NC}"
echo ""

# Export metrics for CI
if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "onboarding_time_seconds=$total_duration" >> "$GITHUB_OUTPUT"
fi

exit 0
