# Web terminal

The terminal toolbar lists visible `HTTP` and `HTTPS` links from the newest 100 rows of terminal output.

The link control stays hidden until the active terminal buffer contains a link. Its count includes each exact URL once, ordered by newest occurrence. Open the control to see the hostname and full URL.

Switching between the normal and alternate terminal buffers replaces the list with links from the active buffer. Returning to the normal buffer restores links still present there.

Selecting a link opens its exact URL in an isolated new tab.
