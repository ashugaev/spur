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

- 𖤓 icon + project title visible
- Project filter dropdown with "All projects" default
- SPAWN_NEW_SESSION button visible

### D2: Header stats show correct counts

- Needs Input, Working, Waiting stat buttons in header after title, before search input
- Labels use secondary text color, values use primary
- Non-zero values show colored (error/working/attention)
- Clicking a stat button filters sessions to that attention level; clicking again clears filter

### D3: Session rows render with correct columns

- Each row: activity dot, project (hidden <sm), agent (hidden <md), title link, tracker/PR links (hidden <sm), branch (hidden <lg), time, terminal button
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

- 5 sections: RESPOND, REVIEW, PENDING, WORKING, DONE
- Each has colored dot + uppercase label + divider line + count
- Empty sections show count "0", no "No sessions" message
- Sessions sorted into correct sections by attention level

### D6b: Footer build version

- Footer right side shows a build version string in `YYYYMMDD.HHmmss` format (UTC)
- Version is static (no ticking), set at build time
- Falls back to `dev` in development when no build version is injected

### D6c: Footer resource metrics

- On Linux hosts with available runtime metrics, footer left side shows `CPU <n>%`, `RAM <n>%`, `DISK <n>%` in uppercase compact format
- On unsupported hosts (macOS/Windows) or when runtime metrics source is unavailable, footer resource metrics are hidden with no red/error UI

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
- Click starts recording, second click stops and inserts transcribed text directly into textarea (no confirmation popup)
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
- All new fields reset on successful spawn

### D7b: Silent branch preflight

- When project and prompt are set, preflight runs silently in the background (500ms debounce)
- On success: branch input is auto-populated with the suggested branch name
- On failure or no suggestion: branch field stays unchanged (no error shown)
- User can still manually edit the branch field after auto-population

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

### S3: Message section

- Textarea for sending messages when session accepts input
- Microphone button appears in the top-right corner of the textarea only when local voice input is available on the host
- First microphone click starts recording; button switches to stop state
- Second microphone click stops recording, transcribes, and inserts text directly into the textarea (no confirmation popup)
- During transcription the mic button shows a red spinning loader
- If stop/transcribe/insert fails or no audio was captured, an inline red error message appears instead of failing silently
- If microphone startup is blocked by browser permission or insecure context, an inline red error message explains whether to allow microphone access or switch to HTTPS/localhost
- Ctrl/Cmd+Enter submits
- Send button disabled when empty (no text and no attachments) or action in progress
- "Not accepting input" message when session cannot receive input
- Cmd+V paste with image on clipboard adds thumbnail preview below textarea
- Drag-and-drop image file onto textarea adds thumbnail preview
- Non-image files in paste/drop are silently ignored
- Each thumbnail has a remove button visible on hover
- Send button enabled when attachments are present even with empty text
- Attachments and text cleared after successful send

### S4: Links section

- Shows when session has links
- Each link clickable, opens in new tab

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
- Confirming terminal voice input submits immediately without an extra manual keypress: `claude` types the reviewed text and sends `Enter`, while `codex` sends the reviewed text as bracketed paste and then a separate `Enter`
- Confirmation popup has a microphone button inside the textarea (bottom-right corner); clicking it starts a new recording that appends transcribed text to the existing draft
- While recording or transcribing inside the popup, the Insert button is disabled and a status hint appears below the textarea
- Cancelling or closing the confirmation popup while recording stops the recording without a spurious error
- Terminal is the only place that uses a confirmation popup for voice input; spawn and session message insert directly
- If terminal voice insert fails, the confirmation popup stays open and a visible red error message appears above the terminal controls
- Helper textarea remains focused for keyboard input but has no visible browser caret/artifacts
- Mouse wheel scrolling stays within the terminal (does not scroll the page behind the modal)
- Terminal scrollback works like a native terminal (scroll up/down through history)
- On touch devices, dragging the terminal content up/down scrolls in the same visual direction as a native terminal scrollback
- After switching tabs away or locking/unlocking the screen, the terminal reconnects without reopening the modal or reloading the page
- During reconnect, the header status changes from `Connected` to a reconnecting message and returns to `Connected` once the stream resumes

## Responsive

### R1: Mobile (<640px)

- Header is split into 3 rows in order:
- Row 1: logo + project title
- Row 2: Needs Input / Working / Waiting stats
- Row 3: search input + project filter + Spawn Session button
- Focusing any text input, textarea, or select does not trigger iPhone Safari auto-zoom
- No horizontal page scroll (`document.documentElement.scrollWidth <= window.innerWidth`)
- Session rows: project column hidden, only dot + title + time + terminal btn
- Attention zones use accordion (tap to expand/collapse)

### R2: Tablet (640-1024px)

- Header horizontal
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
- Terminal button visible only when sidecar is alive and session is attachable
- `isolated-ui` sidecar shows an `Open` link when session links include `sidecar-ui`
- Clicking terminal button opens terminal modal for sidecar tmux session
- No sidecars section shown when sidecars array is empty

## PWA

### P1: App is installable from browser chrome

- `GET /manifest.webmanifest` returns Spur manifest with `name`, `short_name`, `display=standalone`, `start_url=/`, dark `theme_color`, and 192/512 PNG icons
- Browser devtools Application tab shows the manifest without missing required fields
- Chromium shows install/save-app affordance for the dashboard when opened on `localhost`
- Installed window opens on `/` with Spur name/icon instead of a generic browser shortcut
- iOS-sized pass uses the provided Apple icon when saving to home screen
