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

# Access at: https://<hostname>.tail90e846.ts.net/
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
- Project selection happens in the clickable title control with "All Projects" default and a visible chevron indicator beside the title
- SPAWN_NEW_SESSION button visible

### D2: Header stats show correct counts

- Needs Input, Working, Waiting, Completed stat buttons in header after title, before search input
- Labels use secondary text color, values use primary
- Non-zero values show colored (error/working/attention/ready)
- Clicking a stat button filters sessions to that attention level; clicking again clears filter
- Clicking `Completed` switches the dashboard into completed-only view: current sessions are hidden and only the `Completed` zone remains
- `Completed` stays neutral/white while inactive, even when completed sessions exist; it turns green only when the `Completed` filter is active and the count is non-zero
- After a session moves into a done/terminal state on the next poll, the `Completed` stat count updates and the session reappears only when the `Completed` filter is active
- When the active filters produce zero visible sessions, show the empty placeholder instead of a blank area
- When only completed sessions exist, the default empty placeholder stays neutral and does not show a guide hint about toggling `Completed`
- Filtered empty placeholder shows a `Reset Filters` button that clears search, project, and stat filters

### D3: Session rows render with correct columns

- Each row: activity dot, project (hidden <sm), agent (hidden <md), title link, tracker/PR links (hidden <sm), branch (hidden <lg), time, terminal button
- Project filter dropdown shows a small left-side chevron indicator so it reads as a select, not a plain input
- All rows aligned — terminal button column is uniform width
- Session title link carries `?project=<id>` only when the dashboard itself currently has an explicit project filter; from `All projects` it opens session detail without a project query

### D4: Terminal button state

- Sessions with `runtimeAlive=true` + `tmuxSession` + `status!=completed|killed`: button enabled (visible border, secondary text color)
- Sessions with `runtimeAlive=false` OR no `tmuxSession`: button disabled (transparent border, 25% opacity, cursor-not-allowed)
- Disabled button does NOT open terminal modal on click
- Enabled button opens terminal modal on click
- Opening terminal appends `terminal=<session-id>` query param
- Closing terminal removes `terminal` query param
- Reload with `terminal=<session-id>` restores modal only when that session is attachable

### D4b: Merged-PR done button

- Sessions with merged PR + completable status: checkmark icon button replaces terminal button
- Checkmark button same size (h-6 w-6) as terminal button
- Hover: green border + text (`--color-status-ready`)
- Click: calls complete API, button disables immediately (no double-click)
- On error: button re-enables
- On success: button stays disabled until dashboard poll refreshes session to done zone

### D5: Tracker and PR links

