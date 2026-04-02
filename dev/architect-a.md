# Architect A: Hook-First Claude Code Status Detection

## Diagnosis

Claude Code always renders `❯` in its input area. After `HOOK_FRESHNESS_MS` (2s) expires, `enrich()` falls through to `classifyAgentState()` -> `classifyLivePaneState()`, which sees `❯` on the last line, matches `PROMPT_RE`, and returns `"waiting"`. A typical Claude turn runs 30s-5min, so the state is wrong for 95%+ of the turn.

The 2s freshness window was a safety net against a crashed agent appearing stuck as "working" forever. But the cure is worse than the disease: it makes status detection useless for the primary use case.

## Design: Trust Hook State, Refresh It During Turns

### Core Principle

Hook state is the primary signal for Claude. Trust it until the next hook event overwrites it. Use pane classification ONLY for `needs_input` detection. Use process liveness as the dead/alive gate.

### Three Changes

**Change 1: Remove freshness timeout on "working" hook state**

In `enrich()` (session-service.ts line 2025-2040), remove the `HOOK_FRESHNESS_MS` check. Both "working" and "waiting" hook states are trusted until overwritten by the next hook event. Both still check pane for `needs_input`.

**Change 2: Add PreToolUse and PostToolUse hooks to keep "working" state refreshed**

Register `PreToolUse` and `PostToolUse` hooks alongside the existing three. These fire on every tool call during a turn (Read, Write, Edit, Bash, Grep, Glob, etc.), keeping the `updatedAt` timestamp current. This provides two benefits:
- The hook state file's `updatedAt` serves as a heartbeat — if it stops updating for a long time while process is alive, something may be wrong
- Future tooling can use `hookEvent` field to show richer state (e.g., "editing files" vs "running bash")

The `mapHookEventToState` function in the inline updater script maps both `PreToolUse` and `PostToolUse` to `"working"` (agent is mid-turn, actively using tools).

**Change 3: Add a staleness safety net using process liveness + hook age**

Instead of the aggressive 2s freshness window, add a generous `HOOK_STALE_MS` (5 minutes). If the hook says "working" but hasn't been updated in 5 minutes AND the process is still alive, fall through to pane classification. This catches the edge case where hooks stop firing (agent hangs mid-turn without crashing). With PreToolUse/PostToolUse hooks firing on every tool call, a 5-minute gap without any hook update is a strong signal that something is wrong.

### What About Sessions Without Hooks?

When `readAgentHookState()` returns `null` (no hook state file exists), `enrich()` already falls through to full pane classification. This handles:
- Legacy sessions spawned before hooks were added
- Sessions where hook installation failed
- First poll before any hook has fired

No change needed here. The existing fallback path is correct.

### What About Agent Crashes Mid-Turn?

If Claude crashes mid-turn:
1. The hook state file says "working" with a stale `updatedAt`
2. `isProcessRunningInTmux()` returns false
3. `enrich()` hits the `!runtimeAlive || !processAlive` gate on line 2022 and returns `"stopped"` before ever reading hook state

Process liveness is checked BEFORE hook state in `enrich()`. This is already correct and handles crashes.

### What About StopFailure?

`StopFailure` fires when the API errors during response generation. Currently not hooked. It should map to "waiting" (agent returned to prompt after the error). Add it to the hook registration.

---

## Affected Files

### 1. `v2/src/session-service.ts`

**Remove** `HOOK_FRESHNESS_MS` constant (line 101).

**Add** `HOOK_STALE_MS = 300_000` constant (5 minutes).

**Rewrite** the hook-state branch in `enrich()` (lines 2025-2040):

```typescript
// --- BEFORE (lines 2025-2040) ---
const hookState = readAgentHookState(this.config.dataDir, session.id);
if (
  hookState?.state === "working" &&
  Date.now() - new Date(hookState.updatedAt).getTime() <= HOOK_FRESHNESS_MS
) {
  // Fresh UserPromptSubmit hook — definitively working.
  state = "working";
} else if (hookState?.state === "waiting") {
  // Stop/SessionStart hook fired — trust it, but still check pane for needs_input
  // since that requires terminal interaction the agent can't signal via hooks.
  const paneState = await classifyAgentState(session.agent, session.tmuxSession);
  state = paneState === "needs_input" ? "needs_input" : "waiting";
} else {
  // No hook state (hooks not installed or stale working) — full pane classification.
  state = await classifyAgentState(session.agent, session.tmuxSession);
}

// --- AFTER ---
const hookState = readAgentHookState(this.config.dataDir, session.id);
const hookAgeMs = hookState
  ? Date.now() - new Date(hookState.updatedAt).getTime()
  : Infinity;

if (hookState && hookAgeMs <= HOOK_STALE_MS) {
  // Hook state exists and is not stale — trust it as primary signal.
  // Always check pane for needs_input since hooks cannot signal permission prompts.
  const paneState = await classifyAgentState(session.agent, session.tmuxSession);
  state = paneState === "needs_input" ? "needs_input" : hookState.state;
} else {
  // No hook state, or hook is stale (>5min without update) — full pane classification.
  state = await classifyAgentState(session.agent, session.tmuxSession);
}
```

