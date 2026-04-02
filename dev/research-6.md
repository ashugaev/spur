# Research 6: Claude Code TUI Layout and Spinner Patterns

Source: `@anthropic-ai/claude-code@2.1.90` npm package (minified, single `cli.js` bundle).

---

## 1. TUI Framework

**Ink (React for CLI)** — Claude Code uses Ink with React 19 and Yoga layout engine.

Evidence:
- Custom Ink node types: `ink-box`, `ink-text`, `ink-virtual-text`, `ink-link`, `ink-progress`, `ink-raw-ansi`, `ink-root`
- React hooks: `useInput`, `useApp`, `useFocus`, `useStdout`, `useInterval`, `useAnimationTimer`, `useAnimationFrame`
- Yoga flexbox layout: `flexDirection`, `flexGrow`, `flexShrink`, `flexWrap`, padding, margin, border
- `Symbol.for("react.transitional.element")`, `Symbol.for("react.memo_cache_sentinel")` — React 19 internals
- Zero runtime dependencies — everything (React, Ink, Yoga) is bundled into the single `cli.js`

## 2. Spinner Characters

### Main "thinking" spinner (star cycle)
Platform-specific, 960ms interval per frame:

```
macOS:  ["·", "✢", "✳", "✶", "✻", "✽"]
other:  ["·", "✢", "*", "✶", "✻", "✽"]
```

Variables: `o85="✳"` (default/idle star), `s85=["⠂","⠐"]` (minimal dot spinner), `vaY=960` (interval ms).

The star spinner animates through these characters while processing. The idle/default character shown is `✳`.

### Clack/prompt spinner (braille dots)
Used for interactive prompts (Clack integration):

```
interval: 80ms
frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]  (yellow)
```

### Loading spinner (ASCII)
```
["·|·", "·/·", "·—·", "·\\·"]
```

Variable `wB6`. Used during command execution / tool use progress display.

## 3. TUI Layout

The main layout is a vertical flex column of Ink `<Box>` components:

```
┌─────────────────────────────────────────────┐
│  Content area (messages, tool output, JSX)   │  flexGrow: 1
│  - Scrollable message list                   │
│  - Tool use output (inline JSX)              │
│  - Thinking indicator: "✻ Thinking…"         │
│                                              │
├─────────────────────────────────────────────┤
│  Input area (when not hidden)                │  shouldHidePromptInput controls visibility
│  ❯ [user input text]                         │
├─────────────────────────────────────────────┤
│  Status bar                                  │  Bottom row
│  [✻] [✻] [✻] · Share   ⏵⏵ mode label       │
└─────────────────────────────────────────────┘
```

Key layout flags:
- `shouldHidePromptInput` — hides the input field during tool execution, commands, etc.
- `showSpinner` — controls whether the processing spinner is visible
- `shouldContinueAnimation` — keeps the star spinner cycling
- `expandedView` — toggles between normal and "task" expanded view

## 4. Input Field (`❯` prompt)

The `❯` character comes from a figures/symbols object:

```js
pointer: "❯"
```

This is the `pointer` symbol from the `figures` library (bundled). The input area is a custom Ink component that:
- Shows `❯` as the prompt prefix
- Supports inline suggestions like `[suggestion:❯ src/auth.ts]`
- Is hidden when `shouldHidePromptInput` is true (during tool execution, local JSX commands, etc.)

## 5. Status Bar (`⏵⏵`)

The status bar is rendered at the bottom. The `⏵⏵` symbol appears in multiple permission/mode indicators:

```js
// Mode indicators with ⏵⏵ symbol:
acceptEdits:       { symbol: "⏵⏵", color: "autoAccept" }
bypassPermissions: { symbol: "⏵⏵", color: "error" }
dontAsk:           { symbol: "⏵⏵", color: "error" }
auto:              { symbol: "⏵⏵", color: "warning" }

// Status bar labels array:
[
  { label: "default",         symbol: "",    color: "text" },
  { label: "accept edits on", symbol: "⏵⏵", color: "autoAccept" },
  { label: "plan mode on",    symbol: "⏸",  color: "planMode" },
  { label: "auto mode on",    symbol: "⏵⏵", color: "warning" },
]
```

The bottom bar also shows `[✻] [✻] [✻] ·` followed by "Share" and the current mode label. The `[✻]` blocks are colored with `"claude"` theme color.

## 6. Terminal Title

Yes, Claude Code sets the terminal title via OSC escape sequences:

```js
// On startup:
process.title = "claude"

// During session, uses OSC 0 (SET_TITLE_AND_ICON):
// ESC ] 0 ; <title> BEL
// Format: "✻ [Claude Code] <session-name> (<id-prefix>) ⧉"
`✻ [Claude Code] ${sessionName} (${idPrefix}) ⧉`
```

