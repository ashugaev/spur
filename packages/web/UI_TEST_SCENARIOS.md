# Web UI Test Scenarios

Browser-based test scenarios for the Spur web dashboard.
Run against a live daemon backed by the active global Spur instance config (`~/.spur/config.yaml` by default).
When testing behind a reverse proxy, ensure `/api/runtime/terminal` returns the externally reachable proxy port.

## Voice Input Prerequisites

Voice input requires HTTPS (browser `getUserMedia` policy). On `localhost` it works over plain HTTP.
For remote access via Tailscale:

```bash
# One-time: enable HTTPS proxy via tailscale serve
sudo tailscale serve --bg --https 443 http://127.0.0.1:5555

# Access at: https://<hostname>.<your-tailnet>.ts.net/
# Only reachable within the tailnet (not publicly exposed).

# To disable:
tailscale serve --https=443 off
```

Server-side dependencies are provider-specific:

- `voice.provider=whisper_cpp`: requires `whisper-cli`, `ffmpeg`, and a whisper.cpp model (default path `~/.cache/whisper.cpp/ggml-base.bin`).
- `voice.provider=faster_whisper`: requires Python and the `faster-whisper` package. Spur auto-detects `~/.spur/venvs/faster-whisper/bin/python` when present and uses `int8` by default.
- `voice.provider=azure_openai`: requires `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` in `~/.spur/.env`; `voice.model` is the Azure deployment name.

Language is configured in `~/.spur/config.yaml` under `voice.language` (default: `auto`).

## Dashboard

### D1: Header renders correctly

- 𖤓 icon + large project title visible at the same size as before
- Browser tab title is exactly `Spur`
- Project selection happens in the clickable title control with "All Projects" default and a visible chevron indicator beside the title
- SPAWN_NEW_SESSION button visible

### D2: Header stats show correct counts

- Needs Input, Working, Waiting, Stopped, Completed stat buttons in header after title, before search input
- Labels use secondary text color, values use primary
- Non-zero values show colored (error/working/attention/muted-grey/ready)
- Clicking a stat button filters sessions to that attention level; clicking again clears filter
- `Stopped` groups manually paused/stopped sessions and crashed non-terminal sessions whose runtime died unexpectedly
- Clicking `Completed` switches the dashboard into completed-only view: current sessions are hidden and only the `Completed` zone remains
- `Completed` stays neutral/white while inactive, even when completed sessions exist; it turns green only when the `Completed` filter is active and the count is non-zero
- After a session moves into a done/terminal state on the next poll, the `Completed` stat count updates and the session reappears only when the `Completed` filter is active
- When the active filters produce zero visible sessions, show the empty placeholder instead of a blank area
- When only completed sessions exist, the default empty placeholder stays neutral and does not show a guide hint about toggling `Completed`
- Filtered empty placeholder shows a `Reset Filters` button that clears search, project, and stat filters
- Switching the dashboard project filter updates the visible rows and `?project=` URL without triggering a new `/api/sessions` fetch

### D3: Session rows render with correct columns

- Each row: activity dot, project (hidden <sm), agent (hidden <md), title link, tracker/PR links (hidden <sm), branch (hidden <lg), time, trailing action button
- Project filter dropdown shows a small left-side chevron indicator so it reads as a select, not a plain input
- All rows aligned — terminal button column is uniform width
- Session title link carries `?project=<id>` only when the dashboard itself currently has an explicit project filter; from `All projects` it opens session detail without a project query

### D4: Dashboard row action button state

- Sessions with `runtimeAlive=true` + `tmuxSession` + `status!=completed|killed`: button enabled (visible border, secondary text color)
- Sessions without `tmuxSession` and no restore action: button disabled (transparent border, 25% opacity, cursor-not-allowed)
- Disabled button does NOT open terminal modal on click
- Enabled button opens terminal modal on click
- Opening terminal appends `terminal=<session-id>` query param
- Closing terminal removes `terminal` query param
- Reload with `terminal=<session-id>` restores modal only when that session is attachable
- Restorable Stopped sessions show a restore icon in the row action slot instead of a disabled terminal icon
- Clicking restore posts to `/api/sessions/<id>/restore`; success refetches sessions and failure leaves the row visible with a dashboard error
- Sessions with an open PR that GitHub reports as mergeable: merge icon button replaces terminal button in the dashboard list only
- Clicking the merge icon calls the web merge API and, on success, the row flips into the merged-PR done-button state without waiting for a full reload

### D4b: Merged-PR done button