Key differences:
- "working" hook is trusted until overwritten or stale (5min), not just 2s
- Both "working" and "waiting" go through the same path: trust hook, overlay `needs_input` from pane
- Stale threshold is generous (5min) because PreToolUse/PostToolUse keep it refreshed during active turns

**Note on pane capture cost**: The previous code skipped pane capture entirely for fresh "working" hooks. The new code always runs pane capture to check for `needs_input`. This is intentional — `needs_input` (permission prompts) requires immediate human attention and must not be masked. The pane capture cost is one `tmux capture-pane` subprocess (~10ms) per poll, which is negligible.

### 2. `v2/src/agents/claude.ts`

**Add** `PreToolUse`, `PostToolUse`, and `StopFailure` to the hook registration in `ensureClaudeHookSettings()` (line 107-118):

```typescript
// --- BEFORE (line 109-115) ---
const hookEntry = { hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }] };
const hooksConfig = {
  hooks: {
    SessionStart: [hookEntry],
    UserPromptSubmit: [hookEntry],
    Stop: [hookEntry],
  },
};

// --- AFTER ---
const hookEntry = { hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }] };
const hooksConfig = {
  hooks: {
    SessionStart: [hookEntry],
    UserPromptSubmit: [hookEntry],
    PreToolUse: [hookEntry],
    PostToolUse: [hookEntry],
    Stop: [hookEntry],
    StopFailure: [hookEntry],
  },
};
```

### 3. `v2/src/session-slots.ts` (inline updater script)

**Update** `mapHookEventToState()` in the inline `spur-agent-state-updater.mjs` script (lines 220-232) to handle the new events:

```javascript
// --- BEFORE ---
function mapHookEventToState(eventName) {
  if (!eventName) {
    return null;
  }
  const normalized = String(eventName).toLowerCase();
  if (normalized === "userpromptsubmit") {
    return "working";
  }
  if (normalized === "sessionstart" || normalized === "stop") {
    return "waiting";
  }
  return null;
}

// --- AFTER ---
function mapHookEventToState(eventName) {
  if (!eventName) {
    return null;
  }
  const normalized = String(eventName).toLowerCase();
  if (
    normalized === "userpromptsubmit" ||
    normalized === "pretooluse" ||
    normalized === "posttooluse"
  ) {
    return "working";
  }
  if (
    normalized === "sessionstart" ||
    normalized === "stop" ||
    normalized === "stopfailure"
  ) {
    return "waiting";
  }
  return null;
}
```

### 4. `v2/src/agents/codex.ts`

**Add** the same hooks for Codex parity. Update the `CodexHooksDocument` interface and `parseCodexHooksDocument()` to include `PreToolUse`, `PostToolUse`, and `StopFailure`:

In the `CodexHooksDocument` interface (line 57-63):
```typescript
interface CodexHooksDocument {
  hooks: {
    SessionStart: HookMatcherGroup[];
    UserPromptSubmit: HookMatcherGroup[];
    PreToolUse: HookMatcherGroup[];
    PostToolUse: HookMatcherGroup[];
    Stop: HookMatcherGroup[];
    StopFailure: HookMatcherGroup[];
  };
}
```

In `parseCodexHooksDocument()` (lines 146-153):
```typescript
return {
  hooks: {
    SessionStart: ensureHookEventGroup(parseHookGroups(hooksRecord["SessionStart"])),
    UserPromptSubmit: ensureHookEventGroup(parseHookGroups(hooksRecord["UserPromptSubmit"])),
    PreToolUse: ensureHookEventGroup(parseHookGroups(hooksRecord["PreToolUse"])),
    PostToolUse: ensureHookEventGroup(parseHookGroups(hooksRecord["PostToolUse"])),
    Stop: ensureHookEventGroup(parseHookGroups(hooksRecord["Stop"])),
    StopFailure: ensureHookEventGroup(parseHookGroups(hooksRecord["StopFailure"])),
  },
};
```

