#!/usr/bin/env bash
# Claude Code Stop hook: injects /simplify into the current session.
# Non-empty stdout prevents the agent from stopping and feeds back as a user message.
cat > /dev/null
echo '/code-simplifier'