- Sessions with merged PR + completable status: checkmark icon button replaces terminal button
- Checkmark button same size (h-6 w-6) as terminal button
- Hover: green border + text (`--color-status-ready`)
- Click: row moves to Completed/hidden immediately through dashboard cache, complete API runs, sessions refetch in background
- On error: button re-enables
- On success: completed filter shows the row immediately from optimistic cache

### D5: Tracker and PR links

- Sessions with tracker link: Jira icon + ticket ID (e.g., WEBDEV-4617)
- Sessions with PR link: provider icon + compact review id (GitHub `#3439`, GitLab `!3439`), including the canonical `github-pr` slot label
- PR badges stay compact: review id first, then CI/review mark, then review thread count
- PR badges show a CI-first compact mark: one green check for CI success, then an overlapping second check for review state
- When approval is received, the second overlapping check is green
- When approval is still required, the second overlapping check is yellow
- When no approval is required, the second overlapping check is gray
- When changes are requested, the second review mark stays red/error
- Resolved threads alone do not turn the review mark green
- Stale/missing PR status payloads keep the PR link visible and do not change the footer GitHub connection indicator
- Soft PR status errors stay local to the PR UI and do not replace the footer GitHub connection indicator
- Both open in new tab on click
- Sessions without links: no icons shown, no empty space

### D5b: PR status survives reload and GitHub errors

- After PR badges (state color, CI dot, review thread count) populate, a full page reload renders the same badges immediately from `localStorage` (`spur:pr-status-cache:v1`) before any network response — no flash of empty badges
- When GitHub responds with an error after a previous successful fetch, the badge keeps the last known state and the footer `Git Error` badge appears alongside it; badges do not reset to empty
- A first-ever load with GitHub down shows empty badges plus the `Git Error` footer; subsequent successful fetches replace empty badges with real values

### D6: Attention zone sections

- Default dashboard view shows active sections only: NEEDS INPUT, WAITING, WORKING, STOPPED
- `Completed` toggle reveals the COMPLETED section and hides current-session sections
- Each has colored dot + uppercase label + divider line + count
- On mobile first render, `Stopped` starts collapsed by default when no saved `spur:mobile-collapsed-categories` override exists; the header and count stay visible and tapping the section expands/collapses rows normally
- Empty sections are hidden instead of rendering placeholder rows
- Sessions sorted into correct sections by attention level

### D6b: Footer

- Footer is visible after page load
- Footer right side shows `NEXT_PUBLIC_BUILD_VERSION` env var value, or `dev` when not set at build time
- Footer left side shows Online status when daemon is reachable
- Footer shows separate GitHub and GitLab connection indicators that are independent from PR status rows
- Platform connection indicators stay icon-only on the footer bar: platform icon + status icon, with no inline text label or inline error string
- Before the first platform health response resolves, the footer shows a neutral icon-only checking state for that platform
- Healthy platform status renders as a healthy status icon next to the GitHub or GitLab icon
- Hovering, focusing, or clicking/tapping a platform indicator shows a tooltip with the platform name, text status, and the last request timestamp
- Clicking/tapping a healthy platform indicator pins the tooltip open until the next click or an outside tap closes it
- Platform connection/auth/API failures render the error text inside the tooltip, not directly in the footer bar
- Non-200 `/api/github-status` and `/api/gitlab-status` responses fall back to `<Platform> status unavailable (<status>)` in the tooltip

### D6c: Footer resource metrics

- Footer left side shows an aggregated system health trigger that is both hoverable and clickable, with the label synced to the current health state (`HEALTHY`, `WARNING`, `CRITICAL`, `UNAVAILABLE`)
- Opening the `HEALTHY` tooltip shows `Daemon`, `CPU`, `RAM`, and `HDD` rows with dot indicators
- `CPU` and `RAM` rows turn attention/yellow at or above the threshold; `HDD` turns error/red at or above the threshold
- Clicking inside the system health tooltip closes it
- On touch devices, tapping anywhere outside the open system health tooltip closes it
- On desktop, hover opens the system health tooltip and mouse leave closes it
- When runtime metrics are unavailable, the footer stays compact and the tooltip shows `unavailable` values instead of inline error chrome
- GitHub connection status stays outside the `HEALTHY` tooltip

### D7: Spawn modal

