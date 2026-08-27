# Web terminal

The terminal toolbar lists visible `HTTP` and `HTTPS` links discovered in the newest 100 rows of terminal output. A discovered link stays listed after its row leaves that window; past 100 links, the oldest discovery not currently on screen is dropped first, so the list can briefly exceed 100 by the number of links still visible, but never drops one still on screen.

The link control stays hidden until a link has been discovered. Its count includes each exact URL once. Open the control to see the hostname and full URL: the current buffer's links list newest-first, then earlier discoveries in discovery order. The list clears on a session change and on a terminal buffer switch, never on a resize.

Switching between the normal and alternate terminal buffers replaces the list with links from the active buffer. Returning to the normal buffer restores links still present there. A full-screen program running inside a tmux pane does not switch the terminal's own buffer, so links discovered before it started stay listed.

Selecting a link opens its exact URL in an isolated new tab.
