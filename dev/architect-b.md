# Architect B: Title + Pane Signals for Claude Code Status Detection

## Diagnosis

Claude Code always renders `❯` in its TUI input field. After `HOOK_FRESHNESS_MS` (2s) expires, `classifyLivePaneState` sees `❯` as the last non-UI-chrome line, matches `PROMPT_RE`, and returns `"waiting"` -- even when the agent is actively working. The 2s freshness window on the `UserPromptSubmit` hook covers only a fraction of a typical 30s-5min agent turn.

The root cause is twofold:
1. `HOOK_FRESHNESS_MS = 2_000` is far too short -- it forces fallback to pane classification almost immediately.
2. `classifyLivePaneState` has zero Claude-specific working signals. It only checks `PROMPT_RE` and `isWaitingInput`, so any pane with `❯` at the bottom is classified as `"waiting"`.

## Design: Three-Layer Claude Detection

Layer 1 (cheapest): **Terminal title** -- Claude Code sets `✻ [Claude Code] <name> (<id>) ⧉` via OSC 0. The spinner char (`✻`, `✳`, `✽`, `✶`, `✢`, `·`) rotates at 960ms when working. When idle, the title may still be present but the spinner freezes on the idle char `✳` or the title may not contain a spinner at all.

Layer 2 (pane content): **"esc to interrupt" as universal working signal** -- Research confirms that both dmux (1,323 stars) and oh-my-claudecode (21,613 stars) use this as their primary working signal. Claude Code renders "esc to interrupt" in the status bar area only while processing.

Layer 3 (pane content): **Spinner chars in content area** -- Claude Code renders `✻ Thinking...` and similar spinner-prefixed lines above the input field while working. These are capturable via `tmux capture-pane`.

Layer 4 (existing): **`❯` prompt** -- demoted to weakest signal by stripping it as UI chrome, so it never triggers `PROMPT_RE`.

### Priority waterfall for Claude (in `classifyAgentState`)

```
1. Hook state (existing, but remove freshness gate on "working")
   - hookState.working → check pane for needs_input only, else "working"
   - hookState.waiting → check pane for needs_input only, else "waiting"
2. Terminal title (NEW)
   - title contains "[Claude Code]" + spinner char from cycle → "working"
   - title contains "[Claude Code]" without spinner → "waiting"
   - title empty/missing → fall through
3. Pane content (ENHANCED)
   - isWaitingInput → "needs_input"
   - /esc to interrupt/i anywhere in pane → "working"
   - spinner char + progress word in last 15 lines → "working"
   - (❯ stripped as chrome, so last line is content above it)
   - last line matches PROMPT_RE → "waiting"
   - else → "working" (safe default: bias toward working)
```

### Why not just extend hook trust window?

Extending `HOOK_FRESHNESS_MS` to infinity (Research-10 Option B) is the simplest fix but creates a stuck-working failure mode: if the `Stop` hook fails to fire (crash, hook misconfiguration, `StopFailure`), the session stays `"working"` indefinitely with no pane-based correction. Adding pane signals means the system self-corrects within one poll cycle even when hooks fail.

### Why not remove the freshness gate entirely?

Removing the freshness gate makes hooks the sole authority. If hooks malfunction, pane classification never runs. Title + pane signals provide a redundant detection path that catches hook failures within seconds.

### What about `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`?

If the user has set this env var, `getTmuxPaneTitle` returns the default pane title (usually `bash` or the shell name) -- it will not contain `[Claude Code]`. The classifier returns `null` and falls through to pane content signals. This is the correct degradation path.

### What about `❯` being hidden during tool execution?

When `shouldHidePromptInput` is true in Claude Code's TUI, the `❯` line is not rendered. After stripping `❯` as chrome, the last visible line will be tool output, which will not match `PROMPT_RE` -- correctly classified as `"working"`. When `❯` reappears (tool done, agent idle), it gets stripped, and the line above it (the last agent output) becomes the last line. If the agent is truly idle, the `Stop` hook will have fired, and we trust that. If hooks are broken, "esc to interrupt" absence + no spinner = last line check, which may be content text (not a prompt char) = `"working"` (safe default).

## Scope

- **Packages touched**: `v2/` only
- **Plugin slots affected**: none (all changes are in session-service classification)
- **Breaking changes**: no

