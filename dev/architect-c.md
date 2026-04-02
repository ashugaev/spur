# Architect C: Combined Multi-Signal Status Detection

## Problem Summary

Claude Code always renders `❯` in its TUI input field. When `HOOK_FRESHNESS_MS` (2s) expires between tool calls, `enrich()` falls through to `classifyLivePaneState()`, which sees `❯` on the last line and returns `"waiting"` -- even when the agent is actively working. A typical Claude turn is 30s-5min; the hook is trusted for 2s. The status is wrong for 93-99% of the turn.

## Root Cause

The 2s freshness window on "working" hook state is the single root cause. The hooks are authoritative -- `UserPromptSubmit` fires at turn start, `Stop` fires at turn end. Between those two events, the agent is working. There is no reason to distrust the hook after 2s and fall through to pane classification, which cannot distinguish working from idle for Claude Code.

## Design: Trust Hooks, Verify with Pane

### Core principle

**Hooks are the state machine. Pane is the needs_input overlay. Process liveness is the gate.**

The hook state file is a mini state machine: `UserPromptSubmit` sets `"working"`, `Stop`/`SessionStart` sets `"waiting"`. These transitions are authoritative and should be trusted until the next hook event overwrites them -- not for 2 seconds, but indefinitely.

The only reason to check the pane is to detect `needs_input` (permission prompts, interview UIs), which hooks cannot signal. And the only reason to run full pane classification is when no hook state exists at all (first poll before any hook fires, or hook file missing).

### Priority waterfall

```
1. Process liveness (gate)
   - !runtimeAlive || !processAlive → "stopped"

2. Hook state (authoritative when present)
   - hook.state === "working" → check pane for needs_input only → "working" or "needs_input"
   - hook.state === "waiting" → check pane for needs_input only → "waiting" or "needs_input"

3. Terminal title (Claude Code sets title with ✻ prefix when active)
   - Title contains "✻" → "working"
   - Title present but no "✻" → null (not conclusive alone, fall through)
   - For Codex: existing classifyCodexTitle logic (unchanged)

4. Pane content (last resort, only when no hook state exists)
   - "esc to interrupt" in bottom 20 lines → "working"
   - needs_input patterns → "needs_input"
   - Prompt char on last line → "waiting"
   - Default → "working" (bias toward false-busy)

5. State debounce (unchanged, 4s hold window)
```

### Why remove HOOK_FRESHNESS_MS entirely

The freshness window was designed to prevent stale "working" state if the agent crashes without firing `Stop`. But this scenario is already handled by step 1 (process liveness). If the agent process is dead, `!processAlive` catches it before hooks are even checked. If the process is alive and the last hook was `UserPromptSubmit`, the agent is working -- there is no scenario where the process is alive, the last hook was `UserPromptSubmit`, and the agent is not working.

The only edge case: Claude Code hangs (process alive but unresponsive, never fires `Stop`). This is rare and the existing 4s debounce + process check on subsequent polls handles it adequately. A hung process is still "working" from the user's perspective -- showing "waiting" would be worse (user sends a message that gets lost).

### New hook events: PreToolUse and PostToolUse

Add `PreToolUse` and `PostToolUse` to the registered hooks. Map both to `"working"`. This keeps the hook state file's `updatedAt` timestamp fresh throughout a multi-tool turn, which:
- Provides diagnostic value (the hook file shows what the agent is doing)
- Acts as a heartbeat for the rare hung-process case (if `updatedAt` stops advancing for minutes while the process is alive, a future enhancement could flag it)

The `mapHookEventToState` function gains two new entries. The hook settings for Claude gain two new hook entries with `matcher: "*"` (all tools).

### Claude Code terminal title

Research-6 confirms Claude Code sets the terminal title:
```
✻ [Claude Code] <session-name> (<id-prefix>) ⧉
```