- SPAWN_NEW_SESSION button opens centered modal on desktop and a viewport-bounded modal on mobile
- Mobile slash suggestions stay fully inside the viewport instead of clipping off the right edge of the spawn modal
- If dashboard filter has a specific project selected, Spawn project select is prefilled with that same project
- If dashboard filter is `All projects`, Spawn project select restores the last user-selected Spawn project from local storage when still available
- If stored Spawn project is stale (missing from available options), Spawn project select falls back to the first available project option
- Button labels stay on one line
- Modal has: project select, agent select, branch input, workspace select, plan checkbox, steps list, multiline textarea, Spawn button
- Branch input: placeholder "Branch name", optional
- Workspace select: Default / Worktree / Shared options
- When Worktree selected: base branch input appears with placeholder "Base branch"
- Plan checkbox: labeled "PLAN", toggles plan mode
- Plan toggle does not show extra agent-specific hint text
- Agent selector offers `claude`, `codex`, and `cursor`
- Steps: "+ STEP" button adds step inputs, each with remove (✕) button, scrollable at 4+ steps
- Microphone button in top-right corner of prompt textarea when voice available on host
- History icon button sits before `Spawn`, opens the last five saved prompts for that textarea, and each entry shows its saved timestamp
- `/` button sits with the composer actions, opens a suggestion list grouped by Commands / Skills / Agents, and selecting an item inserts its text into the prompt textarea
- When voice is available and idle, the prompt textarea placeholder includes `Voice ⌘ + .`
- Click starts recording, second click stops and inserts transcribed text directly into textarea (no confirmation popup)
- Saved prompt history selection restores the chosen prompt back into the textarea without spawning immediately
- Enter in textarea creates newline (not submit)
- Cmd+Enter submits
- Cmd+. toggles voice recording on/off inside the modal
- Prompt textarea placeholder is "Prompt for the new session..." without voice support, and appends `Voice ⌘ + .` when voice is available and idle
- The spawn prompt shows an inline image-picker button inside the textarea chrome
- Pasting, dropping, or picking an image adds a compact thumbnail preview inside the textarea chrome with an inline remove button
- Spawn payload includes those image attachments, and successful spawn clears the inline preview list
- On low-height mobile landscape screens, modal stays inside viewport and content scrolls internally so Spawn button remains reachable
- On mobile, prompt textarea expands to use the remaining modal height when space allows
- On larger screens, prompt textarea default height is taller than the previous compact size
- Spawn button shows inline muted hotkey hint "⌘ + ⏎" on the same line as the label
- Click outside modal (backdrop) closes it
- ✕ button closes modal
- Spawn button disabled only when project is empty
- Changing Spawn project updates the last selected Spawn project in local storage
- Successful Spawn persists the selected project so it is restored on the next open
- Successful Spawn closes the modal as soon as the daemon acknowledges the new `spawning` session shell, before background setup finishes
- Successful Spawn keeps the current dashboard project filter and `?project=` URL unchanged
- Successful Spawn immediately inserts exactly one new `spawning` session shell only when the dashboard is showing `All Projects` or the spawned project already matches the current filter
- When the spawned project does not match the current dashboard filter, the current list stays unchanged and the new placeholder shell stays hidden until filters change
- Rapid repeat submit while the first spawn request is in flight still sends only one spawn request and creates only one new session shell
- Spawn without a prompt still closes on ack and creates the session shell without waiting for preflight
- After a successful ack, reloading the dashboard while the session is still `spawning` keeps the same placeholder shell visible
- When background setup succeeds after polling, the existing placeholder shell becomes the running session in place instead of disappearing and reappearing
- When background retries happen before the initial prompt is sent, the dashboard continues to show exactly one session shell for that spawn
- When all background attempts fail, the dashboard ends with exactly one errored session shell for that spawn
- When an explicit branch is already occupied, the placeholder shell transitions to a single failed session without creating a duplicate
- If the spawn ack fails because the daemon/backend API is unavailable, the modal stays open and preserves the typed fields
- After an ack failure, clicking `Spawn` again retries from the same open modal with the typed content still intact
- All new fields except project reset on successful spawn ack, and reopening remembers the last selected spawn project

### D7b: Silent branch preflight

- When project and prompt are set, preflight runs silently in the background (500ms debounce)
- On success: branch input is auto-populated with the suggested branch name
- On failure or no suggestion: branch field stays unchanged (no error shown)
- User can still manually edit the branch field after auto-population

### D7d: Sessions list cache on revisit

- After the first Dashboard visit loads sessions, navigating away and back renders the list instantly with no "Loading sessions..." text
- Background refetch on the 5s interval silently replaces the list only when the server response differs

## Session Detail

### S1: Header with white underline

