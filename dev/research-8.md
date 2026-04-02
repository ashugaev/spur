# Research 8: Claude Code Hook System for Status Tracking

## 1. All Available Hook Events

As of early 2026, Claude Code exposes ~22 hook lifecycle events:

### Session Lifecycle
| Event | Description |
|-------|-------------|
| **SessionStart** | Session begins, resumes, or restarts after /clear or compaction |
| **SessionEnd** | Session terminates |
| **Setup** | Triggered via `--init`, `--init-only`, or `--maintenance` CLI flags |
| **InstructionsLoaded** | When CLAUDE.md or `.claude/rules/*.md` is loaded |
| **ConfigChange** | When a configuration file changes during a session |

### User Input
| Event | Description |
|-------|-------------|
| **UserPromptSubmit** | User submits a prompt, before Claude processes it |
| **Elicitation** | MCP server requests user input during a tool call |
| **ElicitationResult** | User responds to an MCP elicitation |

### Tool Execution
| Event | Description |
|-------|-------------|
| **PreToolUse** | Before a tool call executes (can block/modify) |
| **PostToolUse** | After a tool call succeeds |
| **PostToolUseFailure** | After a tool call fails |
| **PermissionRequest** | When a permission dialog appears |

### Agent Completion
| Event | Description |
|-------|-------------|
| **Stop** | Claude finishes responding (main agent) |
| **StopFailure** | API error during response generation |
| **SubagentStart** | A subagent is spawned |
| **SubagentStop** | A subagent finishes responding |

### Compaction
| Event | Description |
|-------|-------------|
| **PreCompact** | Before context compaction |
| **PostCompact** | After context compaction completes |

### Notification
| Event | Description |
|-------|-------------|
| **Notification** | Claude Code sends an alert (permission, idle, auth, elicitation) |

### Multi-Agent Team (added ~v2.1.33, Feb 2026)
| Event | Description |
|-------|-------------|
| **TeammateIdle** | Agent team teammate is about to go idle after finishing its turn |
| **TaskCompleted** | A task in the shared task list is marked complete |

### Workspace
| Event | Description |
|-------|-------------|
| **WorktreeCreate** | Worktree is being created via `--worktree` or `isolation: "worktree"` |
| **WorktreeRemove** | Worktree is being removed |

---

## 2. JSON Payload Schema Per Hook Event

All hooks receive a **common base payload** via stdin (for command hooks) or POST body (for HTTP hooks):

