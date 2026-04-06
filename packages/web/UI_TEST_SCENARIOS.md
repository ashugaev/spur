# Web UI Test Scenarios

Browser-based test scenarios for the Spur web dashboard.
Run against a live daemon with `SPUR_DAEMON_URL` set.
When testing behind a reverse proxy, ensure `/api/runtime/terminal` returns the externally reachable proxy port.

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

### D4: Terminal button state

- Sessions with `runtimeAlive=true` + `tmuxSession` + `status!=completed|killed`: button enabled (visible border, secondary text color)
- Sessions with `runtimeAlive=false` OR no `tmuxSession`: button disabled (transparent border, 25% opacity, cursor-not-allowed)
- Disabled button does NOT open terminal modal on click
- Enabled button opens terminal modal on click

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

### D6b: Footer clock hydrates cleanly

- Footer clock area renders without Next.js recoverable hydration error overlay
- Initial footer clock value may briefly show a deterministic placeholder before client time appears
- Footer clock updates to local time after hydration

### D7: Spawn modal

- SPAWN_NEW_SESSION button opens centered modal
- Modal has: project select, agent select, branch input, workspace select, plan checkbox, steps list, multiline textarea, Spawn button
- Branch input: placeholder "branch name", optional
- Workspace select: Default / Worktree / Shared options
- When Worktree selected: base branch input appears with placeholder "base branch (defaults to project default)"
- Plan checkbox: labeled "PLAN", toggles plan mode
- Steps: "+ STEP" button adds step inputs, each with remove (✕) button, scrollable at 4+ steps
- Enter in textarea creates newline (not submit)
- Ctrl/Cmd+Enter submits
- Click outside modal (backdrop) closes it
- ✕ button closes modal
- Spawn button disabled when project or prompt empty
- All new fields reset on successful spawn

## Session Detail

### S1: Header with white underline

- Back link to dashboard
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
- All buttons uppercase, bold, disabled when action in progress
- Kill shows confirm dialog

### S3: Message section

- Textarea for sending messages when session accepts input
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

### S6: Terminal modal (detail page)

- Terminal button opens full-screen terminal overlay
- ✕ closes overlay
- DirectTerminal component renders inside
- Mouse wheel scrolling stays within the terminal (does not scroll the page behind the modal)
- Terminal scrollback works like a native terminal (scroll up/down through history)

## Responsive

### R1: Mobile (<640px)

- Header is split into 3 rows in order:
- Row 1: logo + project title
- Row 2: Needs Input / Working / Waiting stats
- Row 3: search input + project filter + Spawn Session button
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

## PWA

### P1: App is installable from browser chrome

- `GET /manifest.webmanifest` returns Spur manifest with `name`, `short_name`, `display=standalone`, `start_url=/`, dark `theme_color`, and 192/512 PNG icons
- Browser devtools Application tab shows the manifest without missing required fields
- Chromium shows install/save-app affordance for the dashboard when opened on `localhost`
- Installed window opens on `/` with Spur name/icon instead of a generic browser shortcut
- iOS-sized pass uses the provided Apple icon when saving to home screen
