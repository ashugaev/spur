# Web UI Test Scenarios

Browser-based test scenarios for the Spur web dashboard.
Run against a live daemon backed by the active global Spur instance config (`~/.spur/config.yaml` by default).
The terminal WebSocket is same-origin at `/ws`; any reverse proxy that forwards `/` covers it with no extra config.
Coverage means scenario coverage, not numeric line coverage. `tests/scenario-coverage.json` maps each scenario bullet here to the executable CI test tier that owns it.

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
- `voice.provider=openai_compatible`: requires `voice.baseUrl`, `voice.apiKey`, and the env var named by `voice.apiKey` set in `~/.spur/.env` (or `process.env`); `voice.model` is the vendor's model id (e.g. `whisper-large-v3-turbo` for Groq).
- `voice.provider=openai_realtime`: requires `OPENAI_API_KEY` in `~/.spur/.env`; `voice.model` is the realtime transcription model (`gpt-4o-transcribe`, the current flagship — supports `server_vad`, so a final transcript is emitted per utterance; the legacy `gpt-realtime-whisper` rejects turn detection and never finalizes). The status endpoint adds `realtime: true`; the browser mints an ephemeral `transcription` session token via `POST /api/runtime/voice/realtime-token` and streams live partials over WebRTC (`/v1/realtime/calls`). Live mic to partial transcription is manual-only (real browser WebRTC + mic).

Language is configured in `~/.spur/config.yaml` under `voice.language` (default: `auto`).

## Dashboard

### D1: Header renders correctly

- 𖤓 icon + large project title visible at the same size as before
- Browser tab title is exactly `Spur`
- Project selection happens in the clickable title control with "All Projects" default and a visible chevron indicator beside the title
- Ctrl+F / Command+F on the dashboard focuses and selects the existing search input, but not from other editable controls or while a dashboard modal is open
- Split spawn control visible: Shepherd icon button + Spawn Session button

### D2: Header stats show correct counts

- Errors, Rate Limited, Needs Input, Working, Waiting, Stopped, Completed stat buttons in header after title, before search input; Errors and Rate Limited are hidden when their counts are zero
- Labels use secondary text color, values use primary
- Non-zero values show colored (error/attention/error/working/attention/muted-grey/ready)
- Clicking a stat button filters sessions to that attention level; clicking again clears filter
- `Errors` groups errored sessions, sessions with `state: error`, and stopped sessions with an explicit error; `Rate Limited` groups sessions with `state: rate_limited` (ranked directly under Errors); `Needs Input` excludes those technical errors
- `Stopped` groups manually paused/stopped sessions without error evidence
- Clicking `Completed` switches the dashboard into completed-only view: current sessions are hidden and only the `Completed` zone remains
- `Completed` stays neutral/white while inactive, even when completed sessions exist; it turns green only when the `Completed` filter is active and the count is non-zero
- After a session moves into a done/terminal state on the next poll, the `Completed` stat count updates and the session reappears only when the `Completed` filter is active
- When the active filters produce zero visible sessions, show the empty placeholder instead of a blank area
- When only completed sessions exist, the default empty placeholder stays neutral and does not show a guide hint about toggling `Completed`
- Filtered empty placeholder shows a `Reset Filters` button that clears search, project, and stat filters
- Dashboard search shows a clear button only when it has text; clicking it clears the query and returns focus to search
- Dashboard search shows the voice shortcut placeholder and microphone control when local voice input is available
- Dashboard search shows inline voice recording errors without covering the search or spawn controls
- Switching the dashboard project filter updates the visible rows and `?project=` URL without triggering a new `/api/sessions` fetch
- A tag filter control appears in the header only when at least one tag in the catalog is applied to a session in the current project scope; a configured tag that no visible session carries is omitted from the filter entirely (control and dropdown)
- The tag filter is multi-select: picking a tag toggles its membership without closing the popover, so a session stays visible when it carries any selected tag (OR), and deselecting a tag narrows the list back down; `All tags` clears the whole selection and closes the popover
- The full selection persists as a JSON array in `localStorage` (`spur:tag-filters`) and auto-applies every stored tag on reload; a legacy single-tag `spur:tag-filter` value migrates to a one-element selection and the old key is dropped, and a stored tag that is whitespace-only or missing from the catalog is dropped from the selection once the catalog loads
- The filter has no color dot: the closed trigger stands out with an accent border only when tags are selected and shows one selected tag name, both names when two are selected, or `N tags` beyond that (filter icon + `Tags` when nothing is selected), and each open-menu item renders the tag as the same styled chip used on session cards (bordered, color-tinted, no dot) with a checkmark on selected rows