- Sessions with tracker link: Jira icon + ticket ID (e.g., WEBDEV-4617)
- Sessions with PR link: GitHub icon + PR number (e.g., #3439)
- Both open in new tab on click
- Sessions without links: no icons shown, no empty space

### D6: Attention zone sections

- Default dashboard view shows active sections only: NEEDS INPUT, WAITING, WORKING
- `Completed` toggle reveals the COMPLETED section and hides current-session sections
- Each has colored dot + uppercase label + divider line + count
- Empty sections are hidden instead of rendering placeholder rows
- Sessions sorted into correct sections by attention level

### D6b: Footer

- Footer is visible after page load
- Footer right side shows `NEXT_PUBLIC_BUILD_VERSION` env var value, or `dev` when not set at build time
- Footer left side shows Online status when daemon is reachable

### D6c: Footer resource metrics

- Footer left side shows an aggregated system health trigger that is both hoverable and clickable, with the label synced to the current health state (`HEALTHY`, `WARNING`, `CRITICAL`, `UNAVAILABLE`)
- Opening the `HEALTHY` tooltip shows `Daemon`, `CPU`, `RAM`, and `HDD` rows with dot indicators
- `CPU` and `RAM` rows turn attention/yellow at or above the threshold; `HDD` turns error/red at or above the threshold
- Clicking inside the system health tooltip closes it
- On touch devices, tapping anywhere outside the open system health tooltip closes it
- On desktop, hover opens the system health tooltip and mouse leave closes it
- When runtime metrics are unavailable, the footer stays compact and the tooltip shows `unavailable` values instead of inline error chrome
- Git / PR aggregate stays outside the `HEALTHY` tooltip

### D7: Spawn modal

- SPAWN_NEW_SESSION button opens centered modal on desktop and a viewport-bounded modal on mobile
- If dashboard filter has a specific project selected, Spawn project select is prefilled with that same project
- If dashboard filter is `All projects`, Spawn project select restores the last user-selected Spawn project from local storage when still available
- If stored Spawn project is stale (missing from available options), Spawn project select falls back to the first available project option
- Button labels stay on one line
- Modal has: project select, agent select, branch input, workspace select, plan checkbox, steps list, multiline textarea, Spawn button
- Branch input: placeholder "Branch name", optional
- Workspace select: Default / Worktree / Shared options
- When Worktree selected: base branch input appears with placeholder "Base branch"
- Plan checkbox: labeled "PLAN", toggles plan mode
- Steps: "+ STEP" button adds step inputs, each with remove (✕) button, scrollable at 4+ steps
- Microphone button in top-right corner of prompt textarea when voice available on host
- History icon button sits before `Spawn`, opens the last five saved prompts for that textarea, and each entry shows its saved timestamp
- Click starts recording, second click stops and inserts transcribed text directly into textarea (no confirmation popup)
- Saved prompt history selection restores the chosen prompt back into the textarea without spawning immediately
- Enter in textarea creates newline (not submit)
- Ctrl/Cmd+Enter submits
- Prompt textarea placeholder is "Prompt for the new session..."
- On low-height mobile landscape screens, modal stays inside viewport and content scrolls internally so Spawn button remains reachable
- On mobile, prompt textarea expands to use the remaining modal height when space allows
- On larger screens, prompt textarea default height is taller than the previous compact size
- Spawn button shows inline muted hotkey hint "CMD + ⏎" on the same line as the label
- Click outside modal (backdrop) closes it
- ✕ button closes modal
- Spawn button disabled only when project is empty
- Changing Spawn project updates the last selected Spawn project in local storage
- Successful Spawn persists the selected project so it is restored on the next open
- Successful Spawn closes the modal as soon as the daemon acknowledges the new `spawning` session shell, before background setup finishes
- Successful Spawn immediately inserts exactly one new `spawning` session shell into the dashboard without waiting for worktree/tmux/prompt delivery
- Rapid repeat submit while the first spawn request is in flight still sends only one spawn request and creates only one new session shell
- Spawn without a prompt still closes on ack and creates the session shell without waiting for preflight
- After a successful ack, reloading the dashboard while the session is still `spawning` keeps the same placeholder shell visible
- When background setup succeeds after polling, the existing placeholder shell becomes the running session in place instead of disappearing and reappearing
- When background retries happen before the initial prompt is sent, the dashboard continues to show exactly one session shell for that spawn
- When all background attempts fail, the dashboard ends with exactly one errored session shell for that spawn
- When an explicit branch is already occupied, the placeholder shell transitions to a single failed session without creating a duplicate
- If the spawn ack fails because the daemon/backend API is unavailable, the modal stays open and preserves the typed fields
- After an ack failure, clicking `Spawn` again retries from the same open modal with the typed content still intact
- All new fields reset on successful spawn ack

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
- Project • Agent • Session ID breadcrumb
- Title uppercase bold
- Subtitle (prompt) below
- Activity dot + branch badge + status badges
- White bottom border (2px) under header

### S2: Actions bar

- Terminal button (white filled) when session attachable
- Pause button (bordered) when session pausable
- Complete button (green bordered) when session completable
- Kill button (red bordered) when session not terminal
- Button labels stay on one line
- All buttons uppercase, bold, disabled when action in progress
- Kill shows confirm dialog

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
- Auto-scrolls to bottom when a pending assistant bubble appears or a new assistant message arrives
- Polls at same interval as session (4s)

### S2c: Queued messages

- Visible when `queuedMessages.messages.length > 0` or `queuedMessages.awaitingPrompt=true`
- Section header is `QUEUED MESSAGES`
- Messages render the full send stack in FIFO order
- Manual queued sends appear before future auto-step messages in the same stack
- Each queued message is shown as its own stacked row with full wrapped text
- When `awaitingPrompt=true`, hint text appears: queued messages will send automatically when agent is ready
- Hidden when queue is empty and not awaiting prompt

### S3: Message section

- Textarea for sending messages when session accepts input
- Microphone button appears in the top-right corner of the textarea only when local voice input is available on the host
- First microphone click starts recording; button switches to stop state
- Second microphone click stops recording, transcribes, and inserts text directly into the textarea (no confirmation popup)
- On mobile/PWA, stopping a non-empty recording still inserts the transcription instead of showing a spurious "captured no audio" error
- During transcription the mic button shows a red spinning loader
- History icon button sits before the send actions, opens the last five saved messages for that textarea, and each entry shows its saved timestamp
- If stop/transcribe/insert fails or no audio was captured, an inline red error message appears instead of failing silently
- Retryable transcription failures retry automatically up to three attempts; if all attempts fail, the final inline error names the exhausted retry count instead of failing silently
- If microphone startup is blocked by browser permission or insecure context, an inline red error message explains whether to allow microphone access or switch to HTTPS/localhost
- Ctrl/Cmd+Enter submits
- `Queue` button adds the message to the queued stack and is the default composer action
- `Send now` button bypasses the queue and sends immediately
- Ctrl/Cmd+Enter triggers the queued send path
- `Queue` and `Send now` buttons are disabled when empty (no text and no attachments) or action in progress
- "Not accepting input" message when session cannot receive input
- Cmd+V paste with image on clipboard adds thumbnail preview below textarea
- Drag-and-drop image file onto textarea adds thumbnail preview
- Non-image files in paste/drop are silently ignored
- Each thumbnail has a remove button visible on hover
- Both `Queue` and `Send now` are enabled when attachments are present even with empty text
- Attachments and text cleared after successful send

### S4: Links section

- Shows when session has links
- Each link clickable, opens in new tab

### S4b: Artifacts section

- Shows when session has persisted artifacts
- Artifacts render as compact cards in a responsive grid, not as stacked full-width rows
- Image and video cards show media thumbnails plus hover/focus overlay actions for preview and download
- Clicking preview opens a full-screen artifact lightbox with close and download actions
- Non-media artifacts render as file tiles with extension badge and download action only
- Download links proxy through `/api/sessions/:id/artifacts/:artifactId`

### S5: Runtime sidebar

- Key-value pairs: Created, Last activity, Worktree, Agent runtime, Workspace
- Worktree path in bordered box
- Error shown in red box when present

### S6: Terminal modal (dashboard + detail page)

- Terminal button opens the shared full-screen terminal overlay from both dashboard and detail page
- ✕ closes overlay
- Open/close always syncs `terminal=<session-id>` in query params
- Reload restores terminal overlay from query on both pages when attachable
- Back/forward navigation replays terminal open/close state from query
- DirectTerminal component renders inside
- Bottom control bar uses black terminal surface styling, not elevated gray
- Control bar shows `...` shortcuts menu, `ENTER`, arrow buttons, and microphone button (when voice available) with bordered square button styling
- There is no standalone `ESC` button in the control bar; `Esc` lives inside the `...` menu
- `...` opens an agent-specific shortcuts menu (`claude` or `codex`) that always includes `Slash`, `Esc`, and `Shift+Tab`; clicking an item sends the matching control sequence or slash command into the terminal and closes the menu
- Microphone button appears after arrow keys with a small gap; click starts recording, second click stops and opens a confirmation popup to review text before typing it into the terminal
- Confirming terminal voice input submits immediately without an extra manual keypress: for both `claude` and `codex` the reviewed text is sent as a bracketed paste (`ESC[200~`…`ESC[201~`) followed by a separate `Enter`, so the agent never receives an embedded `\r` that would be treated as a newline inside the input
- Confirmation popup has a microphone button inside the textarea (bottom-right corner); clicking it starts a new recording that appends transcribed text to the existing draft
- Confirmation popup actions include a history icon button before `Cancel`/`Insert`; it shows the last five inserted terminal drafts with timestamps and restores the selected draft into the popup textarea
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
- `isolated-ui` sidecar shows an `Open` link when session links include `sidecar-ui`
- When a sidecar row has multiple actions, the play/stop icon stays as the rightmost action
- Clicking terminal button opens terminal modal for sidecar tmux session
- Clicking play/stop updates the sidecar row state without leaving the page
- No sidecars section shown when sidecars array is empty

## PWA

### P1: App is installable from browser chrome

- `GET /manifest.webmanifest` returns Spur manifest with `name`, `short_name`, `display=standalone`, `start_url=/`, dark `theme_color`, and 192/512 PNG icons
- Browser devtools Application tab shows the manifest without missing required fields
- Chromium shows install/save-app affordance for the dashboard when opened on `localhost`
- Installed window opens on `/` with Spur name/icon instead of a generic browser shortcut
- iOS-sized pass uses the provided Apple icon when saving to home screen