### 5. `v2/test/fast/session-service.test.ts`

**Update existing tests**:

- "skips pane capture when hook working state is fresh and uses pane otherwise" (line 718): This test asserts `captureTmuxPaneMock` is NOT called when hook is fresh. Under the new design, pane capture is always called (for `needs_input` check). Update to assert pane capture IS called but the state is still "working".

- "falls back to pane classification when hook working state is older than 2s" (line 747): Rename and update. A 3s-old hook is no longer stale. Change to test that a 6-minute-old hook falls back to pane classification.

- "trusts hook waiting state — returns waiting even if pane looks like working" (line 804): Keep as-is, behavior unchanged.

**Add new tests**:

- Hook "working" trusted after 2 minutes (not stale): hookState `{ state: "working", updatedAt: 2min ago }`, pane shows `❯`. Assert state is "working" (not "waiting").

- Hook "working" with `needs_input` pane overlay: hookState `{ state: "working" }`, pane shows permission prompt. Assert state is "needs_input".

- Hook "waiting" with `needs_input` pane overlay: hookState `{ state: "waiting" }`, pane shows interview UI. Assert state is "needs_input".

- Hook stale at 5min boundary: hookState `{ state: "working", updatedAt: 5min+1s ago }`. Assert falls through to pane classification.

- No hook state: `readAgentHookStateMock.mockReturnValue(null)`. Assert full pane classification runs.

### 6. `v2/TEST_SCENARIOS.md`

Update the existing scenario (line 55):

```
- Session state classification trusts hook state as primary signal for both "working" and "waiting"
  until overwritten or stale (5min), overlays needs_input from pane capture, and falls through to
  full pane classification only when no hook state exists or hook is stale.
```

---

## Interaction With Existing Debounce

The `STATE_HOLD_MS` (4s) debounce in `enrich()` (lines 2043-2055) remains unchanged. It still suppresses transient flicker between `working` and `waiting`. With this fix, the debounce is less critical because hook state no longer flips to pane-derived "waiting" after 2s, but it still protects against the edge case where a `Stop` hook fires and the next `UserPromptSubmit` follows 1-2s later (user sends a follow-up).

---

## Hook Execution Performance

Claude Code hooks block the agent until the hook command exits. The inline `spur-agent-state-updater.mjs` script is a ~40-line Node.js script that:
1. Reads stdin (JSON payload)
2. Maps event name to state
3. Writes a small JSON file via tmp+rename

This completes in <50ms. With PreToolUse and PostToolUse added, this runs on every tool call. A heavy Claude turn might make 50-100 tool calls. At 50ms each, that is 2.5-5s of overhead spread across a multi-minute turn. This is acceptable.

If performance becomes a concern, the hook command can be made `async: true` (fire-and-forget, non-blocking). Claude Code supports this for command-type hooks. However, async hooks have a risk: if the write hasn't completed when `enrich()` reads the file, the state could be one tool call behind. This is fine for status detection but worth noting.

**Recommendation**: Do NOT use `async: true` initially. The synchronous overhead is small and deterministic. Add `async: true` only if profiling shows measurable impact on agent turn latency.

---

## Trade-offs

### Chose: Trust hook indefinitely (with 5min stale gate) over 2s freshness window
- **Alternative**: Keep freshness window but extend to 30s
- **Why not**: 30s still misses most of a typical turn. The freshness concept is wrong for "working" — a hook saying "I started working" remains true until contradicted by "I stopped working". The 5min stale gate is purely a safety net for the pathological case where hooks stop firing entirely.

### Chose: Always run pane capture (for needs_input) over skipping it for "working" hook
- **Alternative**: Skip pane capture when hook says "working" (current behavior for fresh hooks)
- **Why not**: Permission prompts require immediate human attention. A 10ms tmux capture per poll is a small price for never missing a `needs_input` state. The previous optimization saved ~10ms per poll but created a blind spot for permission prompts during the fresh window.

### Chose: Add PreToolUse/PostToolUse hooks over relying solely on UserPromptSubmit
- **Alternative**: Just remove the freshness check, trust UserPromptSubmit forever
- **Why not**: PreToolUse/PostToolUse provide a heartbeat that keeps `updatedAt` current. This makes the 5min stale gate meaningful — if no hook fires in 5min and the agent is supposedly "working", something is genuinely wrong. Without these hooks, the 5min gate would fire on every long-running turn where the agent thinks for >5min between tool calls (rare but possible).

