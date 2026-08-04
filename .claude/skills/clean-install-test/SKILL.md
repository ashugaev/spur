---
name: clean-install-test
description: Clean-room test of the Spur server install by planting a coding agent on a throwaway cloud VM and having IT install Spur from the docs, single-shot, while you play a non-coding user who gives no hints. Use before a release to find where the docs fail a fresh agent. Provision a disposable Ubuntu VM, plant a Claude agent (itest-only: copy your local Claude creds so it runs unattended), stage the repo docs, run the agent on a plain "make it work" prompt, capture the transcript, turn friction into doc fixes, verify services, report, delete on the user's ok.
---

CLEAN INSTALL TEST

A role-play: provision a disposable VM, plant a coding agent on it, then act as a non-coding user who hands that agent only the Spur docs and a plain "make it work" request, zero hints. Whatever a fresh agent can't do from the docs alone is doc friction to fix — the agent does the install, you only observe, analyze, and evolve the docs. Goal: a fresh agent, given only the docs, installs Spur single-shot up to the identity gates (agent login, Tailscale login), collected into a final user TODO, not hacked around. Iterate the docs until that holds, then delete the box.

GROUND RULES

  - Touch only the VM created this run — never production Spur, the local box, or another machine. Lifecycle: create -> plant agent -> run test -> analyze -> evolve docs -> report -> wait for user ok -> delete THAT instance; never delete before the user confirms. Ubuntu 24.04 LTS, e2-small-class (~2GB/2 cores) default, e2-micro (~1GB) floor-tests it; npm bundle ships the web UI prebuilt, no on-box build. Never open app ports to the internet — default firewall leaves only SSH reachable, leave it.
  - No hard hacking: the planted agent never bypasses an identity/auth step; lacking the user's own account it records a TODO and moves on — never hint it past friction, fix the doc instead. Copying local Claude credentials onto the VM (step 3) is an ITEST-ONLY harness shortcut for an unattended run: never outside itest, never between real hosts. Secrets and credentials go to the VM only, piped over SSH stdin, never echoed to logs or chat.

0 PREREQS (LOCAL BOX)

  A cloud CLI authenticated for create/list/delete/IP only (this repo uses Google Cloud; adapt for others); SSH itself needs none once the key is baked in — on expired auth, ask the user to re-authenticate interactively. A permanent SSH keypair baked into the VM at create time (private key, public key, a metadata file holding one `<user>:<pubkey>` line), so SSH survives cloud-token expiry — generate once if missing: `ssh-keygen -t ed25519 -f <keypath> -N ''`. A host-local recipe file (e.g. `~/.spur/itest-conn.md`) holding the project/zone/key paths and the current VM name/IP — read it first, a usable VM can already exist. Your own local Claude login (`~/.claude/.credentials.json`, OAuth) — itest-only, the planted agent runs on it.

1 PROVISION THE CHEAPEST FIT VM

Cheapest region near the user, smallest fit machine, Ubuntu 24.04 LTS, key baked in, labelled ephemeral (substitute your project/zone/key file):

  TS=$(date +%Y%m%d-%H%M); ZONE=<zone>
  gcloud compute instances create "spur-itest-$TS" \
    --project=<gcp-project> --zone="$ZONE" --machine-type=e2-small \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --labels=purpose=spur-itest,ephemeral=true \
    --metadata-from-file ssh-keys=<ssh-keys-metadata-file>

Fetch the external IP (ephemeral — re-fetch after any restart); record VM name + IP in your recipe. Confirm the default firewall exposes only SSH; app ports (4310/5555) must not answer from the public IP.

2 CONNECT (CLOUD-CLI-INDEPENDENT)

  ssh -i <keypath> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <user>@<IP> '<cmd>'

3 PLANT THE AGENT (ITEST-ONLY HARNESS)

A real user logs their own agent in here; for an unattended run you carry your local Claude login instead. Node 20+ is a prerequisite — fresh Ubuntu has none, install it here (generic prereq, not part of the Spur test). Install Claude Code user-scoped and invoke it by full path, off the fresh-user PATH:

  ssh ... 'npm config set prefix ~/.npm-global && npm install -g @anthropic-ai/claude-code'
  cat ~/.claude/.credentials.json | ssh ... 'umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json'
  ssh ... 'node -e "const f=require(\"os\").homedir()+\"/.claude/settings.json\";const fs=require(\"fs\");const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};d.skipDangerousModePermissionPrompt=true;d.skipAutoPermissionPrompt=true;fs.writeFileSync(f,JSON.stringify(d,null,2))"'
  ssh ... 'rm -f ~/.npmrc'    # restores the real ~/.local gotcha for the planted agent
  ssh ... 'export PATH=$HOME/.npm-global/bin:$PATH; claude -p "Reply with exactly one word: authok" --dangerously-skip-permissions'