Control:
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` env var disables it
- `terminalTitleFromRename` setting controls whether `/rename` updates the title (default: true)
- On Windows, uses `process.title`; on Unix, writes OSC escape sequence directly
- Title is cleared on exit via `SET_TITLE_AND_ICON` with empty string

Additional terminal integrations:
- **Kitty**: `i=<id>:d=0:p=title` / `p=body` for notifications
- **Ghostty**: `notify` OSC for native notifications
- **iTerm2**: Progress indicator via OSC 9;4 (PROGRESS: CLEAR/SET/ERROR)
- **Tab status**: OSC 21337 for tab status indicators

## 7. Hook Events

Complete hook event list (from the `UR` array and Zod schemas):

| Event | Payload Fields | When |
|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | Before a tool is executed |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | After successful tool execution |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_error` | After tool execution fails |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_*` | When permission dialog would show |
| `PermissionDenied` | `tool_name`, `tool_input`, `tool_use_id` | When user denies permission |
| `Notification` | `message`, `title?`, `notification_type` | System/agent notifications |
| `UserPromptSubmit` | `prompt` | When user submits a prompt |
| `SessionStart` | `source: "startup"\|"resume"\|"clear"\|"compact"`, `agent_type?`, `model?` | Session begins or resumes |
| `SessionEnd` | `reason` | Session is ending |
| `Stop` | `stop_hook_active`, `last_assistant_message` | Before Claude concludes response |
| `StopFailure` | `error`, `error_details?`, `last_assistant_message` | Stop hook itself failed |
| `SubagentStart` | `agent_id`, `agent_type` | Subagent spawned |
| `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_type` | Subagent concluding |
| `PreCompact` | `trigger: "manual"\|"auto"`, `custom_instructions?` | Before conversation compaction |
| `PostCompact` | `trigger: "manual"\|"auto"`, `compact_summary` | After compaction completes |
| `Setup` | `trigger: "init"\|"maintenance"` | During initialization |
| `TeammateIdle` | `teammate_name`, `team_name` | Teammate agent goes idle |
| `TaskCreated` | `task_id`, `task_subject`, `task_description` | Task created |
| `TaskCompleted` | `task_id`, `task_subject`, `task_description` | Task finished |
| `Elicitation` | `mcp_server_name`, `message`, `mode` | MCP server requests user input |
| `ElicitationResult` | `mcp_server_name`, `elicitation_id?`, `mode?`, `action`, `content?` | User responds to elicitation |
| `ConfigChange` | `source`, `file_path?` | Settings file changed |
| `WorktreeCreate` | `name` | Git worktree created |
| `WorktreeRemove` | `worktree_path` | Git worktree removed |
| `InstructionsLoaded` | `file_path`, `memory_type`, `load_reason`, `globs?` | CLAUDE.md or memory file loaded |
| `CwdChanged` | `old_cwd`, `new_cwd` | Working directory changed |
| `FileChanged` | `file_path`, `event` | File system change detected |

### Hook Types

Four hook execution types:
1. **`command`** — Shell command to execute
2. **`prompt`** — LLM prompt to evaluate (uses `$ARGUMENTS`)
3. **`http`** — HTTP POST to a URL with hook input JSON
4. **`agent`** — Agentic verifier (prompt describing what to verify)

### Common Hook Input Base Fields

All hook inputs include (via `uw()` base schema):
- `hook_event_name` — the event type
- `agent_type?` — present in subagent context or `--agent` sessions
- `agent_id?` — present in subagent context

### Hook Configuration

Hooks are configured per-event with a matcher pattern:
```json
{
  "PostToolUse": [{
    "matcher": "Edit|Write",
    "hooks": [{ "type": "command", "command": "echo Done" }]
  }]
}
```

Matchers support `*` wildcards and `|` alternation.

## 8. Symbol Reference Table

| Variable | Character | Usage |
|---|---|---|
| `JT` | `◆` | Filled diamond |
| `PX` | `◇` | Empty diamond |
| `S9` | `⏺` (macOS) / `●` (other) | Dot indicator |
| `U51` | `∙` | Small dot |
| `cE` | `✻` | Star (Claude brand mark in CLI) |
| `TD6` | `↑` | Up arrow |
| `vA8` | `↓` | Down arrow |
| `VC7` | `○` | Empty circle |
| `TA8` | `◐` | Half circle |
| `Q51` | `●` | Filled circle |
| `NC7` | `◉` | Target circle |
| `AB6` | `⏸` | Pause (plan mode) |
| `LC7` | `※` | Reference mark |
| `hC7` | `▎` | Left bar |
| `kA8` | `·✔︎·` | Success check |
| `VA8` | `×` | Error cross |

## 9. Color Themes

Claude Code defines multiple color themes (full RGB, ANSI-256, ANSI-16, light mode variants). Key named colors:
- `claude` — the primary brand color
- `claudeShimmer` — animated shimmer variant of claude color
- `rainbow_*_shimmer` — rainbow shimmer colors for the thinking animation
- `autoAccept` — magenta for accept-edits mode
- `warning` — for auto mode
- `error` — for bypass/dontask modes
- `success` — green
- `suggestion` — for inline suggestions

The "shimmer" effect is a rainbow gradient that sweeps across text (the `✻` brand mark) using interpolated colors, with a `prefersReducedMotion` accessibility override.