### Chose: 5 minutes for HOOK_STALE_MS over shorter (1min) or no timeout
- **Alternative A**: No timeout — trust "working" forever until Stop fires
- **Why not**: If hooks break silently (settings file overwritten, hook script deleted), the state would be permanently stuck as "working" even though the agent is idle. Process liveness catches crashes but not a working-but-idle agent.
- **Alternative B**: 1 minute timeout
- **Why not**: Claude can think for 60+ seconds between tool calls on complex tasks. A 1min timeout would cause false fallthrough during legitimate deep reasoning. 5min is well above the longest observed inter-tool-call gap.

### Chose: Synchronous hooks over async: true
- **Alternative**: Use `async: true` to avoid blocking the agent
- **Why not**: Synchronous execution guarantees the state file is written before the tool runs. Async introduces a race between the write and the next `enrich()` poll. The overhead (<50ms per tool call) is negligible relative to tool execution time.

---

## Risks

1. **Hook script overhead on tool-heavy turns**: 50-100 tool calls at ~50ms each = 2.5-5s cumulative overhead. Mitigated by: the overhead is spread across minutes, and each individual delay is imperceptible.

2. **Stale "working" for 5 minutes if hooks break silently**: If the hook config is corrupted after spawn but before the agent finishes, the state shows "working" for up to 5 minutes after the agent goes idle. Mitigated by: this is a rare failure mode, and 5 minutes is bounded. The previous behavior showed "waiting" 95% of the time, which is far worse.

3. **Pane capture on every poll (no skip optimization)**: Adds ~10ms per poll per session. At 1s poll interval and 20 sessions, that is 200ms per second of subprocess overhead. Mitigated by: tmux capture-pane is fast and the overhead is well within acceptable bounds.

4. **Existing sessions need respawn to get new hooks**: Sessions spawned before this change only have SessionStart/UserPromptSubmit/Stop hooks. They will still work (the 5min stale gate handles the gap), but their "working" detection relies on UserPromptSubmit alone without the PreToolUse/PostToolUse heartbeat. Mitigated by: the core fix (removing 2s freshness) helps these sessions too — their UserPromptSubmit hook will be trusted for up to 5min instead of 2s.

---

## Steps

1. Update `mapHookEventToState` in the inline script in `v2/src/session-slots.ts` to map `pretooluse`/`posttooluse` -> `"working"` and `stopfailure` -> `"waiting"`.
2. Update `ensureClaudeHookSettings` in `v2/src/agents/claude.ts` to register `PreToolUse`, `PostToolUse`, and `StopFailure` hooks.
3. Update `CodexHooksDocument` and `parseCodexHooksDocument` in `v2/src/agents/codex.ts` to register the same hooks for Codex.
4. In `v2/src/session-service.ts`: remove `HOOK_FRESHNESS_MS`, add `HOOK_STALE_MS = 300_000`, rewrite the hook-state branch in `enrich()` to trust hook state (both working and waiting) with pane `needs_input` overlay, falling through to full pane classification only when no hook state or stale.
5. Update tests in `v2/test/fast/session-service.test.ts`: fix existing hook-freshness tests, add new tests for trusted working, needs_input overlay, stale boundary, and no-hook fallback.
6. Update `v2/TEST_SCENARIOS.md` with the revised scenario description.
7. Run `pnpm --dir v2 build` and `pnpm --dir v2 test`.

## Acceptance Criteria

- [ ] `spur list` shows "working" for a Claude session that has been actively processing for >2s
- [ ] `spur list` shows "waiting" for a Claude session where the Stop hook has fired
- [ ] `spur list` shows "needs_input" when a permission prompt is visible, regardless of hook state
- [ ] Hook state older than 5 minutes falls through to pane classification
- [ ] Sessions without hook state files fall through to full pane classification
- [ ] Claude hook settings include PreToolUse, PostToolUse, and StopFailure
- [ ] Codex hook settings include PreToolUse, PostToolUse, and StopFailure
- [ ] `mapHookEventToState` maps pretooluse/posttooluse to "working" and stopfailure to "waiting"
- [ ] All existing fast tests pass (updated as needed)
- [ ] `pnpm --dir v2 build` succeeds
