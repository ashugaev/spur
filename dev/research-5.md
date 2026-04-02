# Research: Multi-Agent Orchestrator State Tracking

Two open-source projects that manage multiple AI coding agents in parallel via tmux and need to track their status.

---

## 1. NTM (Named Tmux Manager)

**URL**: https://github.com/Dicklesworthstone/ntm
**Stars**: ~222
**Language**: Go
**Agents supported**: Claude Code, Codex, Gemini, Ollama, Cursor, Windsurf, Aider

### How it tracks agent state across sessions

NTM treats tmux as the ground truth. Each agent runs in a labeled tmux pane. State is derived by capturing pane output and pattern-matching against known agent indicators. There is no sidecar or IPC channel; the pane text _is_ the state source.

Key components:
- `internal/agent/patterns.go` -- regex + substring patterns per agent type to classify output as idle/working/error/rate-limited
- `internal/coordinator/monitor.go` -- `UnifiedDetector` analyzes pane output, `ActivityMonitor` applies hysteresis
- `internal/context/monitor.go` -- tracks tokens, context usage, message velocity per agent
- `internal/resilience/monitor.go` -- health checks with PID liveness + consecutive-failure thresholds

### State machine

NTM does not use a single unified state enum. It tracks multiple orthogonal dimensions per agent:

**Agent activity state** (detected from output patterns):
- `StateIdle` -- prompt visible, waiting for input
- `StateWorking` -- action verbs, spinners, code blocks in output
- `StateError` -- error/exception/panic keywords
- `StateUnknown` -- fallback

**Recommendation enum** (derived from activity + context):
- `RecommendDoNotInterrupt` -- actively producing output
- `RecommendSafeToRestart` -- idle and available
- `RecommendContextLowContinue` -- working but context depleting
- `RecommendRateLimitedWait` -- API limit hit
- `RecommendErrorState` -- agent errored
- `RecommendUnknown`

**Health state** (resilience monitor):
- Healthy -> Unhealthy (error status, process exit, missing pane)
- Unhealthy -> Healthy (clean check)
- Rate-limited flag set independently

No formal transition validation -- states are re-derived each poll cycle from fresh output.

### Polling and intervals

| What | Interval | Source |
|------|----------|--------|
| Session existence check | 5s ticker | `internal/cli/monitor.go` |
| Output snapshot for summaries | 30s ticker | `internal/cli/monitor.go` |
| Health check cycle | configurable, 10s minimum floor | `internal/resilience/monitor.go` |
| Context recency window | 30s | `internal/context/monitor.go` |
| Dashboard pane prefetch | 500ms timeout at startup | `internal/cli/dashboard.go` |

### Caching, debounce, and state-hold logic

**Consecutive-miss debounce for session loss**: The monitor tolerates transient tmux failures. It requires `maxMisses = 5` consecutive failures (25s at 5s polling) before declaring a session permanently gone. Each miss is logged with cause detection.

**Hysteresis in activity monitor**: The `ActivityMonitor` applies hysteresis when transitioning to error state, preventing rapid oscillation between working and error when an agent prints error-like strings during normal operation.

**Context recency window**: A 30-second recency window on robot-mode estimates prevents thrashing between estimation methods.

**Resilience monitor debounce**: Dual-mode strategy:
- PID-based (authoritative): crashes trigger immediately, no debounce needed
- Text-based (fallback): consecutive-failure counter with configurable threshold (default 3), immediate reset on healthy status
- 5-second grace period post-restart suppresses false positives

**Projection staleness**: TUI parity uses `Fresh` boolean + `StaleAfter` timestamp on projection snapshots. Consumers decide whether to re-fetch.

### Race condition handling

**Session existence race**: Code explicitly detects `"session still exists (race)"` when session listing shows the target despite prior detection failures.

**TOCTOU mitigation on restart**: Before injecting restart commands, a single PID liveness check is captured and stored to avoid time-of-check/time-of-use races between the guard and the action.

**Mutex protection**: `sync.RWMutex` on agent state maps. Hook function snapshots are read-locked during capture. Context monitor uses separate read/write locks for state reads vs. mutations.

**"Agent just finished" gap**: NTM re-derives state from fresh output every poll cycle. There is no event push from the agent. The worst-case delay is one poll interval (5s for existence, variable for health). The `IsWorking` guard ("never interrupt agents that are actively producing output") is the safety net -- it biases toward false-busy over false-idle. Pattern design philosophy: "false positives (waiting unnecessarily) are acceptable, but false negatives (interrupting a blocked agent) are costly."

---

## 2. oh-my-codex (OMX)

**URL**: https://github.com/Yeachan-Heo/oh-my-codex
**Stars**: ~10,051
**Language**: TypeScript + Rust (crates for runtime-core, mux, sparkshell)
**Agents supported**: Codex (primary), with hooks extensibility for others

### How it tracks agent state across sessions

OMX uses a file-based state system in `.omx/state/`. Each mode (ralph, team, autopilot, etc.) writes its own state file. The HUD reads all state files on each tick. Session identity is tracked via PID liveness checks rather than timeouts.

Key components:
- `src/hud/state.ts` -- reads 11 parallel state sources via `readAllState()` using `Promise.all()`
- `src/hud/index.ts` -- `watchRenderLoop()` drives the HUD tick
- `src/hooks/session.ts` -- session state with PID-based staleness detection
- `crates/omx-runtime-core/src/engine.rs` -- event-sourced runtime engine with authority leases
- `crates/omx-runtime-core/src/dispatch.rs` -- linear dispatch state machine

### State machine

OMX has multiple layered state systems:

