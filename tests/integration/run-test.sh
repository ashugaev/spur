#!/bin/bash
# Quick runner for integration tests

set -e

cd "$(dirname "$0")"

echo "🚀 Running Spur onboarding integration test..."
echo ""

# Build and run
docker-compose up --build --abort-on-container-exit --exit-code-from onboarding-test

# Capture exit code
EXIT_CODE=$?

# Cleanup
echo ""
echo "🧹 Cleaning up..."
docker-compose down -v

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ Test passed!"
    exit 0
else
    echo ""
    echo "❌ Test failed (exit code: $EXIT_CODE)"
    echo ""
    echo "To debug:"
    echo "  docker-compose run --rm onboarding-test /bin/bash"
    exit $EXIT_CODE
fi