### D3: Session rows render with correct columns

- Each row: activity dot, project (hidden <sm), agent (hidden <md), title link, tags (hidden <sm), tracker/PR links (hidden <sm), branch (hidden <lg), time, trailing action button
- Sessions with running sidecars show a compact green marker before the title link; clicking it opens the exact running sidecar names, and names with available URLs are links while names without URLs stay plain text
- Sessions with a one-shot, interval, or daily wake show a compact clock marker before the title link; clicking it opens timer details and identifies the wake type
- When a row has both wake and running sidecar markers, opening one row panel closes the other so panels do not overlap
- Project filter menu opens from the title, exposes the current project in its accessible name, shows a small left-side chevron indicator so it reads as a select, visibly marks the selected option, uses a visible light hover treatment on options, keeps All Projects and project option left edges aligned, keeps Shepherd at the top with its built-in label inside the option, supports switching configured projects, edit buttons for project settings, and a bottom `+ New project` action
- Project settings modal is a named dialog and deletes/disconnects through an in-app confirmation panel, not a browser confirm
- Rows with unopened `Needs Input` attention render the title in a brighter tone than once-viewed `Needs Input` rows; opening the session detail or terminal dims it, and any new hook event re-brightens it. Other states (`working`, `idle`, `waiting`, `stopped`, `error`) are unaffected by viewed state.
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
- Restorable Stopped and Errors sessions show a restore icon in the row action slot instead of a disabled terminal icon
- Clicking restore posts to `/api/sessions/<id>/restore`; success refetches sessions and failure leaves the row visible with persistent dismissible error toasts that stack within the mobile viewport
- Sessions with an open PR that GitHub reports as mergeable: merge icon button replaces terminal button in the dashboard list only
- Clicking the merge icon calls the web merge API and, on success, the row flips into the merged-PR done-button state without waiting for a full reload

### D4b: Merged-PR done button

- Sessions with merged PR + completable status: checkmark icon button replaces terminal button
- Checkmark button same size (h-6 w-6) as terminal button
- Hover: green border + text (`--color-status-ready`)
- Click: row moves to Completed/hidden immediately through dashboard cache, complete API runs, sessions refetch in background
- If the row has active same-checkout subagents, click shows a confirmation naming how many subagents will be ended
- Confirming sends `POST /api/sessions/<id>/complete` with `{ "scope": "desk" }` and completes all active same-checkout agents
- On error: button re-enables
- If daemon returns open pull request action required, row rolls back and modal offers Leave Pull Request Open, Close Pull Request, and Cancel; choosing an action retries completion with that action
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
- When a PR has a merge conflict (`mergeConflict === true`), a red git-merge/branch badge (`aria-label="Merge conflict"`) shows in the PR badge row next to the CI/review mark; it is absent when `mergeConflict === false`
- Stale/missing PR status payloads keep the PR link visible and do not change the footer GitHub connection indicator
- Soft PR status errors stay local to the PR UI and do not replace the footer GitHub connection indicator
- Both open in new tab on click
- Sessions without links: no icons shown, no empty space

### D5b: PR status survives reload and GitHub errors

- After PR badges (state color, CI dot, review thread count) populate, a full page reload renders the same badges immediately from `localStorage` (`spur:pr-status-cache:v1`) before any network response — no flash of empty badges
- When GitHub responds with an error after a previous successful fetch, the badge keeps the last known state and the footer `Git Error` badge appears alongside it; badges do not reset to empty
- A first-ever load with GitHub down shows empty badges plus the `Git Error` footer; subsequent successful fetches replace empty badges with real values

