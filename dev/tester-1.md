# Tester Report: Consensus Plan (Architect C) — Status Detection

## Current State

- `pnpm --dir v2 build`: OK
- `pnpm --dir v2 test`: OK (172/172 pass)

---

## Finding 1: "esc to interrupt" does NOT appear in Claude Code pane captures

**Severity: DESIGN HOLE — the pane fallback for Claude is still broken**

Architect C proposes adding an "esc to interrupt" check to `classifyLivePaneState` as a fallback for Claude when hooks are absent. Research-10 (the project's own analysis) explicitly states:

> **F2: Claude working state has no pane-level signal**
> Unlike Codex (which shows "esc to interrupt" and has title-based status), Claude Code provides no reliable pane-level indicator of working state. There is no spinner character in the pane, no "thinking" status line, no "esc to interrupt" equivalent.
> Claude Code's visual working indicator is a spinner/animation in the TUI, but it is rendered using cursor movement and ANSI escape sequences that `tmux capture-pane -p` does not preserve.

And Architect C itself acknowledges this on line 104:

> Claude does not always show this text during thinking/reasoning phases. Between tool calls, the pane shows the `❯` prompt with no working indicator.

The "esc to interrupt" check is relevant for **Codex** (already implemented as `CODEX_PANE_WORKING_RE`), not for Claude Code. Adding it to `classifyLivePaneState` is harmless but will not fire for Claude pane captures. The no-hook fallback path for Claude remains broken: it will still see `❯` and return "waiting" when the agent is working between tool calls.

**Impact**: Low, because the plan's core fix (trusting hooks indefinitely) means this fallback path only runs before the first hook fires. But the plan should not claim "esc to interrupt" improves Claude's pane classification — it does not.

**Recommendation**: Document that the pane fallback for Claude is inherently unreliable and the hook fix is the only real solution. Do not add WORKING_INDICATOR_RE to `classifyLivePaneState` for Claude — it creates false confidence. The existing `classifyLivePaneState` returning "waiting" from `❯` is wrong, but so is claiming "esc to interrupt" fixes it. If you want defense-in-depth for the first-poll window, bias toward "working" as the default when agent is "claude" and no hooks exist yet.

---

## Finding 2: Removing HOOK_FRESHNESS_MS is safe — with one caveat

**Severity: ACCEPTABLE RISK**

The plan correctly identifies that process liveness (checked on line 2022 before hooks are read) catches agent crashes. If the process is dead, state becomes "stopped" regardless of hook state. This handles the primary concern.

The one scenario where stale "working" could persist:
- Claude Code hangs internally (process alive, but stuck in an infinite loop or deadlock).
- The `Stop` hook never fires.
- With PreToolUse/PostToolUse hooks, this means no hook updates would arrive either — the `updatedAt` stops advancing.
- Under the plan (no freshness check), the state stays "working" forever.

**Why this is acceptable**: A hung Claude process with stale "working" is the correct display from the user's perspective — the agent is non-responsive but alive. Showing "waiting" would be worse (user might send a message that gets lost). The user can observe staleness from `updatedAt` in the hook state file, or from the session's `lastActivityAt` in `spur list`.

**Architect A's 5-minute stale gate vs. Architect C's no gate**: Architect A adds a `HOOK_STALE_MS = 300_000` (5 min) safety net. Architect C removes the gate entirely. Since pane classification for Claude is fundamentally unreliable (Finding 1), falling through to pane after 5 minutes just returns "waiting" again — which is wrong. The stale gate provides no real benefit for Claude. For Codex, hooks are less critical since title-based detection works well. Removing the gate entirely (Architect C) is cleaner.

---

## Finding 3: `-J` flag — low regression risk, one edge case

**Severity: LOW RISK**

The `-J` flag joins wrapped lines by trimming trailing whitespace from each line and joining it with the next line when the original line was wrapped by the terminal. This is the correct semantic behavior.

**Codex detection impact**: `classifyCodexPane` checks `CODEX_PANE_WORKING_RE` (`/esc to interrupt/i`) against the full pane string, not individual lines. Line joining does not affect this regex. `isWaitingInput` joins tail lines with space before testing, so line breaks are already ignored. `CODEX_QUESTION_RE` also runs on the joined tail. No regression expected.

**Claude detection impact**: `classifyLivePaneState` checks `PROMPT_RE` on the last line. If `❯` was the last line before `-J` and it gets joined with previous wrapped content, the last line might change. However, `❯` is a very short line (1-3 chars) and would not itself be the result of line wrapping. The `-J` flag only joins lines that were split by terminal width. `❯` is not a split line. No regression expected.

**Test impact**: Fast tests mock `captureTmuxPane`, so the `-J` flag does not affect them. Runtime integration tests use a separate `captureTmuxPane` helper in `v2/test/helpers/runtime.ts` (line 311) that does NOT use `-J`. The runtime test helper should be updated to match, otherwise integration tests capture pane content differently than production code. This is a minor inconsistency but not a blocker for the fast tier.

---

## Finding 4: PreToolUse/PostToolUse hooks — performance and Codex support

**Severity: LOW RISK, needs verification**

Research-6 confirms Claude Code supports `PreToolUse` and `PostToolUse` hooks (line 137-141 of research-6.md). The hook payload includes `tool_name`, `tool_input`, etc.

**Codex support**: Architect A proposes adding these hooks to Codex too. Architect C does not mention Codex changes for hooks. The existing Codex hooks file (`v2/src/agents/codex.ts`) only registers `SessionStart`, `UserPromptSubmit`, `Stop`. Whether Codex supports `PreToolUse`/`PostToolUse` is not confirmed in the research. **If Codex does not support these events, the hooks config file will have extra entries that Codex ignores — harmless but unnecessary.**

**Hook blocking**: Architect A and C both acknowledge that Claude Code hooks block the agent until the command exits. At ~10ms per hook invocation and 2 hooks per tool call (Pre + Post), a 50-tool turn adds ~1s overhead. This is acceptable.

**The `matcher: "*"` field**: Architect C's proposed Claude hook settings use `matcher: "*"` for PreToolUse/PostToolUse. This is correct — it matches all tool names. The existing `hookEntry` for SessionStart/UserPromptSubmit/Stop does not need a matcher (those events are not tool-specific). Good.

---

## Finding 5: Existing tests that would break

Three tests will break under the plan:

1. **"skips pane capture when hook working state is within 2s"** (line 639): Currently asserts `captureTmuxPaneMock` is NOT called. Under the plan, pane capture always runs for `needs_input` overlay. Must update to assert pane IS called but state is still "working".

2. **"skips pane capture when hook working state is fresh and uses pane otherwise"** (line 718): Tests the 2s boundary. Must be rewritten — the concept of "fresh vs stale" working hooks disappears.

3. **"falls back to pane classification when hook working state is older than 2s"** (line 747): Tests fallback after 3s. Must be rewritten — stale working hooks no longer fall through.

The test **"trusts hook waiting state — returns waiting even if pane looks like working"** (line 804) should remain valid under the plan, since waiting hooks are still trusted.

All three breaking tests are expected and the architects have identified them. No surprise breakage.

---

## Finding 6: Missing StopFailure in Architect C's plan

**Severity: MINOR GAP**

Architect A adds `StopFailure` to hook registration and maps it to "waiting". Architect C does not mention `StopFailure`. Research-6 confirms Claude Code supports `Stop` and separately fires when the stop hook itself errors — but there is no `StopFailure` event in the research-6 hook event list (line 137-149). The events listed are: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`.

There is no `StopFailure` in the Claude Code hook event list. Architect A invented this event name. It does not exist. Registering it is harmless (Claude Code ignores unknown hook event names), but it will never fire. The `SessionEnd` event might be a better candidate if we want post-stop coverage, but it serves a different purpose.

---

## Finding 7: `classifyLivePaneState` default change — hidden regression

**Severity: MODERATE — needs careful handling**

Architect C proposes (line 191): change the default in `classifyLivePaneState` from `"waiting"` to `"working"` when no prompt char is found. The current code (line 251):

```typescript
return lastLine && PROMPT_RE.test(lastLine) ? "waiting" : "working";
```

This already returns "working" when the last line does not match PROMPT_RE. The proposed change in Architect C adds "esc to interrupt" before this check but does not actually change the default — the default is already "working" when no prompt is found. So this is a non-change for the pane classifier itself.

However, the plan's code for `enrich()` now always runs `classifyAgentState` even when hooks say "working", solely to check for `needs_input`. This means `classifyLivePaneState` runs on every poll for Claude. Previously, when hooks said "working" (first 2s), pane classification was skipped entirely. The pane classifier's result is only used for `needs_input` overlay when hooks are present, so the "waiting" vs "working" return value from the pane classifier does not matter in that path — only `needs_input` matters. This is correct.

---

## Finding 8: Race condition in first-poll window

**Severity: LOW — transient**

Between session spawn and the first hook event (SessionStart), `readAgentHookState` returns `null`. The plan falls through to full pane classification. For Claude, this means `classifyLivePaneState` runs, sees `❯`, and returns "waiting". The `STATE_HOLD_MS` (4s) debounce should cover this since the session just spawned with status "spawning" (which maps to "working"), and the debounce holds that for 4s. By then, the SessionStart hook should have fired.

**Edge case**: If the agent takes >4s to start and fire SessionStart, there is a brief "waiting" flash before the hook arrives. This is pre-existing and not introduced by the plan.

---

## Summary of Holes

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | "esc to interrupt" does not appear in Claude pane captures | Design hole | Do not claim it fixes Claude; it only helps Codex (already handled). Consider omitting it from classifyLivePaneState or adding a comment clarifying it is for non-Claude agents. |
| 2 | Removing HOOK_FRESHNESS_MS is safe | Acceptable | Proceed. No stale gate needed. |
| 3 | `-J` flag low regression risk | Low | Update runtime test helper to match. |
| 4 | Codex PreToolUse/PostToolUse support unverified | Low | Verify Codex supports these events before adding. Skip for Codex if unconfirmed. |
| 5 | Three tests break (expected) | Expected | Update as described by architects. |
| 6 | StopFailure event does not exist in Claude Code | Minor | Do not register it. It will never fire. |
| 7 | Default change in classifyLivePaneState is a non-change | None | No action needed. |
| 8 | First-poll race window | Low (pre-existing) | No action needed. |

---

## Verdict

The consensus plan (Architect C) is **sound for its core fix**: trusting hooks indefinitely and removing HOOK_FRESHNESS_MS. This correctly resolves the "always waiting" bug for Claude. The PreToolUse/PostToolUse addition is a good heartbeat improvement.

The plan has **one misleading claim** (Finding 1): adding "esc to interrupt" to `classifyLivePaneState` does not improve Claude's pane fallback. The research explicitly states Claude Code does not render this text in captured pane output. This should be corrected in the plan description.

The plan has **one phantom event** (Finding 6): `StopFailure` does not exist in Claude Code's hook system. Architect A proposed it; Architect C omitted it (correctly, by accident).

**PASS with notes**: The plan can proceed. The core fix is correct and well-reasoned. Findings 1 and 6 should be addressed in implementation (either remove the misleading "esc to interrupt" claim for Claude, or add a clarifying comment). Finding 3's test helper inconsistency should be noted for the implementer.
