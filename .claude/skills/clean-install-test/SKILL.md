---
name: clean-install-test
description: Clean-room test of the Spur server install by planting two coding agents — cursor-agent and Claude Code — on a persistent cloud VM that gets reset to a pre-install state each run; the harness never creates or deletes a VM. Cron-safe — runs end to end from the skill name alone, opens a PR for any doc fix, reports in-session. Reset the box over plain SSH, plant both agents by copying the operator's credentials (itest-only shortcut), run each on the README Install block verbatim, capture the transcripts, turn friction into doc fixes, verify services, compare the two agents.
---

CLEAN INSTALL TEST

A role-play: reset a persistent VM to a pre-install state, plant two coding agents on it, act as a non-coding user who hands each agent only the Spur docs, zero hints. Whatever a fresh agent can't do from the docs alone is doc friction to fix — the agent does the install, you observe, analyze, evolve the docs. Goal: a fresh agent, given only the docs, installs Spur single-shot up to the identity gates (agent login, Tailscale login), collected into a final user TODO, not hacked around. Iterate the docs until that holds for both agents.

Runs with no prompt beyond the skill name and no human present — see AUTONOMOUS MODE.

GROUND RULES

  - Never create a VM. Never delete a VM. One box stays up permanently; reset it in place before each run. Lifecycle: read the recipe -> reset the box -> plant both agents -> run the test on each -> analyze -> verify services -> evolve docs -> report. Provisioning a replacement box is a one-time exception on the user's explicit instruction only — it needs cloud-CLI auth this harness must not depend on for the normal path. Ubuntu 24.04 LTS. e2-small is the floor machine, not e2-micro: the planted agent runs ON the box and competes with the install for CPU. e2-micro wedged mid-run on a repeat test — CPU credit exhaustion, not RAM (peaked 686 MB of 955 MB on the pass run) — sshd stopped answering, serial console showed `systemd-networkd: Could not set DHCPv4 address: Connection timed out`, a stop/start did not recover it within 5 min. npm bundle ships the web UI prebuilt, no on-box build. Never open app ports to the internet — default firewall leaves only SSH reachable, leave it.
  - Never stop the box. It stays up, so its ephemeral external IP holds and SSH keeps working with no cloud CLI. A stop/start reassigns the IP and is the one thing that forces a cloud-CLI round trip to re-fetch it — so don't. A reserved static IP would remove even that risk; not set up yet, the attempt failed on expired gcloud auth.
  - No hard hacking: a planted agent never bypasses an identity/auth step; lacking the user's own account it records a TODO and moves on — never hint it past friction, fix the doc instead. Copying credentials onto the VM (step 4) is an ITEST-ONLY harness shortcut for an unattended run: never outside itest, never between real hosts. Secrets and credentials go to the VM only, piped over SSH stdin, never echoed to logs or chat.
  - A run that finds zero friction is a pass. Report it and stop — never invent a doc edit to justify the cycle.

0 PREREQS (LOCAL BOX)

  SSH needs no cloud CLI once the key is baked in — a permanent SSH keypair, generate once if missing: `ssh-keygen -t ed25519 -f <keypath> -N ''`. A host-local recipe file (e.g. `~/.spur/itest-conn.md`) holding the box's project/zone/key paths and its current name/IP — read it first, the persistent box already exists. `~/.config/cursor/auth.json` and `~/.claude/.credentials.json` on the operator's box — itest-only, both planted agents run on them.

1 BOOTSTRAP A REPLACEMENT BOX (ONE-TIME, USER INSTRUCTION ONLY)

Only on the user's explicit instruction, only when the persistent box is gone or unrecoverable — needs cloud-CLI auth. Cheapest region near the user, e2-small floor, Ubuntu 24.04 LTS, key baked in (substitute your project/zone/key file):

  gcloud compute instances create spur-itest \
    --project=<gcp-project> --zone=<zone> --machine-type=e2-small \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --metadata-from-file ssh-keys=<ssh-keys-metadata-file>

Fetch the external IP and record name + IP in the recipe. Confirm the default firewall exposes only SSH; app ports (4310/5555) must not answer from the public IP.

2 CONNECT (CLOUD-CLI-INDEPENDENT)

  ssh -i <keypath> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <user>@<IP> '<cmd>'

3 RESET THE BOX (EVERY RUN)

Upload the committed reset script over stdin so the box always runs the version in this repo, then run it and read its printed state table before trusting the box is clean:

  cat tests/itest/reset-vm.sh | ssh ... 'cat > ~/itest-reset.sh && chmod +x ~/itest-reset.sh'
  ssh ... 'bash ~/itest-reset.sh'

`tests/itest/reset-vm.sh` never removes `~/.itest-harness`, `~/.claude/.credentials.json`, or `~/.config/cursor/auth.json` — the Claude harness node and both agents' credentials survive a reset by design.

4 PLANT THE AGENTS (ITEST-ONLY HARNESS) — BOTH REQUIRED, OFF THE TESTED PATH

Both cursor-agent and Claude Code get planted on the box; both runs are required, not primary/fallback — see 5 RUN THE TEST.

cursor-agent is self-contained, needs no node, and the box stays node-free until the tested agent installs node itself — that install is part of what the test measures.

  ssh ... 'curl https://cursor.com/install -fsS | bash'    # lands ~/.local/bin/cursor-agent
  cat ~/.config/cursor/auth.json | ssh ... 'umask 077; mkdir -p ~/.config/cursor; cat > ~/.config/cursor/auth.json'
  ssh ... '~/.local/bin/cursor-agent --list-models'         # pick a weak model; this run used gemini-3.7-flash-high
  ssh ... '~/.local/bin/cursor-agent -p "Reply with exactly one word: authok" --model gemini-3.7-flash-high --force --output-format text'

