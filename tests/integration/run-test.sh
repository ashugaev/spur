#!/bin/bash
# Quick runner for integration tests

set -e

cd "$(dirname "$0")"

echo "🚀 Running Spur onboarding integration test..."
echo ""

# Build and run
docker compose up --build -d onboarding-test
CONTAINER_ID="$(docker compose ps -q onboarding-test)"
if [ -z "$CONTAINER_ID" ]; then
    echo "Failed to resolve onboarding-test container ID" >&2
    docker compose ps
    exit 1
fi
docker logs -f "$CONTAINER_ID" &
LOGS_PID=$!
EXIT_CODE="$(docker wait "$CONTAINER_ID")"
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
