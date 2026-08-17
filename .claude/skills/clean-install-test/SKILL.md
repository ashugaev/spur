---
name: clean-install-test
description: Clean-room test of the Spur server install by planting a coding agent on a throwaway cloud VM and having IT install Spur from the docs, single-shot, with no human in the loop. Cron-safe — runs end to end from the skill name alone, reaps stale VMs, opens a PR for any doc fix, reports in-session. Provision a disposable Ubuntu VM, plant a cursor-agent (fallback Claude Code) by copying the operator's credentials (itest-only shortcut), run the agent on the README Install block verbatim, capture the transcript, turn friction into doc fixes, verify services, reap old VMs, delete only on user confirmation.
---

CLEAN INSTALL TEST

A role-play: provision a disposable VM, plant a coding agent on it, act as a non-coding user who hands that agent only the Spur docs, zero hints. Whatever a fresh agent can't do from the docs alone is doc friction to fix — the agent does the install, you observe, analyze, evolve the docs. Goal: a fresh agent, given only the docs, installs Spur single-shot up to the identity gates (agent login, Tailscale login), collected into a final user TODO, not hacked around. Iterate the docs until that holds.

Runs with no prompt beyond the skill name and no human present — see AUTONOMOUS MODE.

GROUND RULES

  - Touch only the VM created this run — never production Spur, the local box, another machine. Lifecycle: reap stale VMs -> create -> plant agent -> run test -> analyze -> evolve docs -> report -> delete on user ok. Ubuntu 24.04 LTS. e2-small is the floor machine, not e2-micro: the planted agent runs ON the box and competes with the install for CPU. e2-micro wedged mid-run on a repeat test — CPU credit exhaustion, not RAM (peaked 686 MB of 955 MB on the pass run) — sshd stopped answering, serial console showed `systemd-networkd: Could not set DHCPv4 address: Connection timed out`, a stop/start did not recover it within 5 min. npm bundle ships the web UI prebuilt, no on-box build. Never open app ports to the internet — default firewall leaves only SSH reachable, leave it.
  - No hard hacking: the planted agent never bypasses an identity/auth step; lacking the user's own account it records a TODO and moves on — never hint it past friction, fix the doc instead. Copying credentials onto the VM (step 3) is an ITEST-ONLY harness shortcut for an unattended run: never outside itest, never between real hosts. Secrets and credentials go to the VM only, piped over SSH stdin, never echoed to logs or chat.
  - A run that finds zero friction is a pass. Report it and stop — never invent a doc edit to justify the cycle.

0 PREREQS (LOCAL BOX)

  A cloud CLI authenticated for create/list/delete/IP only (this repo uses Google Cloud; adapt for others); SSH itself needs none once the key is baked in — on expired auth, ask the user to re-authenticate interactively. A permanent SSH keypair baked into the VM at create time (private key, public key, a metadata file holding one `<user>:<pubkey>` line) — generate once if missing: `ssh-keygen -t ed25519 -f <keypath> -N ''`. A host-local recipe file (e.g. `~/.spur/itest-conn.md`) holding the project/zone/key paths and the current VM name/IP — read it first, a usable VM can already exist. `~/.config/cursor/auth.json` and `~/.claude/.credentials.json` on the operator's box — itest-only, the planted agent runs on them.

1 REAP STALE VMS, THEN PROVISION

Before creating anything, delete `spur-itest-*` instances labelled `ephemeral=true` older than 24 h — an autonomous run has no one to confirm a delete, so this reap is what stops a 3-day cron from piling up paid VMs.

Cheapest region near the user, e2-small floor, Ubuntu 24.04 LTS, key baked in, labelled ephemeral (substitute your project/zone/key file):

  TS=$(date +%Y%m%d-%H%M); ZONE=<zone>
  gcloud compute instances create "spur-itest-$TS" \
    --project=<gcp-project> --zone="$ZONE" --machine-type=e2-small \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --labels=purpose=spur-itest,ephemeral=true \
    --metadata-from-file ssh-keys=<ssh-keys-metadata-file>

