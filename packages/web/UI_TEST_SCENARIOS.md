# Web UI Test Scenarios

Browser-based test scenarios for the Spur web dashboard.
Run against a live daemon with `SPUR_DAEMON_URL` set.

## Dashboard

### D1: Header renders correctly

- 𖤓 icon + "FLEET OVERVIEW" title visible
- Project filter dropdown with "All projects" default
- SPAWN_NEW_SESSION button visible

### D2: Stats bar shows correct counts

- TOTAL, INPUT, REVIEW, PENDING, WORKING labels visible with values
- Labels use secondary text color (#A1A1A1), values use primary (#E1E1E1)
- Non-zero INPUT/REVIEW/PENDING/WORKING values show colored
- "Online" indicator with green dot on right (hidden on mobile)

### D3: Session rows render with correct columns

- Each row: activity dot, project (hidden <sm), agent (hidden <md), title link, tracker/PR links (hidden <sm), branch (hidden <lg), time, terminal button
- All rows aligned — terminal button column is uniform width

### D4: Terminal button state

- Sessions with `runtimeAlive=true` + `tmuxSession` + `status!=completed|killed`: button enabled (visible border, secondary text color)
- Sessions with `runtimeAlive=false` OR no `tmuxSession`: button disabled (transparent border, 25% opacity, cursor-not-allowed)
- Disabled button does NOT open terminal modal on click
- Enabled button opens terminal modal on click

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

### D7: Spawn modal

- SPAWN_NEW_SESSION button opens centered modal
- Modal has: project select, agent select, multiline textarea, Spawn button
- Enter in textarea creates newline (not submit)
- Ctrl/Cmd+Enter submits
- Click outside modal (backdrop) closes it
- ✕ button closes modal
- Spawn button disabled when project or prompt empty

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
- Send button disabled when empty or action in progress
- "Not accepting input" message when session cannot receive input

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

- Header stacks vertically (title above controls)
- Stats bar wraps, status indicator hidden
- Session rows: project column hidden, only dot + title + time + terminal btn
- Attention zones use accordion (tap to expand/collapse)

### R2: Tablet (640-1024px)

- Header horizontal
- Agent column appears at md (768px)
- Branch column appears at lg (1024px)
- Tracker/PR links appear at sm (640px)

### R3: Desktop (>1024px)

- Full layout: all columns visible
- Stats bar single line with status indicator