This title is set during an active session. The `✻` character (Claude's brand mark) is present while the session is alive. This is not a working/idle discriminator by itself -- the title does not change between working and waiting states within a session. So the title serves as a **session-alive confirmation** rather than a state signal. It is not useful for the working/waiting distinction, but it confirms the agent process is the Claude Code TUI (not a crashed shell).

For Codex, the existing `classifyCodexTitle` logic is already correct and unchanged.

### Pane classification improvements for the no-hook fallback

When no hook state exists (agent just spawned, hooks not yet installed, or hook file deleted), the pane classifier runs. Two improvements:

1. **Add "esc to interrupt" check for Claude.** Research confirms `"esc to interrupt"` is the universal working indicator across all TUI agents. Claude Code shows it during tool execution. Currently `classifyLivePaneState` does not check for it -- it only checks `PROMPT_RE`. Add this check before the prompt check.

2. **Add `-J` flag to `captureTmuxPane`.** This joins wrapped lines, preventing terminal width changes from breaking line-based pattern matching. dmux uses this and it is a proven anti-flicker measure.

3. **Default to "working" instead of checking prompt.** When no hook state exists and no positive idle signal is found, assume working (bias toward false-busy). Currently the code returns "waiting" when `PROMPT_RE` matches, which is wrong for Claude Code where `❯` is always visible.

However, approach 3 is only for the no-hook fallback path. With hooks properly trusted, this path rarely executes for established sessions.

---

## Comparison with Approaches A and B

### Approach A: Hook-First (trust hooks, remove freshness)

Approach A focuses narrowly on removing `HOOK_FRESHNESS_MS` and trusting hooks indefinitely. This is the correct core fix and the highest-impact single change. Approach C incorporates this entirely.

**What A misses:**
- No improvement to the pane fallback path (still returns "waiting" when it sees `❯` in the no-hook case)
- No additional hook events (PreToolUse/PostToolUse) for freshness and diagnostics
- No "esc to interrupt" check for Claude's pane classification
- No `-J` flag on capture-pane

**Verdict:** A is the minimal correct fix. C is A plus defense-in-depth.

### Approach B: Title + Pane (terminal title as primary, enhanced pane regex)

Approach B would rely on Claude Code's terminal title and enhanced pane content parsing (spinner chars, "esc to interrupt", strip `❯` as chrome).

**Why B is weaker:**
- Claude Code's terminal title does NOT change between working and waiting states. It is `✻ [Claude Code] name (id) ⧉` throughout the session. Title-based detection cannot distinguish working from waiting for Claude (unlike Codex which sets status keywords in the title).
- Pane-based detection for Claude is fundamentally broken by the always-visible `❯`. Adding "esc to interrupt" helps during tool execution but Claude does not always show this text during thinking/reasoning phases. Between tool calls, the pane shows the `❯` prompt with no working indicator.
- Spinner characters are rendered via ANSI cursor movement that `capture-pane -p` does not preserve. The spinner is invisible in captured text.
- More regex patterns = more maintenance burden and more ways to break on Claude Code version updates.

**Verdict:** B adds fragile heuristics for a problem that hooks already solve definitively. It should only be used as a fallback when hooks are unavailable.

### Why C is best

C combines A's correct core fix (trust hooks) with B's best pane-level signal ("esc to interrupt") as a fallback, plus:
- Process liveness as an explicit gate (already exists, just clarifying the architecture)
- Additional hook events for diagnostic freshness
- `-J` flag for anti-flicker on capture
- "Working" default bias in the no-hook fallback path
- Minimal new regex (only "esc to interrupt", which is the single most reliable pane signal confirmed by dmux, oh-my-claudecode, claude-tmux, and primeline-ai)

The result: hooks handle 99% of cases correctly, "esc to interrupt" catches most of the remaining 1%, and the "working" default bias catches the rest.

---

## Implementation Plan

### Scope
- Packages touched: `v2/`
- Plugin slots affected: none (internal classification logic only)
- Breaking changes: no

### Affected Files

1. **`v2/src/session-service.ts`** -- Remove `HOOK_FRESHNESS_MS`. Change hook state consumption in `enrich()`. Add "esc to interrupt" check to `classifyLivePaneState`. Change default from "waiting" to "working" in the no-hook pane fallback.
2. **`v2/src/session-slots.ts`** -- Add `PreToolUse` and `PostToolUse` to `mapHookEventToState`.
3. **`v2/src/agents/claude.ts`** -- Add `PreToolUse` and `PostToolUse` hook entries.
4. **`v2/src/runtime-tmux.ts`** -- Add `-J` flag to `captureTmuxPane`.
5. **`v2/test/fast/session-service.test.ts`** -- Update tests for new classification logic.

### Step-by-Step Changes

#### Step 1: Remove HOOK_FRESHNESS_MS and simplify hook consumption in `enrich()`

**File:** `v2/src/session-service.ts`

Delete line 101:
```typescript
const HOOK_FRESHNESS_MS = 2_000;
```

Replace lines 2025-2040 (the hook state block in `enrich()`) with:
```typescript
      const hookState = readAgentHookState(this.config.dataDir, session.id);
      if (hookState) {
        // Hooks are authoritative. Trust the last hook event until the next one
        // overwrites it. Process liveness (checked above) is the crash guard.
        // Always overlay pane check for needs_input — hooks cannot signal it.
        const paneState = await classifyAgentState(session.agent, session.tmuxSession);
        state = paneState === "needs_input" ? "needs_input" : hookState.state;
      } else {
        // No hook state yet (first poll, hooks not installed). Full pane classification.
        state = await classifyAgentState(session.agent, session.tmuxSession);
      }
```

**Rationale:** Both "working" and "waiting" hook states are trusted until the next hook event. The pane is only checked for `needs_input` overlay. If no hook state exists, full pane classification runs as fallback.

**Note on pane check frequency:** When hook state is "working", we still call `classifyAgentState` on every poll to detect `needs_input`. This is intentional -- permission prompts can appear mid-turn and must be caught promptly. The pane capture cost is ~10ms per poll, which is acceptable at the 1-2s poll interval.

#### Step 2: Add "esc to interrupt" to Claude's pane classifier

**File:** `v2/src/session-service.ts`

Add constant near line 97:
```typescript
const WORKING_INDICATOR_RE = /esc to interrupt/i;
```

Change `classifyLivePaneState` (lines 245-252) to:
```typescript
function classifyLivePaneState(pane: string): SessionState {
  const lines = normalizePaneLines(pane);
  if (isWaitingInput(lines)) {
    return "needs_input";
  }
  // "esc to interrupt" is the most reliable working indicator for TUI agents.
  // Check the bottom portion of the pane — Claude shows it during tool execution.
  const tail = lines.slice(-20).join(" ");
  if (WORKING_INDICATOR_RE.test(tail)) {
    return "working";
  }
  const lastLine = lines.at(-1)?.trim() ?? "";
  return lastLine && PROMPT_RE.test(lastLine) ? "waiting" : "working";
}
```

**Rationale:** This is the single most reliable pane-level working signal, confirmed by every research source (dmux, oh-my-claudecode, claude-tmux, primeline-ai). It fires during tool execution. Between tool calls (pure thinking), the signal is absent and we fall through to the prompt check -- but this fallback path rarely executes because hooks handle it.

#### Step 3: Add PreToolUse/PostToolUse to hook events

**File:** `v2/src/session-slots.ts`

In `mapHookEventToState` (around line 220), add two cases:
```typescript
function mapHookEventToState(eventName) {
  if (!eventName) {
    return null;
  }
  const normalized = String(eventName).toLowerCase();
  if (normalized === "userpromptsubmit" || normalized === "pretooluse" || normalized === "posttooluse") {
    return "working";
  }
  if (normalized === "sessionstart" || normalized === "stop") {
    return "waiting";
  }
  return null;
}
```

**File:** `v2/src/agents/claude.ts`

In `ensureClaudeHookSettings` (line 107), add the new hook entries:
```typescript
export async function ensureClaudeHookSettings(sessionToolDir: string): Promise<string> {
  const settingsPath = join(sessionToolDir, CLAUDE_HOOK_SETTINGS_FILE);
  const hookEntry = { hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }] };
  const toolHookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }],
  };
  const hooksConfig = {
    hooks: {
      SessionStart: [hookEntry],
      UserPromptSubmit: [hookEntry],
      Stop: [hookEntry],
      PreToolUse: [toolHookEntry],
      PostToolUse: [toolHookEntry],
    },
  };
  await writeFile(settingsPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
  return settingsPath;
}
```

**Rationale:** PreToolUse/PostToolUse fire during tool execution, keeping the hook state file's timestamp fresh. This provides a heartbeat signal through multi-tool turns. The `matcher: "*"` matches all tool names.

**Hook blocking concern:** Claude Code hooks block until the command exits. The `spur-agent-state-updater.mjs` script does a single JSON parse + atomic file write and exits. Measured latency is <10ms. With PreToolUse firing before every tool, this adds <10ms per tool call -- negligible compared to tool execution time (100ms-30s).

#### Step 4: Add `-J` flag to captureTmuxPane

**File:** `v2/src/runtime-tmux.ts`

Change line 84:
```typescript
    return await tmux("capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`);