```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

### Event-Specific Fields

**SessionStart:**
- `source`: `"startup"` | `"resume"` | `"clear"` | `"compact"`
- `model`: model identifier string
- `agent_type`: (optional) agent name if launched with `--agent <n>`

**UserPromptSubmit:**
- `prompt`: the user's submitted prompt text

**PreToolUse / PostToolUse:**
- `tool_name`: `"Bash"`, `"Write"`, `"Edit"`, `"Read"`, `"Glob"`, `"Grep"`, etc.
- `tool_input`: tool-specific parameters object
- `tool_response` (PostToolUse only): the result returned by the tool

**PostToolUseFailure:**
- `tool_name`, `tool_input`, `error`: error details

**Stop:**
- `stop_hook_active`: boolean -- true if Claude is already in a forced-continuation state from a previous Stop hook block (check this to prevent infinite loops)

**SubagentStop:**
- `stop_hook_active`: boolean
- `agent_id`: subagent identifier
- `agent_type`: subagent type
- `agent_transcript_path`: path to the subagent's own transcript
- `last_assistant_message`: text content of the subagent's final response

**Notification:**
- `message`: notification text
- `title`: (optional) notification title
- `notification_type`: `"permission_prompt"` | `"idle_prompt"` | `"auth_success"` | `"elicitation_dialog"`

**PreCompact:**
- `trigger`: what caused compaction
- `custom_instructions`: any custom compaction instructions

**TeammateIdle:**
- teammate identification fields (underdocumented as of Apr 2026)

**TaskCompleted:**
- `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name`

**PermissionRequest:**
- Tool-related fields (tool_name, tool_input); allows approve/deny decisions

---

## 3. Timing: When Each Hook Fires Relative to UI State

| Hook | Fires... | UI State at Fire Time |
|------|----------|----------------------|
| **SessionStart** | At session initialization, before first prompt | Session loading / initializing |
| **UserPromptSubmit** | After user presses Enter, before Claude processes | Transitioning from "waiting" to "working" |
| **PreToolUse** | Before each tool execution, during Claude's turn | "working" -- Claude is mid-response |
| **PostToolUse** | After each tool succeeds, during Claude's turn | "working" -- Claude is mid-response |
| **PermissionRequest** | When Claude pauses for permission approval | "needs_input" -- waiting for user approval |
| **Stop** | After Claude finishes its response, before UI returns to prompt | Transitioning from "working" to "waiting" |
| **SubagentStop** | After a subagent finishes, parent still active | Parent agent "working", subagent done |
| **Notification** | When Claude sends an alert | Depends on notification_type |
| **SessionEnd** | When session terminates | Session closing |

### Key timing observations:
- **UserPromptSubmit** fires synchronously before processing -- stdout is injected as context.
- **Stop** fires after response generation but before the UI prompt reappears. This is the definitive signal that Claude has returned to "waiting for user input."
- **Notification (idle_prompt)** has a hardcoded ~60-second delay before firing. It fires after every response, not just when Claude genuinely needs attention. This makes it unreliable for real-time status detection.
- Hooks do NOT fire on user interrupts (Ctrl+C / Escape).
- API errors fire **StopFailure** instead of **Stop**.

---

## 4. Hooks for Thinking Start/Stop (Not Just User Input)

**There is no dedicated hook for when Claude starts or stops "thinking."**

The closest signals:
- **UserPromptSubmit**: Fires when the user submits a prompt, indicating Claude is about to start working. This is the "start thinking" signal.
- **Stop**: Fires when Claude finishes its entire response turn. This is the "stop thinking" signal.
- **PreToolUse / PostToolUse**: Fire during tool execution within a thinking turn, but do not indicate the overall start/stop of thinking.

There is no hook that fires when:
- Claude starts generating text (after processing the prompt internally)
- Claude pauses between tool calls to "think"
- Claude's internal reasoning begins or ends within a turn

The gap: between UserPromptSubmit and Stop, you have no hook-level signal about whether Claude is actively generating, waiting for a tool, or thinking between tool calls. You only get PreToolUse/PostToolUse for tool boundaries.

---

## 5. Hook for Tool Approval Waiting

**Yes: `PermissionRequest` and `Notification` with `notification_type: "permission_prompt"`.**

- **PermissionRequest** fires when a permission dialog is shown. It supports decision control -- you can auto-approve or auto-deny via JSON output `{"decision": "allow"}` or `{"decision": "deny", "reason": "..."}`.
- **Notification** with `notification_type: "permission_prompt"` fires as an alert when Claude needs permission. Notification hooks cannot block or modify -- they are observe-only.

For Spur's use case (detecting that Claude is waiting for approval), the **Notification** hook with `permission_prompt` matcher is the relevant signal. However, since Spur runs with `--dangerously-skip-permissions`, this should rarely fire.

---

## 6. Real Projects Using Hooks for Status Detection

### Spur (this repo, `v2/`)
Uses **SessionStart**, **UserPromptSubmit**, and **Stop** hooks to track working/waiting state:
- Hook command writes a JSON state file (`session-agent-state/<sessionId>.json`) with `state: "working" | "waiting"`, `updatedAt`, `hookEvent`, and `turnId`.
- `UserPromptSubmit` -> `state: "working"`
- `SessionStart` or `Stop` -> `state: "waiting"`
- Session service reads this file during status polling. Fresh "working" state (within 2 seconds) skips expensive tmux pane capture. "Waiting" state is trusted but still checks pane for `needs_input`.
- See: `v2/src/agent-hook-state.ts`, `v2/src/session-slots.ts` (lines 220-270), `v2/src/agents/claude.ts` (ensureClaudeHookSettings), `v2/src/session-service.ts` (lines 2025-2040).

### disler/claude-code-hooks-multi-agent-observability
- Real-time monitoring for Claude Code agents through hook event tracking.
- Intercepts all hook events via scripts (pre_tool_use.py, post_tool_use.py, notification.py, etc.) and sends them to a central event store.
- GitHub: https://github.com/disler/claude-code-hooks-multi-agent-observability

### dennishansen's Status Bar Setup
- Uses hooks to mark sessions as active/idle for a status bar display.
- Hooks on UserPromptSubmit (-> active), SessionStart (-> active), Stop (-> idle).
- Background process polls transcript modification time as a fallback.
- Gist: https://gist.github.com/dennishansen/e7b4253ce9350e9a7d4d8fa5d5013bc9

### sho7650/claude-watch-status
- Detects agent states by parsing JSONL transcripts.
- States: processing, calling tool, thinking, waiting approval, completed.
- GitHub: https://github.com/sho7650/claude-watch-status

### simple10/agents-observe
- Real-time observability of claude code sessions and multi-agents.
- GitHub: https://github.com/simple10/agents-observe

---

## 7. Undocumented Hooks and Recent Additions

### Partially or Under-Documented (as of Apr 2026)
- **TeammateIdle** and **TaskCompleted** were added in v2.1.33 (Feb 2026) but their documentation was initially missing. GitHub issues #23545 and #30574 track documentation gaps. They support `{"continue": false, "stopReason": "..."}` JSON decision control matching Stop hook behavior.
- **Setup** (triggered via `--init`, `--init-only`, `--maintenance`) was underdocumented per issue #18724.
- **SessionEnd** has limited documentation per issue #6306; it is available as an SDK callback hook in TypeScript but its payload schema is sparse.
- **InstructionsLoaded**, **ConfigChange**, **WorktreeCreate**, **WorktreeRemove** are listed in some references but have minimal payload documentation.
- **SessionLoad** appears in some references as firing at session start and when files are lazily loaded, but is not consistently documented.

### Handler Types (4 total)
1. **command** -- shell command, receives JSON on stdin, returns via exit code + stdout JSON
2. **http** -- HTTP POST to a URL, returns via response body JSON
3. **prompt** -- single-turn Claude model evaluation (30s default timeout)
4. **agent** -- spawns a subagent with Read/Grep/Glob tools (60s default timeout)

Only `command` supports `async: true` (fire-and-forget, non-blocking).

### Matcher System
Hooks support a `matcher` field for filtering which tool/notification triggers the hook:
- PreToolUse/PostToolUse: matcher matches against `tool_name` (e.g., `"Bash"`, `"Write"`)
- Notification: matcher matches against `notification_type` (e.g., `"permission_prompt"`, `"idle_prompt"`)
- SubagentStart/SubagentStop: matcher matches against agent type

### Output JSON Control
Hooks return decisions via stdout JSON:
- **PreToolUse**: `{"decision": "allow"}`, `{"decision": "deny", "reason": "..."}`, or `{"decision": "modify", "tool_input": {...}}`
- **Stop / TeammateIdle / TaskCompleted**: `{"continue": false, "stopReason": "..."}` to force continuation
- **UserPromptSubmit / SessionStart**: stdout is injected as context Claude can see
- **PermissionRequest**: `{"decision": "allow"}` or `{"decision": "deny", "reason": "..."}`

### Known Limitations
- **idle_prompt** Notification fires after every response with a 60-second delay -- not reliable for real-time "waiting" detection.
- No hook fires on user interrupt (Ctrl+C / Escape).
- SubagentStop shares session_id with parent, making it hard to distinguish which subagent finished (issue #7881).
- Hooks do not fire for internal thinking state transitions -- only for prompt submission, tool boundaries, and response completion.

---

## Summary for Spur's Status Tracking

Spur's current approach (SessionStart + UserPromptSubmit + Stop) is the correct minimal set for working/waiting detection. The key insights:

1. **UserPromptSubmit = "working"** -- fires immediately when a prompt is submitted, before Claude processes it.
2. **Stop = "waiting"** -- fires when Claude finishes its response, before the UI returns to the prompt.
3. **SessionStart = "waiting"** -- fires at session initialization, covers the startup case.
4. **No hook exists** for mid-turn state (thinking vs. tool-calling vs. generating). The PreToolUse/PostToolUse hooks could theoretically be used to detect tool execution boundaries, but this adds complexity without clear benefit for Spur's coarse working/waiting model.
5. **Notification (idle_prompt)** is too slow (60s delay) and too noisy (fires after every response) to replace Stop for status detection.
6. **TeammateIdle / TaskCompleted** are relevant only for Claude's built-in multi-agent team feature, not for Spur's external orchestration model.

Sources:
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide
- https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/SKILL.md
- https://github.com/anthropics/claude-code/issues/23545
- https://github.com/anthropics/claude-code/issues/3447
- https://github.com/disler/claude-code-hooks-multi-agent-observability
- https://gist.github.com/dennishansen/e7b4253ce9350e9a7d4d8fa5d5013bc9
- https://github.com/sho7650/claude-watch-status
- https://github.com/simple10/agents-observe