### D5c: Process tags

- Dashboard rows render applied tags as small overlapping colored dots — one dot per applied tag filled with its catalog color via inline style — and collapse any tags beyond the four-dot cap into a `+N` overflow indicator
- The dot cluster is hidden below the `sm` breakpoint on the dense dashboard row (`hidden sm:inline-flex`), while the detail-view chips variant stays visible at all widths
- When a row has no applied tags a subtle add affordance is shown so tags can still be added
- Clicking the dot cluster opens a popover that lists the applied tags as full-name color chips — each with an `×` that POSTs `{ remove: [name] }` to `/api/sessions/<id>/tags` — plus an add section of the unapplied catalog tags where choosing one POSTs `{ add: [name] }`
- The agent detail view renders applied tags as full-name color chips in the metadata row and manages them through the same popover; its add and remove actions POST to `/api/sessions/<id>/tags`, refreshing the session on success and showing an error toast on failure
- An unknown tag name is rejected by the daemon with the list of available tags

### D6: Attention zone sections

- Default dashboard view shows active sections only: ERRORS, RATE LIMITED, NEEDS INPUT, WAITING, WORKING, STOPPED (RATE LIMITED ranks directly under ERRORS)
- `Completed` toggle reveals the COMPLETED section and hides current-session sections
- Each has colored dot + uppercase label + divider line + count
- On mobile first render, `Stopped` starts collapsed by default when no saved `spur:mobile-collapsed-categories` override exists; the header and count stay visible and tapping the section expands/collapses rows normally
- Empty sections are hidden instead of rendering placeholder rows
- Sessions sorted into correct sections by attention level

### D6b: Footer

- Footer is visible after page load
- Footer right side shows the running daemon version fetched from `/api/runtime/info`, or `dev` when the daemon is unreachable
- Footer left side shows Online status when daemon is reachable
- Footer shows separate GitHub and GitLab connection indicators that are independent from PR status rows
- Platform connection indicators stay icon-only on the footer bar: platform icon + status icon, with no inline text label or inline error string
- Before the first platform health response resolves, the footer shows a neutral icon-only checking state for that platform
- Healthy platform status renders as a healthy status icon next to the GitHub or GitLab icon
- Hovering, focusing, or clicking/tapping a platform indicator shows a tooltip with the platform name, text status, and the last request timestamp
- Clicking/tapping a healthy platform indicator pins the tooltip open until the next click or an outside tap closes it
- Platform connection/auth/API failures render the error text inside the tooltip, not directly in the footer bar
- Non-200 `/api/github-status` and `/api/gitlab-status` responses fall back to `<Platform> status unavailable (<status>)` in the tooltip
- Footer right side shows a Claude accounts trigger next to the version menu with a count of authenticated accounts
- Opening the Claude accounts menu lists each account by label (or short id) with a ready/not-logged-in badge and a per-account Remove action
- Adding an account posts to `/api/claude-accounts/add` and opens the login terminal on the returned tmux session; closing it finishes login and polling `/api/claude-accounts/:id/login-status` auto-closes once the account authenticates

### D6c: Footer resource metrics

- Footer left side shows an aggregated system health trigger that is both hoverable and clickable, with the label synced to the current health state (`HEALTHY`, `WARNING`, `CRITICAL`, `UNAVAILABLE`)
- Opening the `HEALTHY` tooltip shows `Daemon`, `CPU`, `RAM`, and `HDD` rows with dot indicators
- `CPU` and `RAM` rows turn attention/yellow at or above the threshold; `HDD` turns error/red at or above the threshold
- Clicking inside the system health tooltip closes it
- On touch devices, tapping anywhere outside the open system health tooltip closes it
- On desktop, hover opens the system health tooltip and mouse leave closes it
- When runtime metrics are unavailable, the footer stays compact and the tooltip shows `unavailable` values instead of inline error chrome
- GitHub connection status stays outside the `HEALTHY` tooltip

### D6d: Version switch

