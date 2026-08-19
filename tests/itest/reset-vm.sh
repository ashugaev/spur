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
sudo rm -f /etc/apt/sources.list.d/nodesource.sources
sudo rm -f /usr/share/keyrings/nodesource.gpg
sudo rm -f /etc/apt/preferences.d/nodejs
sudo rm -f /etc/apt/preferences.d/nsolid
sudo apt-get remove --purge -y tailscale >/dev/null 2>&1
sudo rm -rf /var/lib/tailscale
sudo rm -f /etc/apt/sources.list.d/tailscale.list

log "removing nvm and the PATH lines the install doc tells the agent to add"
rm -rf "$HOME/.nvm"
for f in "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$f" ] && sed -i -e '/NVM_DIR/d' -e '/nvm\.sh/d' -e '/nvm bash_completion/d' -e '/\.local\/bin/d' "$f"
done

# ~/.claude/.credentials.json stays — the planted harness Claude runs `-p`
# print mode only, verified working while authenticated but never onboarded.
# Do not purge it to "fix" onboarding; that state is load-bearing here, not
# a leftover. See docs/install-from-npm.md onboarding note for the trap this
# avoids in interactive use.
log "removing claude onboarding state"
rm -f "$HOME/.claude.json"

log "clearing run artifacts"
rm -f /tmp/agent-run.jsonl /tmp/agent-run.done /tmp/prompt.txt
rm -rf "$HOME/.cursor/projects" "$HOME/.claude/projects" "$HOME/.claude/todos"
rm -rf "$HOME/spur-docs"

# Assert on the paths this script removes, not on PATH lookup: `bash
# ~/itest-reset.sh` over ssh sources no profile, so `command -v node` reports
# absent for an nvm-installed node whose files (and PATH lines) are still
# there — a dirty box would read as clean. Probe both systemd unit scopes
# too; `systemctl --user` alone reads 0 when the user manager is unreachable
# and never sees /etc/systemd/system (v2/src/host-install.ts:171).
log "state after reset"
printf '  %-14s %s\n' "node-apt"      "$(dpkg -s nodejs >/dev/null 2>&1 && echo present || echo absent)"
printf '  %-14s %s\n' "node-nvm"      "$([ -e "$HOME/.nvm" ] && echo present || echo absent)"
printf '  %-14s %s\n' "spur"          "$([ -e "$HOME/.local/lib/node_modules/@shugaev" ] && echo present || echo absent)"
printf '  %-14s %s\n' "~/.spur"       "$([ -e "$HOME/.spur" ] && echo present || echo absent)"
printf '  %-14s %s\n' "claude"        "$([ -e "$HOME/.local/bin/claude" ] && echo present || echo absent)"
printf '  %-14s %s\n' "codex"         "$([ -e "$HOME/.local/bin/codex" ] && echo present || echo absent)"
printf '  %-14s %s\n' "tailscale"     "$(dpkg -s tailscale >/dev/null 2>&1 && echo present || echo absent)"
printf '  %-14s %s\n' "units-user"    "$(ls "$HOME"/.config/systemd/user/spur-*.service 2>/dev/null | wc -l)"
printf '  %-14s %s\n' "units-system"  "$(ls /etc/systemd/system/spur-*.service 2>/dev/null | wc -l)"
apt_leftover=$(ls /etc/apt/sources.list.d/nodesource.* /etc/apt/sources.list.d/tailscale.list 2>/dev/null | tr '\n' ' ')
printf '  %-14s %s\n' "apt-repos"     "$([ -n "$apt_leftover" ] && echo "leftover: $apt_leftover" || echo clean)"
profile_leftover=$(grep -l 'NVM_DIR\|\.local/bin' "$HOME/.bashrc" "$HOME/.profile" 2>/dev/null | tr '\n' ' ')
printf '  %-14s %s\n' "profile-lines" "$([ -n "$profile_leftover" ] && echo "leftover: $profile_leftover" || echo clean)"
printf '  %-14s %s\n' "agents"        "$([ -e "$HOME/.local/bin/cursor-agent" ] && echo cursor-agent || echo none)"
log "done"
