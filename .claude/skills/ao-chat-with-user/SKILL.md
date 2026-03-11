---
name: ao-chat-with-user
description: AO pipeline — handle open questions. Sends to human via connector, blocks until answers arrive.
model: inherit
allowed-tools: Bash
---

Bridge between plan and human for product questions.

## Context

Environment variables:
- `AO_ISSUE_ID` — the Jira issue key
- `AO_SESSION` — your session ID
- `AO_DATA_DIR` — session metadata directory
- `AO_CONNECTOR` — telegram | slack | jira

---

## Path 1 — Answers arrived

Check conversation for:
- `Telegram answers:`
- `Slack answers:`
- `Jira answers:`

If found:
```bash
echo "REWORK: Human answers received — <answer text>" >> "${AO_DATA_DIR}/signals.log"
```

Output: `Answers forwarded. Looping back to architect.`

Stop.

---

## Path 2 — Open questions found

Check architect output for `### Open Questions` section.

If has questions:

1. Extract SUMMARY (first paragraph after `## Plan:`)
2. Extract QUESTIONS (bullet items)

```bash
SUMMARY="<extracted>"
QUESTIONS="- <q1>
- <q2>"

# Send via connector
echo "NOTIFY: ${SUMMARY}" >> "${AO_DATA_DIR}/signals.log"
echo "QUESTIONS:" >> "${AO_DATA_DIR}/signals.log"
echo "${QUESTIONS}" >> "${AO_DATA_DIR}/signals.log"

# Block pipeline
echo "STATUS: needs_input" >> "${AO_DATA_DIR}/signals.log"
```

Output: `Questions sent via ${AO_CONNECTOR}. Pipeline blocked — waiting for human.`

Stop.

---

## Path 3 — No questions

If no `### Open Questions` and no incoming answers:

Output: `No open questions. Pipeline advancing to developer.`

Stop. Orchestrator advances automatically.