- Clicking a release's `Switch` action in the version menu shows a full-screen blocking overlay (`data-testid="version-switch-overlay"`, `role="alertdialog"`) with no dismiss controls while the daemon restarts
- The overlay polls `/api/runtime/info` every 3s (up to 30 attempts, ~90s) until the daemon reports the target version, then reloads the page exactly once
- If the daemon never reports the target version within the poll window, the overlay switches to a failure state with `Reload now` and `Dismiss` actions instead of auto-reloading
- Dismissing the failed overlay returns to the normal dashboard without reloading; the footer version-menu status banner reflects the same failure message
- While a version switch is in flight or has just completed, a stale/failing sessions-load response does not surface a new dashboard error toast

### D7: Spawn modal

- Spawn Session side of the split spawn control opens a centered max-w-lg modal on desktop and tablet and a full-screen edge-to-edge modal without surrounding gap or border on small mobile below the sm breakpoint
- Shepherd icon side of the split spawn control opens the spawn modal with the built-in Shepherd project and `claude` agent selected
- Mobile slash suggestions stay fully inside the viewport without horizontal scrolling; long label, detail, and source text truncates with hover titles
- Slash suggestion favorites persist, move once into a top Favorites group, and keep selection behavior
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
- Clear button appears in the top-right corner when the prompt has text, resets only the prompt, and keeps focus in the textarea
- When voice is available and idle, the prompt textarea placeholder includes `Voice ⌘ + .`
- Click starts recording, the mic slot becomes cancel, and a vertical stop button appears above it to transcribe into the textarea without a confirmation popup
- Clicking cancel discards only the active recording without transcribing or clearing existing textarea text
- If a non-empty spawn recording fails to transcribe, the same textarea chrome swaps the mic for vertical `Play`, `Retry`, and `Discard` controls until transcription succeeds or the user discards the take
- Refreshing the page preserves those retained spawn-recording controls for the same spawn composer
- Saved prompt history selection restores the chosen prompt back into the textarea without spawning immediately
- Enter in textarea creates newline (not submit)
- Cmd+Enter submits
- Cmd+Enter submits from the prompt textarea via the shared modal container keydown handler, with no duplicate textarea-level handler
- Cmd+. toggles voice recording on/off inside the modal
- Prompt textarea placeholder is "Prompt..." without voice support, and appends `Voice ⌘ + .` when voice is available and idle
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
- Spawn modal can enable Self-destruct, show optional conditions, include trimmed `selfDestruct` settings in the request, and reset those fields after successful ack
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

### D7c: Spawn/respawn model picker

- Spawn modal renders the model picker on the same row as the agent select; the model control is a full-width button whose label reads `Default` until a model is chosen
- Respawn modal (session detail) matches the spawn layout: agent select and model picker share a row, model picker sized `min-w-40 flex-1`
- Opening the model picker fetches `/api/models?agent=<agent>` and lists that agent's models plus a top `Default` option
- Switching the agent select resets the pick to `Default` and reloads the model list for the newly selected agent
- Typing in the search input filters the list by model id or label
- Starring a model (favorite icon) pins it to the top of the list, persists to `spur:model-favorites` local storage, and stays pinned after reload
- Favorites are scoped per agent (`<agent>:<id>` key), so a claude favorite does not surface in the codex list
- Selecting a model updates the control label to that model's label; selecting `Default` clears the pick
- If the current pick is absent from a freshly loaded list, the control falls back to `Default`

### D7f: Slash suggestions search

- The slash suggestions dropdown renders a search input pinned above the scrollable list; typing filters suggestions case-insensitively over label, detail, and id, and clearing restores the full list
- Favorited suggestions stay pinned to the top Favorites group within the filtered results

### D7e: Branch name normalization + collision hints