- Back link to dashboard
- If session detail URL has no `project` query, Back returns to `/` so dashboard restores its default filter from local storage
- If session detail URL has `?project=<id>`, Back preserves that explicit dashboard filter
- Missing or deleted sessions replace the loading placeholder with an inline error plus `Retry`
- Browser tab title is the session id only, with no `| Spur` suffix
- Project • Agent • Session ID breadcrumb
- Title uppercase bold
- Subtitle (prompt) below
- Activity dot + branch badge + status badges
- White bottom border (2px) under header

### S2: Actions bar

- Terminal button (white filled) when session attachable
- `Workspace Access` section appears only when daemon `workspaceAccess.items[]` is present, and link items open in a new tab
- Pause button (bordered) when session pausable
- Complete button (green bordered) when session completable
- Kill button (red bordered) when session not terminal
- Button labels stay on one line
- All buttons uppercase, bold, disabled when action in progress
- Kill shows confirm dialog
- Terminal sessions show an `Edit & Respawn` action that opens a modal with the original first prompt prefilled
- `Edit & Respawn` allows keeping previously attached startup images, adding new images via paste, drop, or picker button, and respawning with image-only input when text is empty

### S2a: Logs modal

- `Logs` opens a full-screen modal for the current session
- Modal subtitle reads as Spur orchestrator events plus runtime output, not agent chat history
- Empty state shows a bordered placeholder instead of raw empty text
- `session.state.transition` entries render as a dedicated status-transition row with `from -> to`
- Transition rows show the detection source (`jsonl`, `hook`, or `status`) when present
- Transition rows show a `History snapshot` download link only when `historyArtifactId` belongs to the currently visible artifact bucket
- Automatic history snapshots stay hidden in the default Agent view and in Attached, and appear only after switching to the System artifact view
- Non-transition entries still render in the same stream as generic Spur/runtime events instead of disappearing
- Runtime output entries label the source as `service <id>` or `sidecar <name>` when those details exist

### S2b: Conversation dialog (Claude only)

- Visible only for `agent === "claude"` sessions with conversation messages
- Hidden for codex sessions and when no messages exist
- Section header: "DIALOG" with duration (e.g., "2h 15m") on the right
- Scrollable message list (max-h-80) in bordered surface container
- User messages: right-aligned, accent border/background tint
- Assistant messages: left-aligned, default border, secondary text
- While the conversation state is `working`, append a pending assistant bubble with `...` instead of showing a duplicate status label under the dialog
- When the conversation state is `working`, the page header status also shows `working`
- Messages truncated at 500 chars with "..."
- Long unbroken tokens hard-wrap inside the bubble on mobile instead of widening the dialog
- Auto-scrolls to bottom when a pending assistant bubble appears or a new assistant message arrives
- Polls at same interval as session (4s)

### S2c: Queued messages

- Visible when `queuedMessages.messages.length > 0` or `queuedMessages.awaitingPrompt=true`
- Section header is `QUEUED MESSAGES`
- Messages render the full send stack in FIFO order
- Manual queued sends appear before future auto-step messages in the same stack
- Each queued message is shown as its own stacked row with full wrapped text
- Long unbroken queued tokens hard-wrap inside the row on mobile instead of widening the section
- When `awaitingPrompt=true`, hint text appears: queued messages will send automatically when agent is ready
- Hidden when queue is empty and not awaiting prompt

### S3: Message section

- Textarea for sending messages when session accepts input
- Microphone button appears in the top-right corner of the textarea only when local voice input is available on the host
- When voice is available and idle, the message textarea placeholder includes `Voice ⌘ + .`
- First microphone click starts recording; button switches to stop state
- Second microphone click stops recording, transcribes, and inserts text directly into the textarea (no confirmation popup)
- On mobile/PWA, stopping a non-empty recording still inserts the transcription instead of showing a spurious "captured no audio" error
- During transcription the mic button shows a red spinning loader
- History icon button sits before the send actions, opens the last five saved messages for that textarea, and each entry shows its saved timestamp
- `/` button sits with the send actions, opens a suggestion list grouped by Commands / Skills / Agents, and selecting an item inserts its text into the message textarea
- If stop/transcribe/insert fails or no audio was captured, an inline red error message appears instead of failing silently
- Retryable transcription failures retry automatically up to three attempts; if all attempts fail, the final inline error names the exhausted retry count instead of failing silently
- If microphone startup is blocked by browser permission or insecure context, an inline red error message explains whether to allow microphone access or switch to HTTPS/localhost
- `Queue` button adds the message to the queued stack
- `Send now` button bypasses the queue and sends immediately
- `Queue` button has no inline hotkey hint
- `Send now` button shows inline muted hotkey hint "⌘ + ⏎" on the same line as the label
- Cmd+Enter triggers the immediate send path
- Cmd+. toggles voice recording on/off from the textarea
- Enter in the message textarea creates a newline instead of submitting
- `Queue` and `Send now` buttons are disabled when empty (no text and no attachments) or action in progress
- "Not accepting input" message when session cannot receive input
- The message textarea shows an inline image-picker button inside the textarea chrome
- Cmd+V paste with image on clipboard adds a compact thumbnail preview inside the textarea
- Drag-and-drop image file onto textarea adds a compact thumbnail preview inside the textarea
- Picking an image from the file chooser adds the same compact inline thumbnail preview
- Non-image files in paste/drop are silently ignored
- Each thumbnail has a remove button visible on hover
- Both `Queue` and `Send now` are enabled when attachments are present even with empty text
- Attachments and text cleared after successful send

