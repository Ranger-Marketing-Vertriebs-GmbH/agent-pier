# Private remote access

AgentPier binds to loopback and accepts the configured owner's identity from Tailscale Serve. It does not enable Funnel or expose the service to the public internet. Use the same `AGENTPIER_DATA_DIR` for the web service and setup script.

For an existing Tailscale connection:

```sh
node scripts/tailscale.mjs
node scripts/service.mjs install
```

The script preserves existing Serve handlers and chooses an unused port from 8443, 10000 and 9443. It can reuse an exact existing AgentPier handler.

## A separate AgentPier identity

A host that already has a Tailscale identity can run a separate userspace daemon with its own state and socket. This gives AgentPier a separate MagicDNS name without renaming the existing host. Tailscale documents the `--tun=userspace-networking` and custom state/socket options in its [daemon reference](https://tailscale.com/docs/reference/tailscaled).

Create a private directory outside the application release tree and use an installed `tailscaled` binary:

```sh
mkdir -p "$HOME/.local/share/agentpier-tailscale"
chmod 700 "$HOME/.local/share/agentpier-tailscale"
tailscaled --tun=userspace-networking \
  --statedir="$HOME/.local/share/agentpier-tailscale" \
  --socket="$HOME/.local/share/agentpier-tailscale/tailscaled.sock" \
  --port=0
```

Run the daemon under a dedicated user service for persistent access. Do not reuse or replace another Tailscale daemon's socket/state. In another terminal, request the new identity:

```sh
tailscale --socket="$HOME/.local/share/agentpier-tailscale/tailscaled.sock" \
  up --hostname=agentpier --accept-dns=false
```

Open the authorization URL printed by Tailscale, then configure the private HTTPS handler using that daemon:

```sh
export AGENTPIER_TAILSCALE_SOCKET="$HOME/.local/share/agentpier-tailscale/tailscaled.sock"
export AGENTPIER_TAILSCALE_HTTPS_PORT=443
node scripts/tailscale.mjs
node scripts/service.mjs install
```

The setup command prints the actual tailnet URL; a name collision may result in a different name. Port443 is accepted only if free or already owned by the exact AgentPier loopback handler. AgentPier stores the resulting HTTPS origin and authorized login in its private data directory. The [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve) describes the tailnet-only proxy and HTTPS prerequisites.

To remove only this handler, use its dedicated socket and `tailscale serve --https=443 off`. Do not reset unrelated Serve configuration. Keep authentication state private and out of backups intended for another device; authorize a new identity on that device instead.