- Typing in the branch input shows a dim "will create {slug}" preview when the normalized form differs from the typed text (e.g. `Test 2` previews `test-2`); input value is not rewritten on each keystroke
- Blurring the branch input rewrites its value to the normalized form in place (e.g. `feature/X Y Z` becomes `feature/x-y-z`)
- A name that normalizes to empty (e.g. `!!!`) clears on blur and Spawn still fires without a `branch` field; Spawn button stays enabled
- When the normalized name exists locally and is not checked out: dim hint "branch already exists — will attach instead of creating new"
- When the normalized name is checked out in another worktree: error box "already checked out in another worktree — spawn will fail; pick a different name" (no server path shown)
- When the normalized name exists only on origin: dim hint "exists on origin — will track it"
- Collision hints never disable the Spawn button; the prior hint clears immediately when the name changes (no stale banner)

### D7d: Sessions list cache on revisit

- After the first Dashboard visit loads sessions, navigating away and back renders the list instantly with no "Loading..." text
- Background refetch on the 5s interval silently replaces the list only when the server response differs

## Session Detail

### S1: Header with white underline

- Back link to dashboard
- If session detail URL has no `project` query, Back returns to `/` so dashboard restores its default filter from local storage
- If session detail URL has `?project=<id>`, Back preserves that explicit dashboard filter
- Missing or deleted sessions replace the loading placeholder with an inline error plus `Retry`
- Session detail action failures show a persistent dismissible error toast; long error text stays internally scrollable, dismissible on mobile, and stacks stay viewport-bounded without blocking page actions outside visible toast boxes
- Missing or deleted session tab title falls back to the decoded session id
- Browser tab title is the task title only, with no `Spur` prefix or suffix
- Project • Agent • Session ID breadcrumb
- Title uppercase bold
- Subtitle (prompt) below
- Copy prompt button appears when the session prompt is non-empty; clicking it copies the full prompt and shows a copied toast
- Activity dot + branch badge + status badges
- One-shot, interval, and daily wakes show the next wake timer directly in the session header and runtime sidebar
- Checkout group links show one status dot per Desk agent, hide killed agents, hide completed agents by default, and reveal completed non-killed agents from the trailing `...` button
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
- If Complete or Kill hits an open pull request guard, shared modal offers Leave Pull Request Open, Close Pull Request, and Cancel; Kill retry keeps the existing force cleanup confirmation
- If Complete or Kill hits a GitHub PR check failure, modal shows the linked pull request and offers Skip PR check & proceed (always), Wait for reset & retry (only when rate limited), and Cancel; Skip resends the same action with skipPrCheck so it proceeds without any GitHub call
- Terminal sessions show an `Edit & Respawn` action that opens a modal with the original first prompt prefilled
- `Edit & Respawn` allows keeping previously attached startup images, adding new images via paste, drop, or picker button, and respawning with image-only input when text is empty
- Worktree sessions show a `Desk agent` action whose modal keeps the current project, session, and workspace fixed while supporting agent, branch, plan, steps, attachments, slash suggestions, history, voice, empty prompt, hotkey submit, and single in-flight spawn
- `Desk agent` action remains visible for stopped/completed sessions and is disabled only when no reusable checkout is available
- Respawn modal footer matches the spawn modal footer: slash suggestions, input history, voice hint, and primary-hotkey submit share one row
- Desk agent modal renders a single footer row with voice hint, slash suggestions, input history, cancel, and primary-hotkey submit
- Respawn saves the submitted prompt to its own input history on success

### S2a: Logs modal

- `Logs` opens a full-screen modal for the current session
- Modal subtitle reads as Spur orchestrator events plus runtime output, not agent chat history
- Empty state shows a bordered placeholder instead of raw empty text
- `session.state.transition` entries render as a dedicated status-transition row with `from -> to`
- Transition rows show the detection source (`jsonl`, `hook`, or `status`) when present
- Transition rows show a `History snapshot` download link only when `historyArtifactId` belongs to the currently visible artifact bucket
- Automatic history snapshots stay hidden in the default Agent view and in Attached, and appear only after switching to the System artifact view
- `session.input.received` entries render as `User input` rows with input kind, text, and attachment names
- Non-transition entries still render in the same stream as generic Spur/runtime events instead of disappearing
- Runtime output entries label the source as `service <id>` or `sidecar <name>` when those details exist

### S2b: Conversation dialog (Claude only)

