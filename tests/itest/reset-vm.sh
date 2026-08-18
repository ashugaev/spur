#!/usr/bin/env bash
# Reset a persistent Spur install-test VM to a pre-install state.
# Runs ON the VM, over plain SSH. Needs no cloud CLI.
# Removes everything the tested install creates; keeps the planted agents,
# their credentials, and the ssh key.
# Never touches ~/.local/bin/cursor-agent or ~/.local/share/cursor-agent —
# same ~/.local prefix the tested install uses, verified against this list.
set -uo pipefail

log() { printf 'reset: %s\n' "$1"; }

log "stopping units"
systemctl --user stop spur-web spur-daemon 2>/dev/null
systemctl --user disable spur-web spur-daemon 2>/dev/null
rm -f "$HOME"/.config/systemd/user/spur-*.service
rm -f "$HOME"/.config/systemd/user/default.target.wants/spur-*.service
systemctl --user daemon-reload 2>/dev/null
loginctl disable-linger "$USER" 2>/dev/null

log "killing leftover spur processes and tmux servers"
pkill -f 'spur/dist/cli.js' 2>/dev/null
pkill -f 'web-server.js' 2>/dev/null
tmux ls 2>/dev/null | cut -d: -f1 | while read -r s; do tmux kill-session -t "$s" 2>/dev/null; done

log "removing spur package, data, npm pin"
rm -rf "$HOME/.local/lib/node_modules/@shugaev" "$HOME/.spur" "$HOME/.npmrc"
rm -f "$HOME/.local/bin/spur" "$HOME"/.local/bin/spur-*

log "removing agent CLIs installed by the test"
rm -rf "$HOME/.local/lib/node_modules/@anthropic-ai" "$HOME/.local/lib/node_modules/@openai"
rm -f "$HOME/.local/bin/claude" "$HOME/.local/bin/codex"

log "removing node and tailscale"
sudo apt-get remove -y nodejs >/dev/null 2>&1
sudo rm -f /etc/apt/sources.list.d/nodesource.list
sudo apt-get remove --purge -y tailscale >/dev/null 2>&1
sudo rm -rf /var/lib/tailscale

log "clearing run artifacts"
rm -f /tmp/agent-run.jsonl /tmp/agent-run.done /tmp/prompt.txt
rm -rf "$HOME/.cursor/projects" "$HOME/.claude/projects" "$HOME/.claude/todos"
rm -rf "$HOME/spur-docs"

log "state after reset"
for b in node npm spur claude codex tailscale; do
  printf '  %-10s %s\n' "$b" "$(command -v "$b" || echo absent)"
done
printf '  %-10s %s\n' "~/.spur" "$([ -e "$HOME/.spur" ] && echo present || echo absent)"
printf '  %-10s %s\n' "units" "$(systemctl --user list-unit-files 'spur*' --no-legend 2>/dev/null | wc -l)"
printf '  %-10s %s\n' "agents" "$(command -v cursor-agent >/dev/null && echo cursor-agent || echo none)"
log "done"