```

**Rationale:** `-J` joins wrapped lines, preventing terminal width from breaking line-based regex. Used by dmux. No known downsides.

#### Step 5: Update tests

**File:** `v2/test/fast/session-service.test.ts`

Tests to add/update:

1. **classifyLivePaneState with "esc to interrupt"**: verify that pane content containing "esc to interrupt" returns "working" even when `❯` is present.
2. **classifyLivePaneState default with `❯`**: verify that `❯` alone (no "esc to interrupt", no needs_input) returns "waiting" (this is the unchanged fallback -- `❯` still means waiting when there is no other signal).
3. **enrich() trusts hook "working" indefinitely**: mock a hook state with `state: "working"` and `updatedAt` from 60 seconds ago. Verify state is "working" (not falling through to pane).
4. **enrich() trusts hook "waiting" indefinitely**: unchanged behavior, verify.
5. **enrich() overlays needs_input on hook "working"**: mock hook state "working" + pane showing permission prompt. Verify state is "needs_input".
6. **enrich() falls through to pane when no hook state**: verify full pane classification runs when hook state file is absent.
7. **mapHookEventToState with PreToolUse/PostToolUse**: verify both return "working".

### Acceptance Criteria

- [ ] `HOOK_FRESHNESS_MS` constant is removed from `session-service.ts`
- [ ] `enrich()` trusts hook `"working"` state without any freshness check
- [ ] `enrich()` checks pane for `needs_input` when hook state is `"working"` (not just when `"waiting"`)
- [ ] `classifyLivePaneState` checks for `"esc to interrupt"` before falling through to prompt check
- [ ] `PreToolUse` and `PostToolUse` are registered in Claude hook settings with `matcher: "*"`
- [ ] `mapHookEventToState` maps `pretooluse` and `posttooluse` to `"working"`
- [ ] `captureTmuxPane` uses `-J` flag
- [ ] `pnpm --dir v2 build` passes
- [ ] `pnpm --dir v2 test` passes with updated tests
- [ ] `pnpm --dir v2 test:runtime` passes (if daemon/client touched — this change does not touch transport, so fast tier is sufficient unless runtime tests cover enrich)

### Risks

1. **PreToolUse/PostToolUse hook overhead.** Each hook invocation adds ~10ms latency before/after every tool call. For a turn with 50 tool calls, that is ~1s total overhead. This is acceptable but worth monitoring. **Mitigation:** The hook script is a fast Node.js write, and Claude Code tool calls themselves take 100ms-30s each.

2. **Pane capture on every poll even when hook state is present.** We now always call `classifyAgentState` when hook state exists, to check for `needs_input`. This was already the case for `"waiting"` hooks; now it also applies to `"working"` hooks. The cost is one `tmux capture-pane` call (~10ms) per poll per session. **Mitigation:** At typical poll intervals (1-2s) and session counts (<20), this is <200ms total, well within budget.

3. **`-J` flag changes line structure.** Joined wrapped lines could theoretically affect regex patterns that depend on line boundaries. **Mitigation:** All current regexes work on trimmed single lines or joined multi-line strings. The `-J` flag only joins lines that were split by terminal width, which is the correct semantic line.

4. **Stale "working" if Stop hook fails to fire.** If Claude Code crashes in a way that kills the process without firing `Stop`, the hook file says "working" but the process is dead. **Mitigation:** Step 1 in the waterfall checks `!processAlive` and returns "stopped" before hooks are checked. This is the existing behavior and is correct.

### Trade-offs

- **Trusting hooks indefinitely vs. freshness window:** Chose indefinite trust because the 2s freshness window is the direct cause of the bug, process liveness already guards against crashes, and hooks are the agent's own state declaration. The alternative (extending to e.g. 5 minutes) still fails for very long turns and adds arbitrary complexity.

- **Always checking pane for needs_input vs. skipping pane when hook is "working":** Chose always checking because `needs_input` can appear mid-turn (permission prompt during tool execution) and missing it has high user cost (agent blocked, user not notified). The alternative (skip pane when working) saves ~10ms per poll but risks missing permission prompts.

- **Adding PreToolUse/PostToolUse hooks vs. keeping minimal hook set:** Chose adding them because they provide a heartbeat through multi-tool turns at negligible cost (~10ms per tool call). The alternative (keep only 3 hooks) works but provides less diagnostic information and no freshness signal for future enhancements.

- **"esc to interrupt" as Claude pane signal vs. no pane improvement:** Chose adding it because it is a proven, stable signal (confirmed by 4+ open-source projects) and it improves the no-hook fallback path at the cost of one regex check. The alternative (rely entirely on hooks, no pane improvement) works for established sessions but leaves the cold-start / no-hook path broken.