- Visible only for `agent === "claude"` sessions with conversation messages
- Hidden for codex sessions and when no messages exist
- Section header: "DIALOG" with duration (e.g., "2h 15m") on the right
- Scrollable message list (max-h-80) in bordered surface container
- User messages: right-aligned, accent border/background tint
- Assistant messages: left-aligned, default border, secondary text
- Message bodies render standard markdown directly from stored conversation text, including headings, lists, fenced code, inline code, links, and GFM tables
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
- First microphone click starts recording; the mic slot switches to cancel and shows a vertical stop button above it
- Clicking stop transcribes and inserts text directly into the textarea (no confirmation popup), while clicking cancel discards only the active recording and preserves existing text
- Clear button appears in the top-right corner when the message has text, resets only the message, and keeps attachments intact
- On mobile/PWA, stopping a non-empty recording still inserts the transcription instead of showing a spurious "captured no audio" error
- During transcription the mic button shows a red spinning loader
- History icon button sits before the send actions, opens the last five saved messages for that textarea, and each entry shows its saved timestamp
- `/` button sits with the send actions, opens a suggestion list grouped by Commands / Skills / Agents, and selecting an item inserts its text into the message textarea
- If stop/transcribe/insert fails or no audio was captured, an inline red error message appears instead of failing silently
- Retryable transcription failures retry automatically up to three attempts; if all attempts fail, the final inline error names the exhausted retry count instead of failing silently
- If a non-empty message recording fails to transcribe, the same textarea chrome swaps the mic for vertical `Play`, `Retry`, and `Discard` controls until transcription succeeds or the user discards the take, and the final transcription error stays inline with that composer instead of moving to a page banner
- Refreshing the page preserves those retained message-recording controls for the same session composer
- If microphone startup is blocked by browser permission or insecure context, an inline red error message explains whether to allow microphone access or switch to HTTPS/localhost
- `Queue` button adds the message to the queued stack
- `Send now` button bypasses the queue and sends immediately
- `Queue` button has no inline hotkey hint
- `Send now` button shows inline muted hotkey hint "⌘ + ⏎" on the same line as the label
- Cmd+Enter triggers the immediate send path
- Queue and Send now buttons show a spinning loader icon next to the busy-state label while a send is in flight
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
- Clicking preview opens a full-screen artifact lightbox with title, metadata, copy/download/close header actions, and vertically centered previous/next side buttons in side gutters outside the preview surface
- Lightbox ArrowLeft/ArrowRight, left/right half clicks, pointer drags, and mobile horizontal touch swipes move across all session artifacts in order without wrapping; Escape closes
- Lightbox click and swipe navigation ignores links, controls, videos, text preview selection/scroll areas, and explicitly interactive preview content
- Image lightbox overlays zoom in/out/reset buttons; buttons scale the image, pinch gestures zoom, and dragging pans while zoomed without navigating; reset/zoom-out return to fit and re-enable swipe navigation
- Text lightbox preview fills the surface and scrolls vertically when content overflows
- Non-media artifacts render as file tiles with extension badge, download action, and reachable file preview
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
- Control bar shows `...` shortcuts menu, `Slash`, `ENTER`, one arrow toggle, and microphone button (when voice available) with bordered square button styling
- Terminal control bar does not show a standalone `Voice ⌘ + .` hint before the confirmation popup opens
- There is no standalone `ESC` button in the control bar; `Esc` lives inside the `...` menu
- `...` opens an agent-specific shortcuts menu (`claude`, `codex`, or `cursor`); clicking an item sends the matching control sequence into the terminal and closes the menu
- Every agent's `...` shortcuts menu exposes exactly one `Tab` entry that sends a raw `\t` into the terminal (codex reuses its queue-follow-up Tab; claude and cursor gain a dedicated Tab)
- `Slash` opens a suggestion list grouped by Favorites when present plus Commands / Skills / Agents; favorites persist, move once into Favorites, and selecting an item submits the exact slash text into the terminal as bracketed paste plus a separate `Enter`
- Arrow toggle uses a four-direction icon and opens a transparent vertical stack aligned to the toggle edge with left/up/down/right controls; clicking an arrow sends the matching terminal input and keeps the stack open, while clicking the toggle again closes it
- Microphone button appears after arrow toggle with a small gap; click starts recording. While recording, the footer mic slot becomes cancel, and a transparent vertical stack aligned to it appears above with edit, queue, and stop/send actions
- Stop/send transcribes and submits the result into the terminal immediately without showing the confirmation popup; queue transcribes and adds the result to queued messages; edit stops recording and opens the confirmation popup so the transcript can be edited before insertion; cancel discards only the active recording without transcribing, opening a modal, closing an existing popup, clearing draft text, or showing a no-audio error
- Idle state outside recording shows the single mic button only (no pencil, no stop)
- If a non-empty terminal recording fails to transcribe, the idle control slot shows a vertical compact `Play`, `Retry`, and `Discard` stack for that same terminal context until transcription succeeds or the user discards the take
- Retained terminal recordings survive refresh and retry with the original stop-send vs edit-modal behavior intact
- Confirming terminal voice input submits immediately without an extra manual keypress: for `claude`, `codex`, and `cursor` the reviewed text is sent as a bracketed paste (`ESC[200~`…`ESC[201~`) followed by a separate `Enter`, so the agent never receives an embedded `\r` that would be treated as a newline inside the input
- Confirmation popup has a microphone button inside the textarea (bottom-right corner); clicking it starts a new recording that appends transcribed text to the existing draft
- Confirmation popup has a clear button in the textarea top-right corner when the draft has text
- Confirmation popup has an inline image-picker button matching spawn input; picking, pasting, or dropping images adds compact previews with remove buttons
- Cmd+V image paste inside the main agent terminal opens the confirmation popup with the pasted image preview instead of sending raw clipboard bytes into xterm
- Confirmation popup can insert image-only drafts, and image attachments are sent through the session message API
- Confirmation popup textarea placeholder includes `Voice ⌘ + .` when idle
- Confirmation popup actions include a history icon button before `Cancel`/`Queue`/`Insert`; it shows the last five inserted terminal drafts with timestamps and restores the selected draft into the popup textarea
- Confirmation popup `Queue` adds the reviewed draft to queued messages using the same queue behavior as the session composer
- `Insert` shows inline muted hotkey hint "⌘ + ⏎" and Cmd+Enter confirms the popup
- Cmd+. toggles popup voice recording on/off
- While recording inside the popup, the mic slot switches to cancel and shows a vertical stop button above it
- While recording or transcribing inside the popup, the Insert button is disabled and a status hint appears below the textarea
- Recording cancel inside the confirmation popup stops only the active recording and keeps the popup draft open; closing the popup remains the full close/reset path
- Terminal is the only place that uses a confirmation popup for voice input; spawn and session message insert directly
- If terminal voice insert fails, the confirmation popup stays open and a visible red error message appears above the terminal controls
- Helper textarea remains focused for keyboard input but has no visible browser caret/artifacts
- Mouse wheel scrolling stays within the terminal (does not scroll the page behind the modal)
- Terminal scrollback works like a native terminal (scroll up/down through history)
- On touch devices, dragging the terminal content up/down scrolls in the same visual direction as a native terminal scrollback
- After switching tabs away or locking/unlocking the screen, the terminal stays connected when the websocket remains open
- If the websocket closed while the tab was hidden, returning to the tab reconnects without reopening the modal or reloading the page
- Terminal header shows status dot, title (when available), and close control only; no session id or text status labels
- Status dot reflects websocket connection first, then session activity when connected; color and pulse match the resolved status; tooltip shows the resolved label
- During reconnect, the header status dot pulses attention-colored with reconnect tooltip and returns to connected/activity color once the stream resumes
- If a direct-terminal send fails because the session is rate limited (409), a dedicated toast reads "Message not sent — this session is currently rate limited" in addition to the existing inline error chip