`--force` is required on every `-p` run — without it the run dies on a directory-trust prompt ("Pass --trust, --yolo, or -f"), not an auth failure. Caveat: cursor pulls the operator's account-level user rules into the planted agent's context — the run is not a pristine blank agent.

Claude Code ships a native binary: `~/.itest-harness/bin/claude` resolves to `lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, needs no node at run time. A `node .../cli.js` invocation fails MODULE_NOT_FOUND — never use it. Installing it needs node once — install a private harness node off the tested PATH and use its npm:

  mkdir -p ~/.itest-harness
  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz | tar xJ -C ~/.itest-harness --strip-components=1
  PATH=$HOME/.itest-harness/bin:$PATH npm install -g --prefix $HOME/.itest-harness @anthropic-ai/claude-code
  cat ~/.claude/.credentials.json | ssh ... 'umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json'
  ssh ... 'node -e "const f=require(\"os\").homedir()+\"/.claude/settings.json\";const fs=require(\"fs\");const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};d.skipDangerousModePermissionPrompt=true;d.skipAutoPermissionPrompt=true;fs.writeFileSync(f,JSON.stringify(d,null,2))"'

Launch with a sanitized environment so its child shells see the node-free box under test, never the harness node:

  env -i HOME=$HOME USER=$USER TERM=dumb PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin ~/.itest-harness/bin/claude -p "$PROMPT" --dangerously-skip-permissions --output-format stream-json --verbose

Verified: a planted Claude launched this way runs `command -v node` and gets NO-NODE. Same itest-only credential caveat as cursor-agent applies.

5 RUN THE TEST — README INSTALL BLOCK, SINGLE-SHOT, NO HINTS

Run twice per cycle, once per agent, with a full reset (step 3) between the two runs — a box dirtied by one agent's run is not a clean box for the other's.

The prompt is the Install block of the repo README verbatim — that block is the artifact under test, not a prompt the runner writes. It tells the agent to fetch `raw.githubusercontent.com/<owner>/spur/<ref>/docs/install-from-npm.md`, never a `github.com/.../blob/...` URL — that form returns an empty document under cursor's webFetch. `<ref>` is `main` by default; point it at the PR branch to test an unmerged doc fix. No docs are staged on the VM — the agent fetches this one file over HTTPS; do not tar the repo docs onto the box, the prompt never reads them.

Launch detached from `~` (no CLAUDE.md there), stream-json, poll a done-file. The launch ssh call can hang even after the remote process has detached — never wait on it, verify with a separate ssh call instead:

  ssh ... 'nohup bash -c "timeout 1800 ~/.local/bin/cursor-agent -p \"\$0\" --model <m> --force --output-format stream-json </dev/null > /tmp/agent-run.jsonl 2>&1; echo \$? > /tmp/agent-run.done" "$PROMPT" >/dev/null 2>&1 &'
  ssh ... 'pgrep -af cursor-agent; ls -l /tmp/agent-run.jsonl'

Long shell commands the planted cursor-agent runs go background inside cursor-agent itself: it gets `awaitToolCall` polls carrying a taskId, and the command's own output lands in `~/.cursor/projects/<slug>/terminals/<taskId>.txt` — check there when the jsonl shows a pending tool_call and nothing else.

6 ANALYZE THE TRANSCRIPT — FRICTION IS THE OUTPUT

cursor-agent stream-json event shapes, needed to parse a transcript at all:

  {"type":"tool_call","subtype":"started"|"completed","tool_call":{"<name>ToolCall":{"args":{...},"result":{"success"|"failure":{...}}}}}
  {"type":"assistant","message":{"content":[{"type":"text","text":...}]}}
  {"type":"result","subtype":"success","duration_ms":...,"result":"<final message>"}

Walk each tool_call with its result, each error, and the final result message. Look for steps the agent got wrong, retried, or did not infer from the docs (doc gap); anything it hard-blocked on versus correctly deferring to the user TODO; whether it chose the safe path (private/Tailscale, never public expose). Identity gates — agent login and `sudo tailscale up` — land in the final TODO as a pass, not friction, when the agent reached them cleanly and stated what the user must do; real friction is anything it should have handled from the docs but didn't.

7 VERIFY SERVICES (INFRA LEVEL, NOT UI)

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

8 EVOLVE THE DOCS

For each real friction, edit the install doc minimally, then reset (step 3) and re-run both agents until each completes single-shot to the identity gates with a clean TODO. Fix the doc, re-test, repeat — never fix by hinting the agent.

9 REPORT

Per agent: single-shot or not, each service check pass/fail, duration, friction hit, final user TODO. Then one friction list deduplicated across both agents — friction only one agent hits is still friction, the weaker agent is the bar, fix the doc for both. Write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR`.

AUTONOMOUS MODE

With no user present: run the full cycle above unattended for both agents, write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR`, open a PR for any doc fix — never push straight to main — and report in-session. The box stays up after the run; never delete it, never stop it.

NOTES

  The planted-agent + clueless-user role-play measures the docs, not your own knowledge — wanting to help the agent is a doc gap, write it down instead. Never hardcode the box's IP or the cloud project into this file — keep those in the local recipe, read it each run.
