# HTTPS over Tailscale

Browsers gate microphone access (`getUserMedia`) behind HTTPS. Over a tailnet hostname or IP, plain HTTP means voice input stays dead — see [voice.md](voice.md). Everything else in the UI is fine over HTTP, and `localhost` is exempt.

`tailscale serve` terminates TLS with a Let's Encrypt cert issued through your tailnet and renews it itself. No cert files, no timer, no reverse proxy.

Reachable inside the tailnet only. `serve` is not `funnel`.

## Prerequisites

- Tailnet up — [install-from-npm.md](install-from-npm.md#private-access-tailscale-default-on).
- HTTPS Certificates enabled for the tailnet: admin console → DNS → HTTPS Certificates → Enable. Once per tailnet, needs an owner/admin. Without it no cert is ever issued.

The tailnet hostname, used below:

```bash
FQDN=$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')   # needs jq
```

## Skip check

Run first. Never take 443 from another service.

```bash
tailscale serve status              # expect: No serve config
sudo ss -tlnp | grep -E ':443\b'    # expect: no output
```

Either one non-empty → this host already terminates HTTPS. Stop here, change nothing, and use that proxy instead (below).

## Enable

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:4311
```

`4311` is the default web port — substitute yours (`--web-port`), or `5555` on a source install fronted by nginx.

`--bg` is required. Without it `serve` runs in the foreground and dies with the shell. The config persists in tailscaled state and comes back after reboot.

## Verify

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' "https://$FQDN/"
```

Expect `200`. First request takes up to ~15s while the cert is issued. No `-k` — the point is a cert the browser trusts, so a TLS failure here is a real failure.

Then open the URL on a tailnet device and check the mic button in the web UI.

## Disable

```bash
tailscale serve --https=443 off
```

## Failure is a voice-input blocker

If the cert never issues or `serve` won't start, do not work around it and do not touch other services. Tell the operator:

> HTTPS on the tailnet host is not set up. Voice input (microphone) will not work in the web UI — browsers require HTTPS for `getUserMedia`. The rest of Spur is unaffected.

Causes, in order of likelihood: HTTPS Certificates not enabled for the tailnet; tailnet not up; 443 owned by another service.

## Existing reverse proxy on 443

Keep it — do not replace it with `serve`. Issue the cert to disk instead:

```bash
sudo tailscale cert --cert-file <path>.crt --key-file <path>.key "$FQDN"
```

Add a vhost for that hostname pointing at the web port. `tailscale cert` does not renew on its own — re-run it on a weekly timer and reload the proxy, or the cert expires after 90 days.
