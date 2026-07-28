# HTTPS over Tailscale

Browsers block microphone access (`getUserMedia`) over plain HTTP, `localhost` excepted. Tailnet hostname over HTTP → [voice input](voice.md) dead. Rest of the UI unaffected.

`tailscale serve` terminates TLS with a Let's Encrypt cert issued through the tailnet and renews itself. No cert files, no timer, no reverse proxy.

Tailnet-only. `serve` is not `funnel`.

## Prerequisites

- Tailnet up — [install-from-npm.md](install-from-npm.md#private-access-tailscale-default-on).
- HTTPS Certificates enabled for the tailnet: admin console → DNS → HTTPS Certificates → Enable. Once per tailnet, owner/admin only. Without it no cert issues, ever.

Hostname for the commands below:

```bash
FQDN=$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')   # needs jq
```

## Skip check

Run first. 443 belongs to whoever holds it.

```bash
tailscale serve status              # expect: No serve config
sudo ss -tlnp | grep -E ':443\b'    # expect: no output
```

Either one non-empty → host already terminates HTTPS. Stop. Change nothing. Use that proxy instead (below).

## Enable

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:4311
```

`4311` is the default web port — substitute `--web-port`, or `5555` on a source install behind nginx.

`--bg` mandatory: foreground `serve` dies with the shell. Config lives in tailscaled state, survives reboot.

## Verify

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' "https://$FQDN/"
```

Expect `200`, first request up to ~15s while the cert issues. No `-k` — an untrusted cert is a failed setup, browsers reject it too.

Then open the URL on a tailnet device and hit the mic button.

## Failure blocks voice input

Cert never issues or `serve` won't start: no workarounds, no touching other services. Hand the operator:

> HTTPS on the tailnet host is not set up. Voice input (microphone) will not work in the web UI — browsers require HTTPS for `getUserMedia`. The rest of Spur is unaffected.

Causes: HTTPS Certificates off for the tailnet; tailnet down; 443 taken.

## Off

```bash
tailscale serve --https=443 off
```

## Existing proxy on 443

Keep it. Cert to disk instead:

```bash
sudo tailscale cert --cert-file <path>.crt --key-file <path>.key "$FQDN"
```

Add a vhost for `$FQDN` onto the web port. `tailscale cert` never renews itself — weekly timer re-runs it and reloads the proxy, else dead at 90 days.
