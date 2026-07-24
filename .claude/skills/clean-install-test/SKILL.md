---
name: clean-install-test
description: Clean-room test of the Spur server install by planting a coding agent on a throwaway cloud VM and having IT install Spur from the docs, single-shot, while you play a non-coding user who gives no hints. Use before a release to find where the docs fail a fresh agent. Provision a disposable Ubuntu VM, plant a Claude agent (itest-only: copy your local Claude creds so it runs unattended), stage the repo docs, run the agent on a plain "make it work" prompt, capture the transcript, turn friction into doc fixes, verify services, report, delete on the user's ok.
---

# Clean Install Test

The test is a role-play. You provision a disposable VM and plant a coding agent on it — the setup a real user does before handing work off. Then you act as a non-coding user who gives that agent nothing but the Spur docs and a plain "make it work" request, with zero hints. Whatever a fresh agent can't do from the docs alone is doc friction to fix. The agent does the install; you only observe, analyze, and evolve the docs.

Goal: a fresh agent, given only the docs, installs Spur single-shot up to the identity gates (agent login, Tailscale login) — which it should collect into a final user TODO, not hack around. Iterate the docs until that holds, then delete the box.

## Ground rules

- Touch only the VM you create this run. Never a production Spur, the local box, or another machine.
- Lifecycle: create -> plant agent -> run test -> analyze -> evolve docs -> report -> wait for user ok -> delete THAT instance. Never delete before the user confirms.
- Ubuntu 24.04 LTS. Use an e2-small-class box (~2GB/2 cores) to match the doc's stated lower bar; an e2-micro (~1GB) floor-tests it. The npm bundle ships the web UI prebuilt — no on-box build.
- Never open app ports to the internet. The default cloud firewall leaves them closed (only SSH reachable); do nothing to change that.
- No hard hacking. The planted agent must not bypass an identity/auth step with a sketchy workaround; if it can't do something without the user's own account, it records a TODO and moves on. You must not hint it past friction either — fix the doc instead.
- Copying your local Claude credentials onto the VM (step 3) is an ITEST-ONLY harness shortcut so the planted agent runs unattended. Never do this outside itest, and never copy credentials between real hosts.
- Secrets and credentials go to the VM only, piped over SSH stdin, never echoed to logs or chat.

## 0. Prereqs (local box)

- A cloud CLI authenticated for create/list/delete/IP only (this repo uses Google Cloud; adapt for others). SSH itself needs none once the key is baked in. On expired auth, ask the user to re-authenticate the CLI interactively.
- A permanent SSH keypair baked into the VM at create time (private key, public key, and a metadata file holding one `<user>:<pubkey>` line), so SSH survives cloud-token expiry. Generate once if missing (`ssh-keygen -t ed25519 -f <keypath> -N ''`).
- A host-local recipe file (for example `~/.spur/itest-conn.md`) holding the project/zone/key paths and the current VM name/IP — read it first; a usable VM may already exist.
- Your own local Claude login (`~/.claude/.credentials.json`, OAuth). The planted agent runs on it. Itest-only.

## 1. Provision the cheapest fit VM

Cheapest region near the user. Smallest fit machine, Ubuntu 24.04 LTS, key baked in, labelled ephemeral. Google Cloud example (substitute your project/zone/key file):

```bash
TS=$(date +%Y%m%d-%H%M); ZONE=<zone>
gcloud compute instances create "spur-itest-$TS" \
  --project=<gcp-project> --zone="$ZONE" --machine-type=e2-small \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --labels=purpose=spur-itest,ephemeral=true \
  --metadata-from-file ssh-keys=<ssh-keys-metadata-file>
```

Fetch the external IP (ephemeral — re-fetch after any restart) and record VM name + IP in your recipe. Confirm the default firewall exposes only SSH; app ports (4310/4311) must not answer from the public IP.

## 2. Connect (cloud-CLI-independent)

```bash
ssh -i <keypath> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <user>@<IP> '<cmd>'
```

## 3. Plant the agent (itest-only harness)

A real user logs their own agent in here; for an unattended run you carry your local Claude login instead. Node 20+ is a prerequisite the box must have — a fresh Ubuntu has none, so install it here (generic prereq, not part of the Spur test). Install Claude Code user-scoped and invoke it by full path, so it stays off the fresh-user PATH:

