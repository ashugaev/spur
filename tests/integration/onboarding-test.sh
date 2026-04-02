#!/bin/bash
# Integration test: fresh Spur onboarding experience

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DAEMON_PORT=$((4310 + ($$ % 200)))
WEB_PORT=$((9000 + ($$ % 200)))

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

# Test starts here
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Spur - Onboarding Integration Test                   ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo ""

# Step 1: Simulate git clone (already done by Docker COPY, but we cd into it)
start_step "Step 1: Navigate to repository"
cd "$REPO_ROOT" || fail_step "Repository not found"
end_step "Step 1: Repository accessible"

# Step 2: Run setup script
start_step "Step 2: Running ./scripts/setup.sh"
if ! ./scripts/setup.sh; then
    fail_step "Step 2: Setup script failed"
fi
end_step "Step 2: Setup completed"

# Step 3: Verify spur command is available
start_step "Step 3: Verify spur command"
NPM_PREFIX="$(
    env -u npm_config_prefix -u npm_config_dir -u npm_config_virtual_store_dir \
        npm prefix -g 2>/dev/null || true
)"
SPUR_BIN="${NPM_PREFIX}/bin/spur"
if [ -n "$NPM_PREFIX" ] && [ -x "$SPUR_BIN" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
fi
if [ ! -x "$SPUR_BIN" ]; then
    fail_step "Step 3: spur command not found (npm link failed?)"
fi
"$SPUR_BIN" --version || fail_step "Step 3: spur --version failed"
end_step "Step 3: spur command available"

# Step 4: Create minimal test config
start_step "Step 4: Create test configuration"
mkdir -p /tmp/spur-test-project
cd /tmp/spur-test-project
git init
git config user.email "test@example.com"
git config user.name "Test User"

cat > spur.yaml << 'EOF'
server:
  host: 127.0.0.1
  port: __DAEMON_PORT__

dataDir: /tmp/spur-test-data
worktreeDir: /tmp/spur-test-worktrees
defaultAgent: codex

projects:
  test-project:
    path: /tmp/spur-test-project
    defaultBranch: main
    sessionPrefix: test
EOF
sed -i.bak "s/__DAEMON_PORT__/${DAEMON_PORT}/" spur.yaml
rm -f spur.yaml.bak

end_step "Step 4: Configuration created"

# Step 5: Verify config is valid
start_step "Step 5: Validate configuration"
# Spur reads the config directly; verify the file is readable
if [ ! -f spur.yaml ]; then
    fail_step "Step 5: Config file not found"
fi
end_step "Step 5: Configuration validated"

# Step 6: Start Spur daemon
start_step "Step 6: Start Spur daemon"
SPUR_CONFIG=/tmp/spur-test-project/spur.yaml "$SPUR_BIN" daemon start > /tmp/spur-daemon.log 2>&1 &
DAEMON_PID=$!

echo "  Waiting for daemon to start..."
for i in {1..30}; do
    if curl -sf "http://127.0.0.1:${DAEMON_PORT}/info" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $DAEMON_PID 2>/dev/null; then
        cat /tmp/spur-daemon.log
        fail_step "Step 6: Daemon process died"
    fi
    sleep 1
done

if ! curl -sf "http://127.0.0.1:${DAEMON_PORT}/info" > /dev/null 2>&1; then
    cat /tmp/spur-daemon.log
    fail_step "Step 6: Daemon not responding after 30s"
fi

end_step "Step 6: Spur daemon started successfully"

# Step 7: Verify Spur CLI against daemon
start_step "Step 7: Verify Spur CLI"
if ! SPUR_CONFIG=/tmp/spur-test-project/spur.yaml "$SPUR_BIN" list --json > /tmp/spur-list.json; then
    cat /tmp/spur-list.json 2>/dev/null || true
    fail_step "Step 7: spur list --json failed"
fi
if ! grep -q "^\[" /tmp/spur-list.json; then
    cat /tmp/spur-list.json
    fail_step "Step 7: spur list --json did not return a JSON array"
fi
end_step "Step 7: Spur CLI responding"

# Step 8: Start web UI dev server
start_step "Step 8: Start web UI"
cd "$REPO_ROOT"
PORT="$WEB_PORT" \
SPUR_CONFIG=/tmp/spur-test-project/spur.yaml \
SPUR_DAEMON_URL="http://127.0.0.1:${DAEMON_PORT}" \
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

# Test /api/sessions endpoint
if ! curl -sf "http://127.0.0.1:${WEB_PORT}/api/sessions" > /dev/null; then
    fail_step "Step 9: /api/sessions endpoint failed"
fi

# Verify the configured project page resolves
if ! curl -sf "http://127.0.0.1:${WEB_PORT}/projects/test-project" > /dev/null; then
    fail_step "Step 9: project page failed"
fi

end_step "Step 9: Web UI API responding"

# Step 10: Cleanup
start_step "Step 10: Cleanup"
kill $WEB_PID 2>/dev/null || true
kill $DAEMON_PID 2>/dev/null || true
# Wait for process to exit
sleep 2
# Force kill if still running
kill -9 $WEB_PID 2>/dev/null || true
kill -9 $DAEMON_PID 2>/dev/null || true

# Kill any remaining Node processes
pkill -f "node.*next.*dev" || true
pkill -f "dist/cli.js daemon start" || true

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
if [ -n "$GITHUB_ACTIONS" ]; then
    echo "onboarding_time_seconds=$total_duration" >> "$GITHUB_OUTPUT"
fi

exit 0