## Affected Files

### `v2/src/session-service.ts`

**Constants to add** (after line 97):

```typescript
// Claude Code spinner chars used in terminal title and content area.
// Cycle: ["·", "✢", "✳", "✶", "✻", "✽"] at 960ms intervals.
const CLAUDE_TITLE_RE = /\[Claude Code\]/;
const CLAUDE_TITLE_SPINNER_RE = /^[·✢✳✶✻✽]/;

// Universal working signal: Claude Code shows this in the status area only while processing.
const ESC_TO_INTERRUPT_RE = /esc to interrupt/i;

// Claude Code spinner + progress word in content area (last 15 lines).
// Matches lines like "✻ Thinking…", "· Reading file.ts", "✽ Editing src/foo.ts"
const CLAUDE_CONTENT_SPINNER_RE = /^[·✢✳✶✻✽]\s+\S/;
```

**TRAILING_UI_RE to extend** (line 91-97):

Add `❯` prompt line as Claude UI chrome:

```typescript
const TRAILING_UI_RE = [
  /^[─━]+$/,
  /^⏵⏵ /,
  /^Claude in Chrome enabled\b/,
  /^Update available!\b/,
  /^gpt-[\w.-]+\b.*·/,
  /^❯(?:\s.*)?$/,  // Claude Code persistent input field
];
```

**New function: `classifyClaudeTitle`** (after `classifyCodexTitle`, ~line 267):

```typescript
export function classifyClaudeTitle(title: string): SessionState | null {
  if (!CLAUDE_TITLE_RE.test(title)) return null;
  // Title format: "✻ [Claude Code] session-name (id-prefix) ⧉"
  // Spinner char at position 0 rotates while working.
  return CLAUDE_TITLE_SPINNER_RE.test(title) ? "working" : "waiting";
}
```

Wait -- this is wrong. The title *always* has a spinner char prefix (`✻` is the default/idle one too). Research-6 says the spinner cycles through `["·", "✢", "✳", "✶", "✻", "✽"]` at 960ms. The idle/default char is `✳`. But the title persists with whatever spinner char was showing when the agent went idle. We cannot reliably distinguish "frozen spinner = idle" from "spinner mid-cycle = working" from a single point-in-time snapshot.

**Revised approach for title**: The title is not a reliable working/idle discriminator for Claude Code (unlike Codex which puts explicit status words in the title). Use it only as a **liveness signal**: if `[Claude Code]` appears in the title, the agent is alive and in-session. Skip title-based state classification for Claude; go straight to pane content.

Actually, on further thought: we can still use the title as a positive signal. The title is set on session start and cleared on exit. If the title contains `[Claude Code]`, we know the agent is alive and in-session. But for working vs. waiting, we need pane content.

**Revised function: `classifyClaudeTitle`** -- dropped from the plan. Title detection for Claude is not reliable for state. Instead, focus on pane content signals.

**New function: `classifyClaudePane`** (after `classifyCodexPane`, ~line 281):

```typescript
function classifyClaudePane(pane: string): SessionState {
  const lines = normalizePaneLines(pane);
  if (isWaitingInput(lines)) return "needs_input";

  // "esc to interrupt" is the strongest working signal -- Claude Code shows it
  // in the bottom status area only while processing. Check on raw pane to catch
  // it even if normalizePaneLines stripped the line.
  if (ESC_TO_INTERRUPT_RE.test(pane)) return "working";

  // Spinner-prefixed progress lines in the content area above the input field.
  const tail = lines.slice(-15);
  if (tail.some((line) => CLAUDE_CONTENT_SPINNER_RE.test(line.trim()))) return "working";

  // After stripping ❯ as UI chrome, if the last line is a prompt char, the agent is idle.
  const lastLine = lines.at(-1)?.trim() ?? "";
  return lastLine && PROMPT_RE.test(lastLine) ? "waiting" : "working";
}
```

**Update `classifyAgentState`** (line 283-293):

```typescript
async function classifyAgentState(agent: string, tmuxSession: string): Promise<SessionState> {
  if (agent === "codex") {
    const title = await getTmuxPaneTitle(tmuxSession);
    const titleState = classifyCodexTitle(title);
    if (titleState !== null) return titleState;
    const pane = await captureTmuxPane(tmuxSession, 80);
    return classifyCodexPane(pane);
  }
  // Claude: pane-based classification with "esc to interrupt" and spinner detection.
  const pane = await captureTmuxPane(tmuxSession, 80);
  return classifyClaudePane(pane);
}
```