Fetch the external IP and record VM name + IP in the recipe. The IP is ephemeral — any stop/start reassigns it; re-fetch and rewrite the recipe after every restart. Confirm the default firewall exposes only SSH; app ports (4310/5555) must not answer from the public IP.

2 CONNECT (CLOUD-CLI-INDEPENDENT)

  ssh -i <keypath> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <user>@<IP> '<cmd>'

3 PLANT THE AGENT (ITEST-ONLY HARNESS) — CURSOR-AGENT PRIMARY, CLAUDE FALLBACK

cursor-agent is self-contained, needs no node, and the box should stay node-free until the tested agent installs node itself — that install is part of what the test measures.

  ssh ... 'curl https://cursor.com/install -fsS | bash'    # lands ~/.local/bin/cursor-agent
  cat ~/.config/cursor/auth.json | ssh ... 'umask 077; mkdir -p ~/.config/cursor; cat > ~/.config/cursor/auth.json'
  ssh ... '~/.local/bin/cursor-agent --list-models'         # pick a weak model; this run used gemini-3.7-flash-high
  ssh ... '~/.local/bin/cursor-agent -p "Reply with exactly one word: authok" --model gemini-3.7-flash-high --force --output-format text'

`--force` is required on every `-p` run — without it the run dies on a directory-trust prompt ("Pass --trust, --yolo, or -f"), not an auth failure. Caveat: cursor pulls the operator's account-level user rules into the planted agent's context — the run is not a pristine blank agent.

Claude fallback, only when cursor-agent is unavailable — needs node:

  ssh ... 'npm config set prefix ~/.npm-global && npm install -g @anthropic-ai/claude-code'
  cat ~/.claude/.credentials.json | ssh ... 'umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json'
  ssh ... 'node -e "const f=require(\"os\").homedir()+\"/.claude/settings.json\";const fs=require(\"fs\");const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};d.skipDangerousModePermissionPrompt=true;d.skipAutoPermissionPrompt=true;fs.writeFileSync(f,JSON.stringify(d,null,2))"'
  ssh ... 'export PATH=$HOME/.npm-global/bin:$PATH; claude -p "Reply with exactly one word: authok" --dangerously-skip-permissions'

Re-testing a box that already ran once: reset it first — see RESET VS RECREATE.

4 RUN THE TEST — README INSTALL BLOCK, SINGLE-SHOT, NO HINTS

The prompt is the Install block of the repo README verbatim — that block is the artifact under test, not a prompt the runner writes. It tells the agent to fetch `raw.githubusercontent.com/<owner>/spur/<ref>/docs/install-from-npm.md`, never a `github.com/.../blob/...` URL — that form returns an empty document under cursor's webFetch. `<ref>` is `main` by default; point it at the PR branch to test an unmerged doc fix. No docs are staged on the VM — the agent fetches this one file over HTTPS; do not tar the repo docs onto the box, the prompt never reads them.

Launch detached from `~` (no CLAUDE.md there), stream-json, poll a done-file. The launch ssh call can hang even after the remote process has detached — never wait on it, verify with a separate ssh call instead:

  ssh ... 'nohup bash -c "timeout 1800 ~/.local/bin/cursor-agent -p \"\$0\" --model <m> --force --output-format stream-json </dev/null > /tmp/agent-run.jsonl 2>&1; echo \$? > /tmp/agent-run.done" "$PROMPT" >/dev/null 2>&1 &'
  ssh ... 'pgrep -af cursor-agent; ls -l /tmp/agent-run.jsonl'

Long shell commands the planted agent runs go background inside cursor-agent itself: it gets `awaitToolCall` polls carrying a taskId, and the command's own output lands in `~/.cursor/projects/<slug>/terminals/<taskId>.txt` — check there when the jsonl shows a pending tool_call and nothing else.

