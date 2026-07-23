---
name: clean-install-test
description: Clean-room test of the Spur server install on a throwaway cheap cloud VM. Use to prove the official npm install flow works end-to-end on a fresh server before a release — provision a disposable Ubuntu VM, install Spur by following docs/agentic-install-from-npm.md (not restated here), verify the services come up (daemon, web, /ws terminal, agent spawn), report, then delete that instance once the user confirms. Infra harness only; it carries no install steps of its own and does not test UI.
---

# Clean Install Test

Reproduce a real user's first-time server setup for Spur on a disposable VM and confirm the services work, then destroy the box. This skill is the infrastructure wrapper around the install — the same thing a user does before handing an agent the guide. The actual install steps live in `docs/agentic-install-from-npm.md`; follow that doc, do not restate it here. No UI-flow testing — verify at the service level.

Goal: prove single-shot install on a clean Ubuntu server up to the agent-login gate, then delete the instance.

## Ground rules

- Touch only the VM you create this run. Never touch other machines, a production Spur, or the local box.
- Lifecycle is create -> test -> report -> wait for the user's ok -> delete THAT instance. Never delete before the user confirms.
- Ubuntu only. Tested/target version: Ubuntu 24.04 LTS. Smallest, cheapest box (for example an e2-micro-class VM, ~1GB RAM); the npm bundle ships the web UI prebuilt, so no on-box build is needed and this size is fine.
- Never open app ports to the internet. A default cloud firewall leaves them closed (only SSH reachable); do nothing to change that.
- Secrets (API keys) go to the VM only, piped over SSH stdin, never echoed to logs or chat.

## 0. Prereqs (local box)

- A cloud CLI authenticated for creating and deleting VMs (this repo uses Google Cloud; adapt for others). The CLI is needed ONLY to create / list / delete VMs and fetch the IP — SSH itself needs none once the key is baked in. If a call fails on expired auth, ask the user to re-authenticate the CLI interactively.
- A permanent SSH keypair baked into the VM at create time, so SSH survives cloud-token expiry — a private key, its public key, and a metadata file holding one `<user>:<pubkey>` line for the create call. Generate once if missing (`ssh-keygen -t ed25519 -f <keypath> -N ''`).
- The concrete project/zone/key paths for your environment are host-local, not committed here — keep them in a local recipe file (for example `~/.spur/itest-conn.md`) and read it first; a usable VM may already exist.
- The agent-spawn check (step 5) needs an agent API key kept on the host only (for example an OpenAI key for codex, a Claude login). Use it only when verifying the agent flow; otherwise stop at the login gate for the user to authenticate.

## 1. Provision the cheapest VM

Cheapest region near the user (this repo defaults to Europe: Amsterdam `europe-west4-a`, alt Frankfurt `europe-west3-a`). Smallest machine, Ubuntu 24.04 LTS, key baked in, labelled ephemeral. Google Cloud example (substitute your project/zone/key file):

```bash
TS=$(date +%Y%m%d-%H%M); ZONE=europe-west4-a
gcloud compute instances create "spur-itest-$TS" \
  --project=<gcp-project> --zone="$ZONE" --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --labels=purpose=spur-itest,ephemeral=true \
  --metadata-from-file ssh-keys=<ssh-keys-metadata-file>
```

Fetch the external IP (ephemeral — re-fetch after any restart) and record VM name + IP in your local recipe. Confirm the default firewall exposes only SSH; app ports (4310/4311) must not answer from the public IP.

## 2. Connect (cloud-CLI-independent)

```bash
ssh -i <keypath> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <user>@<IP> '<cmd>'
```

## 3. Install Spur — drive the doc, do not restate it

Open `docs/agentic-install-from-npm.md` and run its steps on the VM exactly as a fresh user would (Node 20, npm prefix `~/.local` + PATH, `npm i -g @shugaev/spur`, `spur init` with Tailscale default-on / opt-out). The skill executes the doc; it does not carry a second copy of the steps. Any doc step that fails on a clean box is a release blocker — capture the command, output, and fix.

## 4. Verify services (infra level, not UI)

Over SSH, confirm the runtime came up. Expected topology after `spur init`: two user units only.

```bash
systemctl --user is-active spur-daemon.service spur-web.service          # both active
curl -sf -o /dev/null -w 'daemon %{http_code}\n' http://127.0.0.1:4310/sessions   # 200
curl -sf -o /dev/null -w 'web %{http_code}\n'    http://127.0.0.1:4311/           # 200 (web port per unit)
# terminal WebSocket served in-process on /ws (no separate :14801 unit):
curl -s -o /dev/null -w 'ws %{http_code}\n' --max-time 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
  'http://127.0.0.1:4311/ws?session=none'                                 # 101
ss -ltn | grep 14801 || echo 'no :14801 (good)'
command -v tailscale && tailscale version | head -1 || echo 'tailscale absent'
```

Pass = both units active, daemon 200, web 200, `/ws` upgrade 101, nothing on :14801, Tailscale present (default-on install) staying loopback until `sudo tailscale up` (a user gate). Record each result.

## 5. Verify an agent actually spawns (optional, needs a key)

Only when checking the agent flow; otherwise stop and tell the user to authenticate an agent themselves, then resume. Keep cost minimal: install the CLI, one tiny prompt, one turn, tear down.

```bash
npm install -g @openai/codex
printf '%s' "$AGENT_API_KEY" | codex login --with-api-key      # pipe the key over stdin, never echo it
spur connect ~/projects/demo/spur.yaml
spur spawn demo --agent codex 'Reply with exactly the word PONG and nothing else.'
```

Confirm the session reaches `waiting` and its tmux pane shows the reply (`tmux -L spur-4310 capture-pane -t <id> -p`). Then kill it and clean up orphans:

```bash
spur kill <id>
pkill -f 'local/bin/codex' || true
ps -eo cmd | grep '[l]ocal/bin/codex' || echo 'clean'      # bracket avoids matching your own command line
```

## 6. Report

Summarize: was the install single-shot, each service check pass/fail, did an agent spawn and reply, and any friction (each friction on a clean box is a release blocker). Write the friction log to `$SPUR_SESSION_ARTIFACTS_DIR` so it shows in the UI.

## 7. Delete on the user's confirmation

Do NOT delete until the user confirms the result is ok. Then delete only the instance created this run:

```bash
gcloud compute instances delete "spur-itest-$TS" --zone="$ZONE" --project=<gcp-project> --quiet
```

Optionally reap older `spur-itest-*` ephemerals. Never delete a non-itest VM. Update your local recipe after deleting.

## Notes

- Users typically do steps 1–4 themselves to prepare a server before handing an agent the guide link; this skill mirrors that setup so an agent can reproduce and validate it.
- Never hardcode the ephemeral IP or your cloud project into this file — keep those in a local recipe and pass them at call time.
- One VM per run; create fresh, never reuse a dirty box, so "single-shot on a clean server" stays a true claim.
