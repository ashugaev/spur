# HTTPS over Tailscale

Browsers block microphone access (`getUserMedia`) over plain HTTP, `localhost` excepted. Tailnet hostname over HTTP → [voice input](voice.md) dead. Rest of the UI unaffected.

`tailscale serve` terminates TLS with a Let's Encrypt cert issued through the tailnet and renews itself. No cert files, no timer, no reverse proxy. Tailnet-only — `serve` is not `funnel`.

## Prerequisites

- Tailnet up — [install-from-npm.md](install-from-npm.md#private-access-tailscale-default-on).
- HTTPS Certificates enabled for the tailnet: admin console → DNS → HTTPS Certificates → Enable. Once per tailnet, owner/admin only. Without it no cert issues, ever.

## Skip check

Run first. 443 belongs to whoever already holds it.

```bash
tailscale serve status              # expect: No serve config
sudo ss -tlnp | grep -E ':443\b'    # expect: no output
```

Either one non-empty → stop. Change nothing, report the blocker below.

## Enable

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:5555
```

`5555` is `ui.port` / the web unit's `PORT` — substitute a custom one.

`--bg` mandatory: foreground `serve` dies with the shell. Config lives in tailscaled state, survives reboot.

## Verify

```bash
FQDN=$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')
curl -fsS -o /dev/null -w '%{http_code}\n' "https://$FQDN/"
```

Expect `200`, first request up to ~15s while the cert issues. No `-k` — an untrusted cert is a failed setup, browsers reject it too.

Then open `https://$FQDN/` on a tailnet device and hit the mic button.

## Off

```bash
tailscale serve --https=443 off
```

## Failure blocks voice input

Cert won't issue, `serve` won't start, or 443 is taken: no workarounds, no touching other services. Hand the operator this and move on —

> HTTPS on the tailnet host is not set up. Voice input (microphone) will not work in the web UI — browsers require HTTPS for `getUserMedia`. The rest of Spur is unaffected.