**Update `enrich` hook logic** (lines 2025-2040):

Remove the `HOOK_FRESHNESS_MS` gate on `"working"`. Trust hook state (both working and waiting) until the next hook event overwrites it. Still check pane for `needs_input` in both cases.

```typescript
const hookState = readAgentHookState(this.config.dataDir, session.id);
if (hookState) {
  // Hook state exists — check pane only for needs_input overlay.
  const paneState = await classifyAgentState(session.agent, session.tmuxSession);
  state = paneState === "needs_input" ? "needs_input" : hookState.state;
} else {
  // No hook state — full pane classification.
  state = await classifyAgentState(session.agent, session.tmuxSession);
}
```

Wait -- this removes the performance optimization of skipping pane capture when hooks say "working". Let me reconsider.

The original code skipped pane capture entirely when hooks said "working" and were fresh. The purpose was performance: avoid a `tmux capture-pane` round-trip. But we also need `needs_input` detection, which only comes from pane content.

**Revised `enrich` hook logic**:

```typescript
const hookState = readAgentHookState(this.config.dataDir, session.id);
if (hookState) {
  // Hook state exists — trust it for working/waiting, but always check pane
  // for needs_input since hooks cannot signal permission prompts.
  const paneState = await classifyAgentState(session.agent, session.tmuxSession);
  state = paneState === "needs_input" ? "needs_input" : hookState.state;
} else {
  // No hook state (hooks not installed or first poll) — full pane classification.
  state = await classifyAgentState(session.agent, session.tmuxSession);
}
```

This always runs pane capture, which costs ~10ms. At 1-2s poll intervals this is negligible. The benefit: `needs_input` is always detected regardless of hook state.

### `v2/src/runtime-tmux.ts`

**Add `-J` flag to `captureTmuxPane`** (line 84):