### S7: Display state override

- When `session.state` is terminal (`error`, `killed`, or `stopped`), the header state badge shows that state verbatim even when the Claude JSONL conversation endpoint reports `working`
- A manually paused session now persists `status=stopped` and renders the visible badge text `stopped`, not `paused`
- When `session.state` is active (`working`, `waiting`, `needs_input`), a Claude conversation endpoint reporting `working` still overrides the badge to `working` (fast in-progress signal)
- A newly spawned `spawning` session with a workspace that is not created yet counts under Working, leaves Needs Input at 0, is hidden by the Needs Input filter, and is shown by the Working filter

## Responsive

### R1: Mobile (<640px)

- Header items wrap independently instead of moving as one grouped block
- The project title menu, each stat filter, search input, and split spawn control can all jump to the next line on their own when space runs out
- Focusing any text input, textarea, or select does not trigger iPhone Safari auto-zoom
- No horizontal page scroll (`document.documentElement.scrollWidth <= window.innerWidth`)
- Session rows: project column hidden, only dot + title + time + terminal btn
- Attention zones use accordion (tap to expand/collapse)

### R2: Tablet (640-1024px)

- Header horizontal
- Header controls wrap independently instead of moving as a single block
- Stat filters (`Errors` when present, `Needs Input`, `Working`, `Waiting`, `Completed`) are separate layout items and can wrap one by one before labels collapse into the compact icon-only state
- Before stat labels collapse into the compact icon-only state, the split spawn control drops below search first on narrower widths
- Agent column appears at md (768px)
- Branch column appears at lg (1024px)
- Tracker/PR links appear at sm (640px)
- Backlog section appears above session zones only when `/api/sessions` includes available backlog items.
- Clicking a backlog item opens the Jira issue; its `Take` button still claims the item.
- Taking a backlog item posts through `/api/backlog/take`, removes the item from the backlog section, and adds the returned spawning session.

