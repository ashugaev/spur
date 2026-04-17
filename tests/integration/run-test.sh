#!/bin/bash
# Quick runner for integration tests

set -e

cd "$(dirname "$0")"

echo "🚀 Running Agent Orchestrator onboarding integration test..."
echo ""

# Build and run
docker compose up --build -d onboarding-test
docker logs -f spur-onboarding-test &
LOGS_PID=$!
EXIT_CODE="$(docker wait spur-onboarding-test)"
wait "$LOGS_PID" || true

# Capture exit code
# Cleanup
echo ""
echo "🧹 Cleaning up..."
docker compose down -v

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ Test passed!"
    exit 0
else
    echo ""
    echo "❌ Test failed (exit code: $EXIT_CODE)"
    echo ""
    echo "To debug:"
    echo "  docker compose run --rm onboarding-test /bin/bash"
    exit $EXIT_CODE
fi