```bash
ssh ... 'npm config set prefix ~/.npm-global && npm install -g @anthropic-ai/claude-code'
# carry your local Claude OAuth creds over stdin — never printed
cat ~/.claude/.credentials.json | ssh ... 'umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json'
# seed settings so --dangerously-skip-permissions does not prompt
ssh ... 'node -e "const f=require(\"os\").homedir()+\"/.claude/settings.json\";const fs=require(\"fs\");const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};d.skipDangerousModePermissionPrompt=true;d.skipAutoPermissionPrompt=true;fs.writeFileSync(f,JSON.stringify(d,null,2))"'
# reset npm prefix to the fresh default so the PLANTED agent faces the real ~/.local gotcha
ssh ... 'rm -f ~/.npmrc'
# verify auth: expect the single word back
ssh ... 'export PATH=$HOME/.npm-global/bin:$PATH; claude -p "Reply with exactly one word: authok" --dangerously-skip-permissions'
```

If you are re-testing on a box that already ran once, reset it to a faithful pre-install state first (remove the Spur package, `~/.spur`, its user units, `~/.npmrc`), keeping node/claude/creds/docs.

## 4. Stage the docs the agent reads

Give the agent only the docs, mirroring repo layout so relative links resolve. Do NOT include `CLAUDE.md` — it would inject dev-orchestration context an end user never has.

```bash
tar czf - README.md docs/ v2/README.md | ssh ... 'rm -rf ~/spur-docs && mkdir -p ~/spur-docs && tar xzf - -C ~/spur-docs'
```

## 5. Run the test — clueless user, single-shot, no hints

Launch a fresh agent from `~` (no CLAUDE.md there) with a plain non-technical prompt that points at `~/spur-docs` and names the goal — never a command, prefix, port, or tool. Capture the full structured transcript; run it detached with a timeout and poll.

```bash
nohup bash -c 'timeout 1800 claude -p "$0" --dangerously-skip-permissions \
  --output-format stream-json --verbose </dev/null > /tmp/agent-run.jsonl 2>&1; echo $? > /tmp/agent-run.done' \
  "$PROMPT" >/dev/null 2>&1 &
```

Prompt shape (adjust wording, keep it hint-free): "I want to use Spur on this Linux server. I am not a programmer. The docs are in ~/spur-docs. Install and start it, and set it up so I can reach its web interface from my laptop. Do the technical steps yourself; tell me the exact address to open and anything I still need to do myself." The closing clause invites the agent to emit the final user TODO — that TODO is the deliverable, not a failure.

## 6. Analyze the transcript — friction is the output

Parse the stream-json: every Bash command with its result, every error, and the final message. Look for:

- Steps the agent got wrong, retried, or could not infer from the docs -> doc gap.
- Anything it hard-blocked on, versus correctly deferring to the user TODO.
- Whether it chose the safe path (private/Tailscale, never public expose).

Identity gates — agent login and `sudo tailscale up` — are EXPECTED to land in the final TODO; that is a pass, not friction, as long as the agent reached them cleanly and stated what the user must do. Real friction is anything an agent should have handled from the docs but didn't.

## 7. Verify services (infra level, not UI)

Confirm the agent's install actually works. Expected topology after `spur init`: two user units only.

```bash
systemctl --user is-active spur-daemon.service spur-web.service          # both active
curl -sf -o /dev/null -w 'daemon %{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -sf -o /dev/null -w 'web %{http_code}\n'    http://127.0.0.1:4311/           # 200
curl -s -o /dev/null -w 'ws %{http_code}\n' --max-time 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" -H 'Sec-WebSocket-Version: 13' \
  'http://127.0.0.1:4311/ws?session=none'                                 # 101
ss -ltn | grep 14801 || echo 'no :14801 (good)'
```

Pass = both units active, daemon 200, web 200, `/ws` upgrade 101, nothing on :14801.

## 8. Evolve the docs

For each real friction, edit the install doc minimally, then re-run on a fresh box (or a reset one, step 3) until a fresh agent completes single-shot to the identity gates with a clean TODO. Never fix by hinting the agent — fix the doc, re-test, repeat.

## 9. Report

Summarize: was the install single-shot, each service check pass/fail, the friction list (each item a doc fix), and the agent's final user TODO. Write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR` so it shows in the UI.

## 10. Delete on the user's confirmation

Do NOT delete until the user confirms the result is ok. Then delete only the instance created this run:

```bash
gcloud compute instances delete "spur-itest-$TS" --zone="$ZONE" --project=<gcp-project> --quiet
```

Optionally reap older `spur-itest-*` ephemerals. Never delete a non-itest VM. Update your recipe after deleting.

## Notes

- The planted-agent + clueless-user role-play is the point: it measures the docs, not your own knowledge. If you find yourself wanting to help the agent, that urge is a doc gap — write it down instead.
- Never hardcode the ephemeral IP or your cloud project into this file — keep those in a local recipe and pass them at call time.
- One VM per run; create fresh or reset to a faithful pre-install state, never reuse a dirty box, so "single-shot on a clean server" stays a true claim.
