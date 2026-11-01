# Session previews

A coding session or agent often starts a web server so you can look at a page:
`php -S 127.0.0.1:8000`, `npm run dev` (Vite on 5173), or an SSH tunnel to an internal
service. That server runs on the AgentPier computer, so `localhost:5173` points nowhere
when you work from another device. A preview hands you a link that opens the server in a
new tab through AgentPier, with AgentPier's sign-in, and the app behaves as on
`localhost`: it sits at the root of its own address, absolute paths and redirects work,
and WebSockets (hot module reload), server-sent events and streaming responses pass
through unbuffered.

## Enable previews

Previews are off by default, so existing installations open no new ports unasked.

1. Open **Settings › Remote access › Previews** and turn on **Enable previews**.
2. Optionally change **First port** and **Last port**.

Only the owner can change the settings; a request over plain network access can only turn
previews off ("Plain network access can only turn previews off.").

## The port range

Each active preview gets its own port from the range and is served at the root of that
port, for example `https://my-computer.tailnet.ts.net:47100/`. The default range is
**47100-47109** (10 ports). A range is valid when:

- the first port is at least 1024 and the last at most 64535 (see the listener layout
  below), the last is not below the first, and it has at most 50 ports;
- it does not contain AgentPier's own port, the pipeline port range
  (`pipelines.portRange`, default 20100-20999) or the Tailscale HTTPS port (the port of
  the configured remote address, 443 when there is none).

A stored range that ends above 64535 (older drafts allowed 65535) falls back to the
default range after an update. Before a port is used it is probed on loopback and on all
addresses; a port another program holds is skipped and shown as **Used by another
program** in the **Ports** list, next to **Free** and **Preview**. When no port is left,
opening fails with `PREVIEW_RANGE_FULL`.

### One port per preview and sticky slots

Every port is its own browser origin. A service worker, `localStorage` and the cookies of
an earlier app on the same port therefore carry over to the next app that gets that port.
AgentPier reduces this by giving a project and target port the slot it used last, then
the least recently used free slot. It does not send `Clear-Site-Data`, because that would
also clear AgentPier's own cookie (cookies ignore ports). If an old app misbehaves, clear
the site data for that port in the browser.

## Using previews

Sessions with AgentPier tools and full access get three tools on the `agentpier_session`
MCP server: `preview_open({ port, label?, path? })`, `preview_close({ id | port })` and
`preview_list()`. Opening the same port again returns the same preview and updates its
label and path. Agents use `agentpier_preview` with the actions `open`, `close` and
`list`. Both are told to give you the returned link instead of a `localhost` URL and to
bind the server to `127.0.0.1` or `localhost`.

The link appears as **Open preview** in the session's previews section, in the agent's
chat and in **Settings › Remote access › Previews** under **Active previews**, where
**Stop** closes it. A Telegram chat of the owner gets a text message with the link (not
for a `127.0.0.1` address, which no other device can open).

The session tools need the session's **full access** grant, like the artifact tools.
`agentpier_preview` exists only for the owner's own agents and permanent members, never
for user agents, sender-facing agents, routines or hooks. Background runs of the owner's
agent may use it.

Tool errors carry stable codes: `PREVIEW_NOT_LISTENING` (nothing accepts connections on
that port), `PREVIEW_PORT_FORBIDDEN` (AgentPier's own port, the range itself or another
internal listener), `PREVIEW_RANGE_FULL`, `PREVIEW_DISABLED` (previews are off) and
`PREVIEW_UNAVAILABLE` (the remote exposure is not set up).

Pipeline sessions have no session MCP and no previews.

## Three ways to reach a preview

The listener layout follows how AgentPier itself is reachable:

| Access                    | Listener                                       | Address of a preview              |
| ------------------------- | ---------------------------------------------- | --------------------------------- |
| Local only                | `127.0.0.1:<slot>`                             | `http://127.0.0.1:<slot>`         |
| Tailscale Serve (HTTPS)   | `127.0.0.1:<slot + 1000>`, Serve maps `<slot>` | `https://<tailscale-host>:<slot>` |
| Network mode (plain HTTP) | `<network.bind>:<slot>`                        | `http://<network host>:<slot>`    |

With Tailscale, Serve and a local listener cannot share a port number, so the listener
sits 1000 above the slot; that is why the highest allowed range end is 64535. Listener
ports are validated against AgentPier's port, the pipeline range and the Tailscale HTTPS
port. In network mode Tailscale registration is skipped and the host checks use the
configured network hosts.

### Tailscale registration

When previews are on and Tailscale remote access is configured, AgentPier registers the
whole range once with `tailscale serve --bg --https=<slot> http://127.0.0.1:<slot+1000>`.
It re-applies the registration at every start, after a range change and in
`npm run tailscale` (which also installs and updates use). Switching previews off or
changing the range removes the old entries. Only entries whose target is one of
AgentPier's own preview listeners are ever removed; other Serve entries stay. If another
Serve entry already uses a port of the range, the card says so and asks for another range.

If a `tailscale` call fails or hangs (no permission, socket missing, Tailscale stopped),
the **Tailscale** area of the card lists the ports that are **Not shared** and the exact
commands. Run them on the AgentPier computer (**Copy commands**), then switch previews
off and on again. Previews keep working locally and in network mode meanwhile.

## Sign-in and isolation

Only the signed-in owner opens a preview; every request and WebSocket upgrade is checked.
A restricted user never reaches one, and a link without a valid AgentPier session leads to
a page that links to the AgentPier sign-in.

Browsers send cookies regardless of port, so the session cookie reaches the preview
origin. The proxy removes `agentpier_session` from the request, removes `tailscale-*`
headers and drops an upstream `Set-Cookie` for `agentpier_session`. It adds no AgentPier
CSP or `X-Frame-Options`. Upstream it uses `Host: localhost:<port>` (dev servers such as
Vite reject unknown hosts), sets `X-Forwarded-Host`, `-Proto` and `-For`, and rewrites
`Location` headers from `localhost`/`127.0.0.1` to the preview address.

AgentPier's session cookie is `SameSite=Strict`, so opening a link from Telegram or
another app arrives without it. The first answer is a small page that navigates to the
same address once; then the cookie is sent. The link therefore works from other apps.

A page in a preview can plant a second `agentpier_session` cookie. The sign-in then uses
the one cookie that is a valid session and ignores the others. The API also refuses
requests with `Sec-Fetch-Site: same-site` unless they are navigations, so a preview page
cannot call it. One risk remains and is accepted: a hostile preview page can push the
AgentPier cookie out by filling the host's cookie storage. That signs you out; it does
not give the page access.

## Lifetime

- Session previews close when the session stops or is removed and when its full-access
  grant is revoked.
- Agent previews close with `close`, when the chat is deleted and 24 hours after the last
  proxied request.
- An AgentPier restart ends all previews; the session or agent opens them again.
- Opening, closing and expiring are written to the audit log (session or agent, target
  port, slot; no URLs with query strings, no headers).

## Troubleshooting

- **`PREVIEW_NOT_LISTENING`:** start the server first. A server that listens only on
  `::1` works; one bound to a LAN address only does not.
- **Dev server rejects the request:** AgentPier sends `Host: localhost:<port>`; a server
  that allows only another host name needs its allowed hosts changed.
- **Tailscale not shared:** see [Tailscale registration](#tailscale-registration).
- **502 page:** the server on the port is not answering (restarting?). The preview stays
  open.
- **A page says no preview is open on this port:** the slot is idle; ask the session to open the
  preview again.

See also [Remote access](remote-access.md) and [MCP](mcp.md).