5 ANALYZE THE TRANSCRIPT — FRICTION IS THE OUTPUT

cursor-agent stream-json event shapes, needed to parse a transcript at all:

  {"type":"tool_call","subtype":"started"|"completed","tool_call":{"<name>ToolCall":{"args":{...},"result":{"success"|"failure":{...}}}}}
  {"type":"assistant","message":{"content":[{"type":"text","text":...}]}}
  {"type":"result","subtype":"success","duration_ms":...,"result":"<final message>"}

Walk each tool_call with its result, each error, and the final result message. Look for steps the agent got wrong, retried, or did not infer from the docs (doc gap); anything it hard-blocked on versus correctly deferring to the user TODO; whether it chose the safe path (private/Tailscale, never public expose). Identity gates — agent login and `sudo tailscale up` — land in the final TODO as a pass, not friction, when the agent reached them cleanly and stated what the user must do; real friction is anything it should have handled from the docs but didn't.

6 VERIFY SERVICES (INFRA LEVEL, NOT UI)

Confirm the agent's install works. Expected topology after `spur init`: two user units only.

  systemctl --user is-active spur-daemon.service spur-web.service          # both active
  curl -sf -o /dev/null -w 'daemon %{http_code}\n' http://127.0.0.1:4310/sessions   # 200
  curl -sf -o /dev/null -w 'web %{http_code}\n'    http://127.0.0.1:5555/           # 200
  curl -s -o /dev/null -w 'ws %{http_code}\n' --max-time 5 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" -H 'Sec-WebSocket-Version: 13' \
    'http://127.0.0.1:5555/ws?session=none'                                 # 101
  ss -ltn

Pass = both units active, daemon 200, web 200, `/ws` upgrade 101, `ss -ltn` shows only 22, 127.0.0.1:4310, 127.0.0.1:5555, plus systemd-resolved — nothing else, and nothing answers on the app ports from the VM's public IP.

7 EVOLVE THE DOCS

For each real friction, edit the install doc minimally, then re-run on a fresh or reset box (see RESET VS RECREATE) until a fresh agent completes single-shot to the identity gates with a clean TODO. Fix the doc, re-test, repeat — never fix by hinting the agent.

8 REPORT

Summarize: single-shot or not, each service check pass/fail, the friction list (each item a doc fix), the agent's final user TODO. Write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR`.

RESET VS RECREATE

Reset (keep the box) after a run that completed: remove the spur package under `~/.local/lib/node_modules`, `~/.spur`, `~/.npmrc`, the two user units plus their wants-symlinks, `daemon-reload`, `disable-linger`, nodejs and the nodesource apt list, tailscale and `/var/lib/tailscale`, `/tmp/agent-run.*`, `~/.cursor/projects`. Keep cursor-agent and its credentials.

Recreate (delete + provision fresh) after a wedge: a shared-core box that stopped answering ssh does not reliably come back within minutes — skip nursing it, go to step 1.

9 DELETE ON CONFIRMATION

Never delete a box without the user's confirmation, even in autonomous mode — see AUTONOMOUS MODE for what substitutes for that confirmation between runs.

  gcloud compute instances delete "spur-itest-$TS" --zone="$ZONE" --project=<gcp-project> --quiet

Update the recipe after deleting.

AUTONOMOUS MODE

With no user present: run the full cycle above unattended, write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR`, open a PR for any doc fix — never push straight to main — and report in-session. Deletion still needs the user's confirmation, so never delete an unconfirmed box; the reap in step 1 is what keeps an unconfirmed box from a prior cycle from accumulating into a pile of paid VMs.

NOTES

  The planted-agent + clueless-user role-play measures the docs, not your own knowledge — wanting to help the agent is a doc gap, write it down instead. Never hardcode the ephemeral IP or the cloud project into this file — keep those in the local recipe, read it each run. One VM per run cycle; create fresh, reset, or recreate — never reuse a dirty box, so "single-shot on a clean server" stays true.