### S4: Links section

- Shows when session has links
- Canonical tracker/PR links stay surfaced in the header badge strip
- PR header badges show compact provider/id, CI/review state, and review thread count
- A tracker or PR URL appears in exactly one place on session detail: header badge strip or Links section, never both
- Each link clickable, opens in new tab

### S4b: Artifacts section

- Shows when session has persisted artifacts
- Default artifact view is `Agent`; `Attached` shows only user-added artifacts and `System` shows automatic artifacts
- `Agent`, `Attached`, and `System` views never mix cards across categories
- Artifacts render as compact cards in a responsive grid, not as stacked full-width rows
- Image and video cards show media thumbnails plus hover/focus overlay actions for preview and download
- User-added image artifacts in `Attached` render as larger polished image cards with visible `Attached Image`, extension, size, and timestamp badges
- Clicking preview opens a full-screen artifact lightbox with close and download actions
- Non-media artifacts render as file tiles with extension badge and download action only
- Download links proxy through `/api/sessions/:id/artifacts/:artifactId`

### S5: Runtime sidebar

- Key-value pairs: Created, Last activity, Worktree, Agent runtime, Workspace
- Worktree path in bordered box
- Copy workspace access items show the final text, use an interactive copy icon button, and show a styled success/error toast after copy attempts
- Error shown in red box when present

### S6: Terminal modal (dashboard + detail page)

- Terminal button opens the shared full-screen terminal overlay from both dashboard and detail page
- ✕ closes overlay
- Open/close always syncs `terminal=<session-id>` in query params
- Reload restores terminal overlay from query on both pages when attachable
- Back/forward navigation replays terminal open/close state from query
- DirectTerminal component renders inside
- Bottom control bar uses black terminal surface styling, not elevated gray
- Control bar shows `...` shortcuts menu, `Slash`, `ENTER`, arrow buttons, and microphone button (when voice available) with bordered square button styling
- Terminal control bar does not show a standalone `Voice ⌘ + .` hint before the confirmation popup opens
- There is no standalone `ESC` button in the control bar; `Esc` lives inside the `...` menu
- `...` opens an agent-specific shortcuts menu (`claude` or `codex`) that includes `Esc` and `Shift+Tab`; clicking an item sends the matching control sequence into the terminal and closes the menu
- `Slash` opens a suggestion list grouped by Commands / Skills / Agents; selecting an item submits the exact slash text into the terminal as bracketed paste plus a separate `Enter`
- Microphone button appears after arrow keys with a small gap; click starts recording. While recording the single mic button is replaced by two buttons in the same slot: a pencil on the left and a stop square on the right (red border + red tint)
- Stop button transcribes and submits the result into the terminal immediately without showing the confirmation popup; pencil button stops recording and opens the confirmation popup so the transcript can be edited before insertion
- Idle state outside recording shows the single mic button only (no pencil, no stop)
- Confirming terminal voice input submits immediately without an extra manual keypress: for both `claude` and `codex` the reviewed text is sent as a bracketed paste (`ESC[200~`…`ESC[201~`) followed by a separate `Enter`, so the agent never receives an embedded `\r` that would be treated as a newline inside the input
- Confirmation popup has a microphone button inside the textarea (bottom-right corner); clicking it starts a new recording that appends transcribed text to the existing draft
- Confirmation popup has an inline image-picker button matching spawn input; picking, pasting, or dropping images adds compact previews with remove buttons
- Cmd+V image paste inside the main agent terminal opens the confirmation popup with the pasted image preview instead of sending raw clipboard bytes into xterm
- Confirmation popup can insert image-only drafts, and image attachments are sent through the session message API
- Confirmation popup textarea placeholder includes `Voice ⌘ + .` when idle
- Confirmation popup actions include a history icon button before `Cancel`/`Insert`; it shows the last five inserted terminal drafts with timestamps and restores the selected draft into the popup textarea
- `Insert` shows inline muted hotkey hint "⌘ + ⏎" and Cmd+Enter confirms the popup
- Cmd+. toggles popup voice recording on/off
- While recording or transcribing inside the popup, the Insert button is disabled and a status hint appears below the textarea
- Cancelling or closing the confirmation popup while recording stops the recording without a spurious error
- Terminal is the only place that uses a confirmation popup for voice input; spawn and session message insert directly
- If terminal voice insert fails, the confirmation popup stays open and a visible red error message appears above the terminal controls
- Helper textarea remains focused for keyboard input but has no visible browser caret/artifacts
- Mouse wheel scrolling stays within the terminal (does not scroll the page behind the modal)
- Terminal scrollback works like a native terminal (scroll up/down through history)
- On touch devices, dragging the terminal content up/down scrolls in the same visual direction as a native terminal scrollback
- After switching tabs away or locking/unlocking the screen, the terminal stays connected when the websocket remains open
- If the websocket closed while the tab was hidden, returning to the tab reconnects without reopening the modal or reloading the page
- During reconnect, the header status changes from `Connected` to a reconnecting message and returns to `Connected` once the stream resumes