**Dispatch state machine** (Rust runtime-core, `dispatch.rs`):
```
Pending -> Notified -> Delivered
   |
   +-> Failed (from Pending or Notified)
```
Invalid transitions are rejected with `DispatchError`. Each transition records a timestamp.

**Authority lease** (`authority.rs`):
- Unowned -> Acquired (by owner)
- Acquired -> Renewed (same owner extends lease)
- Acquired -> Stale (marked with reason, e.g., "network timeout")
- Any -> Released (force release clears all fields)
- Acquire by different owner while held -> `AlreadyHeldByOther` error

**Engine readiness** (derived, not explicit enum):
- Ready: authority held and not stale, no pending replay events
- Blocked: authority not held, or stale, or replay backlog > 0

**Session staleness** (`session.ts`):
- Active: PID alive and identity matches (Linux: `/proc/[pid]/stat` start ticks + cmdline)
- Stale: PID dead or identity mismatch
- No age-based timeout; purely PID liveness

**HUD mode states**: Each mode (ralph, team, autopilot, etc.) has an `active` boolean. The HUD filters: `state?.active ? state : null`.

### Polling and intervals

| What | Interval | Source |
|------|----------|--------|
| HUD render loop | 1000ms (default, configurable via `options.intervalMs`) | `src/hud/index.ts` |
| Git operation timeout | 2000ms | `src/hud/state.ts` |
| HUD resize reconcile delay | 2s | `src/hud/constants.ts` |
| Authority/engine | No polling -- event-driven via commands | `crates/omx-runtime-core/` |

The HUD loop measures actual render time and adjusts sleep to maintain consistent 1s cadence: `sleep(max(0, intervalMs - elapsed))`.

### Caching, debounce, and state-hold logic

**HUD render queue**: Instead of traditional debounce, the HUD uses an `inFlight` + `queued` boolean pair. If a render is in progress when a new tick fires, it sets `queued = true` and skips. When the current render finishes, it checks `queued` and immediately re-renders. This guarantees no render requests are lost while preventing overlapping renders.

**No state caching**: Each HUD tick calls `readAllState()` fresh. There is no memoization between ticks. The 11 state files are read in parallel via `Promise.all()`.

**Event log persistence**: The Rust runtime-core uses event sourcing. All state changes append to an immutable `event_log` before returning. `persist()` uses exclusive file locking; `load()` uses shared locks. This prevents partial writes but does not protect in-memory concurrent access (assumes single-threaded or external sync).

**Backward compatibility in state reads**: State readers handle schema evolution inline, e.g., `input_lock_active: state.input_lock_active ?? state.input_lock?.active === true`.

### Race condition handling

**"Agent just finished but HUD hasn't updated yet"**: OMX accepts eventual consistency. The HUD reads fresh state every 1s tick. If an agent finishes between ticks, the update appears on the next tick. There is no push notification from agent to HUD. The architecture "prioritizes simplicity over immediate consistency -- updates wait until the next 1-second boundary."

**File locking in Rust runtime**: `persist()` takes exclusive lock, `load()` takes shared lock. This prevents corrupted reads during writes. No mutex/arc for in-memory access.

**Parallel state reads**: `Promise.all()` for 11 independent state sources avoids sequential bottlenecks. Each read is independent; a slow read does not block others (beyond Promise.all completion).

**Session staleness**: PID liveness check (`process.kill(pid, 0)`) with Linux identity verification via procfs. No age-based expiry means a crashed-but-not-reaped process is correctly detected as stale only when PID is recycled or cmdline changes.

---

## Comparison Summary

| Aspect | NTM | oh-my-codex |
|--------|-----|-------------|
| State source | tmux pane output (pattern matching) | File-based (`.omx/state/` JSON files) |
| State derivation | Re-derived each poll from fresh output | Read from disk each tick |
| Primary poll interval | 5s (existence), 10s+ (health) | 1s (HUD) |
| Debounce strategy | Consecutive-miss counters (5 misses), hysteresis on activity, grace periods | inFlight/queued render gating |
| Formal state machine | No -- orthogonal dimensions re-derived | Yes -- dispatch (Pending->Notified->Delivered/Failed), authority lease |
| Race condition approach | Bias toward false-busy; "never interrupt working agent"; TOCTOU PID guard | Accept 1s eventual consistency; file locks for persistence |
| Agent-finish detection lag | Up to 5s (poll interval) | Up to 1s (HUD tick) |
| Concurrency primitives | `sync.RWMutex`, `sync.Once` | File locks (Rust), Promise.all parallelism (TS) |
| Caching | 30s recency window on context estimates, staleness metadata on projections | None -- fresh reads every tick |

### Key takeaways for Spur

1. **Poll interval matters for perceived responsiveness**: NTM at 5s feels sluggish for TUI; OMX at 1s feels near-instant. Spur's list TUI should target 1s or less.

2. **Consecutive-miss debounce is essential**: Both projects learned that tmux operations can transiently fail. NTM's 5-miss threshold (25s confirmation) is battle-tested. Spur should not declare a session dead on a single failed tmux check.

3. **Bias toward false-busy**: NTM's explicit design choice -- "false positives (waiting) are acceptable, false negatives (interrupting) are costly" -- is correct for coding agents where interruption loses work.

4. **File-based state vs. output parsing**: OMX's file-based approach is simpler and more reliable than NTM's output pattern matching. Spur already uses flat metadata files, which aligns with OMX's approach.

5. **Render gating over debounce**: OMX's `inFlight`/`queued` pattern for the HUD loop is simpler than timer-based debounce and guarantees no missed updates. Worth adopting for Spur's list TUI.

6. **Event sourcing for audit**: OMX's append-only event log in the Rust runtime enables deterministic replay. Spur's JSONL event log serves the same purpose.