### R3: Desktop (>1024px)

- Full layout: all columns visible
- Header stats inline with title

## Sidecar Terminal

### SC1: Sidecar terminal buttons

- Sidecars section visible in session detail sidebar when session has sidecars
- Each sidecar shows a circular status dot and name without `alive`/`offline` text labels
- Reserved sidecar ports render as subtle `:port` labels next to the sidecar name
- Each sidecar shows an icon-only play button when offline and an icon-only stop button when alive
- Busy sidecar start conflicts open a modal with candidate port select plus `Clear/Retry`
- Terminal button visible only when sidecar is alive and session is attachable
- Any sidecar whose name matches a session slot link label renders an `Open` link when alive
- When a sidecar row has multiple actions, the play/stop icon stays as the rightmost action
- Clicking terminal button opens terminal modal for sidecar tmux session
- Terminal header shows `session.title` from slots title when available, with sidecar suffix appended on sidecar terminals
- Terminal header shows status dot, title (when available), and close control only. Long titles clamp to two lines via CSS, with desktop header items vertically centered and no overlap or horizontal scroll.
- Clicking play/stop updates the sidecar row state without leaving the page
- No sidecars section shown when sidecars array is empty

## PWA

### P1: App is installable from browser chrome

- `GET /manifest.webmanifest` returns Spur manifest with `name`, `short_name`, `display=standalone`, `start_url=/`, dark `theme_color`, and 192/512 PNG icons
- Browser devtools Application tab shows the manifest without missing required fields
- Chromium shows install/save-app affordance for the dashboard when opened on `localhost`
- Installed window opens on `/` with Spur name/icon instead of a generic browser shortcut
- iOS-sized pass uses the provided Apple icon when saving to home screen

## API

- `GET /api/sessions/[id]/conversation` proxies the daemon request, returns the conversation payload on success, passes non-ok status through, and returns 502 on network error.
- `DELETE /api/projects/[id]` proxies the daemon delete-project call and surfaces upstream errors.
- `PATCH /api/projects/[id]` proxies unconfigured project edits and surfaces upstream errors.
- `POST /api/projects` returns 201 on a valid body, 400 on invalid JSON, and proxies upstream errors as 502.
- `POST /api/sessions/[id]/send` proxies the daemon request and passes the daemon's status (including 409 rate-limited) through verbatim instead of collapsing every failure to 502.