### S7: Display state override

- When `session.state` is terminal (`error`, `killed`, or `stopped`), the header state badge shows that state verbatim even when the Claude JSONL conversation endpoint reports `working`
- A manually paused session now persists `status=stopped` and renders the visible badge text `stopped`, not `paused`
- When `session.state` is active (`working`, `waiting`, `needs_input`), a Claude conversation endpoint reporting `working` still overrides the badge to `working` (fast in-progress signal)

## Responsive

### R1: Mobile (<640px)

- Header items wrap independently instead of moving as one grouped block
- The project title select, each stat filter, search input, and Spawn Session can all jump to the next line on their own when space runs out
- Focusing any text input, textarea, or select does not trigger iPhone Safari auto-zoom
- No horizontal page scroll (`document.documentElement.scrollWidth <= window.innerWidth`)
- Session rows: project column hidden, only dot + title + time + terminal btn
- Attention zones use accordion (tap to expand/collapse)

### R2: Tablet (640-1024px)

- Header horizontal
- Header controls wrap independently instead of moving as a single block
- Stat filters (`Needs Input`, `Working`, `Waiting`, `Completed`) are separate layout items and can wrap one by one before labels collapse into the compact icon-only state
- Before stat labels collapse into the compact icon-only state, `Spawn Session` drops below search first on narrower widths
- Agent column appears at md (768px)
- Branch column appears at lg (1024px)
- Tracker/PR links appear at sm (640px)

### R3: Desktop (>1024px)

- Full layout: all columns visible
- Header stats inline with title

## Sidecar Terminal

### SC1: Sidecar terminal buttons

- Sidecars section visible in session detail sidebar when session has sidecars
- Each sidecar shows name and alive/offline status
- Each sidecar shows an icon-only play button when offline and an icon-only stop button when alive
- Terminal button visible only when sidecar is alive and session is attachable
- Any sidecar whose name matches a session slot link label renders an `Open` link when alive
- When a sidecar row has multiple actions, the play/stop icon stays as the rightmost action
- Clicking terminal button opens terminal modal for sidecar tmux session
- Terminal header shows `session.title` from slots title when available, with sidecar suffix appended on sidecar terminals
- Terminal header text shows session id, then title, then status/close controls. Long titles clamp to two lines via CSS, with desktop header items vertically centered and no overlap or horizontal scroll.
- Clicking play/stop updates the sidecar row state without leaving the page
- No sidecars section shown when sidecars array is empty

## PWA

### P1: App is installable from browser chrome

- `GET /manifest.webmanifest` returns Spur manifest with `name`, `short_name`, `display=standalone`, `start_url=/`, dark `theme_color`, and 192/512 PNG icons
- Browser devtools Application tab shows the manifest without missing required fields
- Chromium shows install/save-app affordance for the dashboard when opened on `localhost`
- Installed window opens on `/` with Spur name/icon instead of a generic browser shortcut
- iOS-sized pass uses the provided Apple icon when saving to home screen