```typescript
return await tmux("capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`);
```

The `-J` flag joins wrapped lines, preventing terminal width changes from breaking line-based pattern matching. Both dmux and the research confirm this is a valuable anti-flicker improvement.

### `v2/test/fast/session-service.test.ts`

**Tests to update**:

1. **"skips pane capture when hook working state is within 2s"** (line 639) -- update: pane capture now always runs when hooks are present, but hook state overrides the pane result for working/waiting.

2. **"falls back to pane classification when hook working state is older than 2s"** (line 747) -- update: no longer relevant; hook state is trusted regardless of age.

3. **"skips pane capture when hook working state is fresh and uses pane otherwise"** (line 718) -- update: same as above.

4. **"classifies waiting state from prompt pane"** (line 614) -- this test uses `agent: "claude"` with pane `"Claude Code\n❯"`. With the new code, `❯` is stripped as chrome, leaving `"Claude Code"` as last line, which doesn't match PROMPT_RE. Without hooks, `classifyClaudePane` returns `"working"` (no "esc to interrupt", no spinner, last line not a prompt → working as safe default). **But this test expects "waiting".**

   This reveals a design tension: when Claude is truly idle with no hooks, the pane shows content text + `❯`. After stripping `❯`, the content text doesn't match PROMPT_RE, so we get `"working"` (false). We need another signal for "truly idle" without hooks.

   **Resolution**: When hooks are absent AND the pane has no working signals, fall back to checking if `❯` was present in the raw pane (before stripping). If `❯` was present AND no working signals found, classify as `"waiting"`. This preserves the old behavior for the no-hook case while preventing `❯` from overriding working signals.

   **Revised `classifyClaudePane`**:

```typescript
function classifyClaudePane(pane: string): SessionState {
  const lines = normalizePaneLines(pane);
  if (isWaitingInput(lines)) return "needs_input";

  // "esc to interrupt" = strongest working signal.
  if (ESC_TO_INTERRUPT_RE.test(pane)) return "working";

  // Spinner-prefixed progress lines in content area.
  const tail = lines.slice(-15);
  if (tail.some((line) => CLAUDE_CONTENT_SPINNER_RE.test(line.trim()))) return "working";

  // No working signals found. If the raw pane contained the ❯ input field,
  // the agent is likely idle (❯ was stripped as chrome but its presence means
  // the TUI is rendered and no working indicators are active).
  if (/^❯(?:\s.*)?$/m.test(pane)) return "waiting";

  // No ❯ and no working signals — agent may be in a transitional render.
  // Bias toward working (safe default).
  return "working";
}
```

This is the key insight: `❯` in the raw pane is the *weakest* idle signal. It only applies when all working signals are absent. The `TRAILING_UI_RE` stripping prevents it from being the `PROMPT_RE` match (which was the original bug), but we still use its raw-pane presence as a last-resort idle indicator.

**New tests to add**:

5. **"classifies Claude as working when 'esc to interrupt' is present despite ❯"**:
   ```
   pane: "✻ Editing src/foo.ts (esc to interrupt)\n❯"
   expected: "working"
   ```

6. **"classifies Claude as working when spinner progress line is present"**:
   ```
   pane: "Some output\n✻ Thinking…\n❯"
   expected: "working"
   ```

7. **"classifies Claude as waiting when ❯ present and no working signals"**:
   ```
   pane: "Claude Code\n❯"
   expected: "waiting"  (same as existing test, behavior preserved)
   ```

8. **"Claude hook working state trusted without freshness limit"**:
   ```
   hookState: { state: "working", updatedAt: 30s ago }
   pane: "❯"  (would classify as waiting from pane alone)
   expected: "working"
   ```

9. **"Claude hook working overridden by needs_input from pane"**:
   ```
   hookState: { state: "working", updatedAt: 1s ago }
   pane: "approval required\n(Y)es / (N)o"
   expected: "needs_input"
   ```

10. **"classifies Claude as working (safe default) when no ❯ and no signals"**:
    ```
    pane: "some random output\nwithout prompt char"
    expected: "working"
    ```

### `v2/TEST_SCENARIOS.md`

Add to the fast tier:

```
- Claude pane classification: `classifyClaudePane` returns "working" when "esc to interrupt" is present in the pane, returns "working" when spinner-prefixed progress lines appear in content, returns "waiting" when ❯ is present with no working signals, returns "working" as safe default when neither working signals nor ❯ are present.
- Claude hook trust: hook working state is trusted regardless of age until a new hook overwrites it; pane needs_input overrides hook working state.
- Claude UI chrome: TRAILING_UI_RE strips ❯ prompt line so it does not trigger PROMPT_RE in classifyLivePaneState.
```

## Steps

1. **Add Claude pane constants** to `session-service.ts` (lines 91-114 region): `ESC_TO_INTERRUPT_RE`, `CLAUDE_CONTENT_SPINNER_RE`. Add `❯` pattern to `TRAILING_UI_RE`. -- Expected outcome: new regex constants available, `❯` stripped from normalized lines.

2. **Add `classifyClaudePane` function** after `classifyCodexPane` (~line 281). -- Expected outcome: Claude-specific pane classifier that checks "esc to interrupt", spinner lines, raw `❯` presence, with safe-default fallback.

3. **Update `classifyAgentState`** to route Claude through `classifyClaudePane` instead of `classifyLivePaneState`. -- Expected outcome: Claude sessions use the dedicated classifier.

4. **Update `enrich` hook logic** (lines 2025-2040): remove `HOOK_FRESHNESS_MS` gate, trust hook state for both working and waiting, always run pane capture for `needs_input` overlay. -- Expected outcome: hook working state persists until next hook event; `needs_input` always detected.

5. **Add `-J` flag to `captureTmuxPane`** in `runtime-tmux.ts` (line 84). -- Expected outcome: line-wrapped content is joined, preventing false pattern breaks.

6. **Delete `HOOK_FRESHNESS_MS` constant** (line 101) -- it is no longer used. -- Expected outcome: no dead code.

7. **Update existing tests** in `session-service.test.ts` that assert on hook freshness behavior. -- Expected outcome: tests pass with new hook-trust-indefinitely logic.

8. **Add new tests** for `classifyClaudePane` scenarios (items 5-10 from the test list above). -- Expected outcome: full coverage of Claude working signal detection.

9. **Update `TEST_SCENARIOS.md`** with new fast-tier scenarios. -- Expected outcome: scenario file stays in sync with code.

10. **Run `pnpm --dir v2 build`** to verify compilation. -- Expected outcome: clean build.

11. **Run `pnpm --dir v2 test`** to verify all fast tests pass. -- Expected outcome: green.

12. **Run `pnpm --dir v2 test:runtime`** since the change touches pane classification and the `-J` flag in runtime-tmux. -- Expected outcome: green.

## Acceptance Criteria

- [ ] `spur list` shows Claude sessions as `"working"` when the agent is actively processing (has "esc to interrupt" in pane or spinner lines visible).
- [ ] `spur list` shows Claude sessions as `"waiting"` when the agent is idle at the `❯` prompt with no working signals.
- [ ] Hook `"working"` state is trusted until a `"waiting"` hook (Stop/SessionStart) overwrites it, with no 2s timeout.
- [ ] `needs_input` from pane always overrides hook state (both working and waiting).
- [ ] `❯` in `TRAILING_UI_RE` prevents it from matching `PROMPT_RE` in `classifyLivePaneState` (the generic fallback still used for non-claude agents).
- [ ] `classifyClaudePane` returns `"working"` as safe default when no signals are present (bias toward working, not waiting).
- [ ] `-J` flag on `capture-pane` prevents line-wrap flicker.
- [ ] `pnpm --dir v2 build` succeeds.
- [ ] `pnpm --dir v2 test` succeeds.
- [ ] `pnpm --dir v2 test:runtime` succeeds.
- [ ] Existing Codex classification behavior is unchanged.

## Risks

- **"esc to interrupt" changes in a future Claude Code version** -- Mitigation: this string is used by every major Claude Code monitor (dmux, oh-my-claudecode, claude-tmux) and is a stable part of the TUI. If it changes, all monitors break, making it likely to stay stable. The spinner detection serves as a secondary signal.

- **`-J` flag changes line offsets in existing tests** -- Mitigation: `-J` joins wrapped lines that were previously split. Most test fixtures use short lines that don't wrap. Any test that relies on a specific line count should be updated.

- **Removing `HOOK_FRESHNESS_MS` creates stuck-working if Stop hook fails** -- Mitigation: `classifyAgentState` still runs on every poll. If the agent actually finishes and the pane shows no working signals (no "esc to interrupt", no spinner), the pane classifier returns `"waiting"`. The only scenario where this matters is if the pane shows stale working content AND the Stop hook failed -- but in that case, the agent likely crashed, and the process-alive check will eventually catch it.

- **`CLAUDE_CONTENT_SPINNER_RE` false-matches content that starts with a spinner char** -- Mitigation: the regex requires a spinner char at position 0 followed by whitespace and a non-whitespace char. User content starting with `✻ ` is rare. Even if it false-matches, the result is `"working"` which is the safe-side error.

## Trade-offs

- **Hook trust indefinite vs. freshness window**: chose indefinite trust over 2s freshness because the 2s window was the direct cause of the bug. Hooks fire on actual state transitions (UserPromptSubmit, Stop) which are authoritative. The risk of stuck-working from a missed Stop hook is mitigated by pane signals and process-alive checks. Alternative was extending to 5min -- rejected because it's an arbitrary number that still fails for longer tasks.

- **Always run pane capture vs. skip when hooks say working**: chose always-run because `needs_input` detection requires pane content and hooks cannot signal it. The ~10ms cost per poll is negligible. Alternative was keeping the skip optimization and only running pane when hooks say waiting -- rejected because it misses `needs_input` during working state.

- **`❯` as UI chrome in TRAILING_UI_RE vs. agent-specific stripping**: chose TRAILING_UI_RE because it's the simplest integration point and `❯` is genuinely UI chrome (it's Claude Code's persistent input field, not a state indicator). The `classifyClaudePane` function still checks raw pane for `❯` presence as a last-resort idle signal. Alternative was a separate Claude-specific normalization function -- rejected as unnecessary complexity.

- **Dropping terminal title detection for Claude vs. keeping it**: chose to drop because Claude Code's title spinner char cannot distinguish working from idle in a single snapshot (the char freezes at whatever frame was current when the agent stopped). Codex puts explicit status words ("Ready", "Thinking") which are unambiguous. Alternative was tracking title changes across polls to detect spinner animation -- rejected as over-engineering for a secondary signal.