Re-testing a box that already ran once: reset to a faithful pre-install state first (remove the Spur package, `~/.spur`, its user units, `~/.npmrc`), keeping node/claude/creds/docs.

4 STAGE THE DOCS THE AGENT READS

Give the agent only the docs, mirroring repo layout so relative links resolve. Do NOT include `CLAUDE.md` — it would inject dev-orchestration context an end user never has.

  tar czf - README.md docs/ v2/README.md | ssh ... 'rm -rf ~/spur-docs && mkdir -p ~/spur-docs && tar xzf - -C ~/spur-docs'

5 RUN THE TEST — CLUELESS USER, SINGLE-SHOT, NO HINTS

Launch a fresh agent from `~` (no CLAUDE.md there) with a plain non-technical prompt that points at `~/spur-docs` and names the goal — never a command, prefix, port, or tool. Capture the full structured transcript; run it detached with a timeout and poll.

  nohup bash -c 'timeout 1800 claude -p "$0" --dangerously-skip-permissions \
    --output-format stream-json --verbose </dev/null > /tmp/agent-run.jsonl 2>&1; echo $? > /tmp/agent-run.done' \
    "$PROMPT" >/dev/null 2>&1 &

Prompt shape (change wording, keep it hint-free): "I want to use Spur on this Linux server. I am not a programmer. The docs are in ~/spur-docs. Install and start it, and set it up so I can reach its web interface from my laptop. Do the technical steps yourself; tell me the exact address to open and anything I still need to do myself." The closing clause invites the final user TODO — that TODO is the deliverable, not a failure.

6 ANALYZE THE TRANSCRIPT — FRICTION IS THE OUTPUT

Parse the stream-json: each Bash command with its result, each error, and the final message. Look for steps the agent got wrong, retried, or did not infer from the docs (doc gap); anything it hard-blocked on versus correctly deferring to the user TODO; whether it chose the safe path (private/Tailscale, never public expose). Identity gates — agent login and `sudo tailscale up` — land in the final TODO as a pass, not friction, when the agent reached them cleanly and stated what the user must do; real friction is anything it should have handled from the docs but didn't.

7 VERIFY SERVICES (INFRA LEVEL, NOT UI)

Confirm the agent's install works. Expected topology after `spur init`: two user units only.

  systemctl --user is-active spur-daemon.service spur-web.service          # both active
  curl -sf -o /dev/null -w 'daemon %{http_code}\n' http://127.0.0.1:4310/sessions   # 200
  curl -sf -o /dev/null -w 'web %{http_code}\n'    http://127.0.0.1:5555/           # 200
  curl -s -o /dev/null -w 'ws %{http_code}\n' --max-time 5 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" -H 'Sec-WebSocket-Version: 13' \
    'http://127.0.0.1:5555/ws?session=none'                                 # 101
  ss -ltn | grep 14801 || echo 'no :14801 (good)'

Pass = both units active, daemon 200, web 200, `/ws` upgrade 101, nothing on :14801.

8 EVOLVE THE DOCS
For each real friction, edit the install doc minimally, then re-run on a fresh box (or a reset one, step 3) until a fresh agent completes single-shot to the identity gates with a clean TODO. Fix the doc, re-test, repeat — never fix by hinting the agent.

9 REPORT
Summarize: was the install single-shot, each service check pass/fail, the friction list (each item a doc fix), and the agent's final user TODO. Write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR` so it shows in the UI.

10 DELETE ON THE USER'S CONFIRMATION

Do NOT delete until the user confirms the result is ok. Then delete only the instance created this run:

  gcloud compute instances delete "spur-itest-$TS" --zone="$ZONE" --project=<gcp-project> --quiet

Optionally reap older `spur-itest-*` ephemerals. Never delete a non-itest VM. Update your recipe after deleting.

NOTES

  The planted-agent + clueless-user role-play measures the docs, not your own knowledge — wanting to help the agent is a doc gap, write it down instead. Never hardcode the ephemeral IP or your cloud project into this file — keep those in a local recipe, pass them at call time. One VM per run; create fresh or reset to a faithful pre-install state, never reuse a dirty box, so "single-shot on a clean server" stays true.
