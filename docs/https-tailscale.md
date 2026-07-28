# HTTPS over Tailscale

Browsers block microphone access (`getUserMedia`) over plain HTTP, `localhost` excepted. Tailnet hostname over HTTP → [voice input](voice.md) dead, and terminal copy silently no-ops (`navigator.clipboard` is secure-context only). Rest of the UI works.

`tailscale serve` terminates TLS with a Let's Encrypt cert issued through the tailnet and renews itself. No cert files, no timer, no reverse proxy. Tailnet-only — `serve` is not `funnel`.

## Prerequisites

- Tailnet up — [install-from-npm.md](install-from-npm.md#private-access-tailscale-default-on).
- MagicDNS enabled for the tailnet — a hard prerequisite of HTTPS Certificates, and what gives the node the `<host>.<tailnet>.ts.net` name every command below uses. Tailnet-level only; devices can still run `--accept-dns=false`.
- HTTPS Certificates enabled for the tailnet: admin console → DNS → HTTPS Certificates → Enable. Once per tailnet, owner/admin only. Without it no cert issues, ever.

The certs are public Let's Encrypt certs, so every node name a cert is issued for lands in public certificate-transparency logs — permanently, tailnet-wide. Names leak, nothing else: the addresses stay tailnet-only and unreachable from the internet.

## Skip check

Run first. 443 belongs to whoever already holds it.

```bash
tailscale serve status --json | jq -e '.TCP."443"' >/dev/null && echo "443 served by tailscale"
sudo ss -tlnp | grep -E ':443\b'    # expect: no output
```

Either one printing → stop. Change nothing, report the blocker below.

Scoped to 443 deliberately: bare `tailscale serve status` is non-empty for a `serve` on any port, so an operator already serving `--http=80` would get a false abort.

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
sudo tailscale serve --https=443 off
```

## Failure blocks voice input

Cert won't issue, `serve` won't start, or 443 is taken: no workarounds, no touching other services. Hand the operator this and move on —

> HTTPS on the tailnet host is not set up. Voice input (microphone) will not work in the web UI — browsers require HTTPS for `getUserMedia`. The rest of Spur is unaffected.
