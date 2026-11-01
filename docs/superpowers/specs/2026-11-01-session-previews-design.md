# Session previews: open a session's dev server in the owner's browser

Tickets: AGENTPIER-277 (this design, step 1), AGENTPIER-227 (step 2, managed SSH
forwards to registered hosts, not part of this design). Depends on AGENTPIER-300
(`npm run tailscale` overwrites `config.json`), because the preview range is stored
there.

## Intent

Coding sessions and agents regularly start a web server so the owner can look at and
test a page: `php -S 127.0.0.1:8000`, `npm run dev` (Vite on 5173), or an SSH tunnel
(`ssh -L 8080:internal-service:80 host`) to a service that is not reachable from the
internet. These servers run on the AgentPier machine. The owner never works on that
machine; they reach AgentPier remotely (Tailscale for this owner, network mode for
others). `localhost:5173` therefore points nowhere for them.

Session previews let a session or agent hand the owner a link that opens such a server
in a new browser tab, through AgentPier, with AgentPier's login, and with the app
behaving as it would on `localhost` (absolute paths, redirects, Hot Module Reload).

## Goals

- A session or agent explicitly reports a server with an MCP tool / bridge action; AgentPier
  answers with a URL and shows an **Open preview** link to the owner.
- The page opens in a new tab and works like on localhost: the app sits at the origin
  root, WebSockets (HMR), SSE and streaming responses pass through unbuffered.
- Works over every way AgentPier is reachable: local, Tailscale Serve, network mode.
- Only the signed-in owner can open a preview.
- Previews end with their session, on request, and are visible and stoppable by the owner.
- The port range is configurable, defaults to a rarely used range, and is probed for
  availability.
- Install, `npm run tailscale` and the update path set up whatever exposure the range
  needs; no manual steps on one machine (AGENTS.md).

## Non-goals

- Sharing with customers or anyone without an AgentPier owner login; public links.
- Detecting listening ports automatically (owner: too complex; sessions report instead).
- Embedding the page inside AgentPier (iframe, side panel). A new tab is enough.
- Managed SSH forwards to registered hosts (step 2, AGENTPIER-227). A tunnel a session
  starts itself is covered here: its local end is just another localhost port.
- Previews for restricted users or their agents (owner only for now).
- Path-based proxying (`/preview/<id>/`): breaks apps with absolute paths and redirects.

## Anti-goals (failure even if it "works")

- Any preview reachable without the owner's AgentPier login.
- A preview page that can log the owner out, read or overwrite the AgentPier session
  cookie, or call the AgentPier API with side effects.
- Forwarding to AgentPier's own ports or any port the owner did not have a session/agent
  report.
- A setup that only works after manual `tailscale serve` commands.

## Decisions taken with the owner

1. **One port per preview, from a pool.** Each active preview gets its own port from a
   configurable range, so the app is served at the root of its own origin
   (`https://<remote-host>:47100/`). Default range: 10 ports, **47100–47109**
   (owner: "a rarely used range, configurable, probed for availability").
2. **Explicit reporting, no detection.** Sessions call `preview_open` on the
   `agentpier_session` MCP; agents use an equivalent bridge action. Tool descriptions and
   session instructions tell them to use it whenever they provide a page to look at or
   test, instead of naming `localhost` URLs.
3. **New tab.** The link opens the app in a new tab; no embedding.
4. **Owner only.** Restricted users' agents do not get the tool; the proxy admits only the
   owner principal.
5. **Step 2 is separate.** AgentPier-managed SSH forwards stay in AGENTPIER-227.
6. **Login tolerates several session cookies.** A preview page can always plant a
   second `agentpier_session` cookie for the host via `document.cookie` (cookies ignore
   ports); today `sessionToken()` (`server/http/login.js`) then refuses both and logs the
   owner out. Owner decision: when several `agentpier_session` cookies arrive, the login
   uses the one that is a valid session and ignores the others (a planted cookie never
   matches a session, so nothing is weakened). No `__Host-` cookie rename (would need
   `Secure` and break plain-HTTP network mode). Applies to every place that reads the
   session cookie (HTTP middleware and all WebSocket attachers).
7. **Previews are a switch, and AgentPier may call `tailscale serve` itself.** Settings ›
   Remote access › Previews has **Enable previews**, off by default. Turning it on or
   changing the range makes the server register (and unregister) the range with
   `tailscale serve` when Tailscale remote access is configured. The update path
   re-applies the registrations only when the switch is on; existing installations get
   no new tailnet ports unasked. When the call fails (no permission, socket missing,
   Tailscale stopped), the card shows the error and the exact command the owner can run;
   previews then still work locally and in network mode.
8. **AGENTPIER-300 is fixed first** in its own PR (config.json merge instead of replace);
   this work starts from a main that contains it.

## Design

### Components

- `server/features/previews/` — a `PreviewService` held on `services`, shared by the
  session MCP tools, the agent bridge action, the HTTP routes and the settings UI.
  - `open({ owner context, port, label, path? })`, `close(id)`, `list(filter)`, and
    hooks for session stop/removal and agent conversation removal.
  - In memory only. Previews do not survive an AgentPier restart (my call: an agent can
    simply call `preview_open` again; persisting proxies across updates adds state for
    little gain).
- `preview-proxy.js` — one `http.Server` per active slot (no Express chain, no
  compression), streaming request/response bodies, raw upgrade piping for WebSockets.
- `preview-mcp.js` — tool entries like `server/features/artifacts/artifact-mcp.js`,
  merged in `McpTools.list/call` (`server/features/mcp/tool-service.js`), gated on
  `context.sessionId` and re-checking the session grant on every call.
- Agent bridge action in `server/features/assistants/team-bridge-actions.js` /
  `team-bridge.js` / `team-plugin/index.js` / `runtime-config.js` /
  `native-capabilities.js`, only for the owner's own agents (same gate as
  `agentpier_hook`, `goalAgent`).

### Tool contract

- `preview_open({ port, label?, path? })` → `{ id, url, port, label }`
  - `port`: the local port the server listens on (1–65535).
  - `label`: short human name shown on the card ("Shop start page").
  - `path`: optional start path appended to the URL (`/admin/login`).
  - Idempotent per (session or agent conversation, port): calling again returns the same
    preview and updates the label/path.
- `preview_close({ id | port })` → `{ closed: true }`.
- `preview_list()` → the caller's active previews.
- Errors (localized for the UI, stable codes for agents): `PREVIEW_NOT_LISTENING`
  (nothing accepts a connection on 127.0.0.1/::1 at that port), `PREVIEW_PORT_FORBIDDEN`
  (AgentPier's own port, the MCP/agent gateway/internal ports, or a port inside the
  preview range), `PREVIEW_RANGE_FULL`, `PREVIEW_DISABLED` (previews switched off),
  `PREVIEW_UNAVAILABLE` (remote exposure not set
  up for the range; message says what the owner has to do).

Target check (my call): the target must accept a TCP connection on loopback at open
time. There is no process-tree ownership check (the owner ruled out detection; the
owner is the only one who can open previews). Forbidden targets: AgentPier's HTTP port,
the preview range itself, and AgentPier-internal listeners the builder finds
(agent gateway, MCP broker if TCP, adapter runtime).

### Port pool and probing

- Sticky allocation (my call): each port is its own browser origin, so localStorage,
  the app's cookies and especially a registered service worker of an earlier app carry
  over to the next app on the same slot. Allocation therefore prefers the slot the same
  project (session cwd / agent) and target port used last (remembered in memory and in
  the stored previews settings, max one entry per slot), then the least recently used
  free slot. `Clear-Site-Data` is not used (it would clear the host-wide AgentPier
  cookie). The remaining risk is documented for the owner.
- Settings stored in `config.json` as `previews: { enabled, portRangeStart, portRangeEnd }`
  (validated: ≥1024, ≤65535, at most 50 ports, must not overlap AgentPier's port, the
  pipeline port range `pipelines.portRangeStart/End`, or the Tailscale HTTPS port).
- Allocation reuses the probing from `server/features/pipelines/run-ports.js`
  (`portAvailable()`: exclusive binds on 127.0.0.1, 0.0.0.0, ::1, ::). Reserve before
  probing; skip ports in use by anything else; `PREVIEW_RANGE_FULL` when none is left.
- Settings › Remote access gets a **Previews** card: the range (editable by the owner,
  locked from network-mode requests like the other network settings), which ports are
  currently free / taken by another program / used by a preview, and the active previews
  with label, session or agent, target port, open link and **Stop**.

### Exposure per access path

AgentPier's host checks (`server/http/security.js`) define three branches; the preview
listener applies the same rules with the slot port.

- **Local:** the slot listens on `127.0.0.1:<slot>`; accepted hosts `127.0.0.1:<slot>`
  and `localhost:<slot>`.
- **Tailscale:** Tailscale Serve terminates HTTPS on `<ts-host>:<slot>` and forwards to a
  local listener. Registration happens once for the whole range, not per preview, through
  one helper used by `npm run tailscale`, the update path and a range change in
  settings: `tailscale serve --bg --https=<slot> http://127.0.0.1:<listener>`. An idle
  slot answers with a localized "no preview on this port" page. The service calls the
  Tailscale CLI with the same socket handling as `scripts/tailscale.mjs`
  (`AGENTPIER_TAILSCALE_SOCKET`); share that code instead of copying it. With previews
  switched off, nothing is registered and `preview_open` answers `PREVIEW_DISABLED`. The builder must verify
  whether Serve on `<slot>` and a local listener on `127.0.0.1:<slot>` can share the
  number on macOS and Linux; if not, use an internal listener offset (e.g. a second,
  derived range on loopback) and document it. Removing previews or changing the range
  removes the old registrations (`tailscale serve --https=<port> off`), only those whose
  target is an AgentPier preview listener (same ownership check as `selectServePort` in
  `scripts/tailscale.mjs`). Accepted requests: loopback peer, `Host` =
  `<remote-host>:<slot>`, non-empty `tailscale-user-login`.
- **Network mode:** the slot listens on `network.bind` (plain HTTP like AgentPier itself);
  accepted hosts are the configured network hosts with the slot port; no `tailscale-*`
  headers.

### Authentication and cookie isolation

Browsers send cookies regardless of port, so `agentpier_session` (httpOnly,
SameSite=Strict, no Domain) reaches every preview origin on the same host.

- Every request and WebSocket upgrade on a preview port must carry a valid owner
  session (`login.require(sessionToken(req))`, principal role `owner`), checked per
  request, plus the host branch above. Otherwise: no forwarding.
- The proxy removes `agentpier_session` from the `Cookie` header before forwarding,
  removes `tailscale-*` identity headers and any AgentPier-specific headers, and drops
  any upstream `Set-Cookie` named `agentpier_session`. Script-set duplicates cannot be
  prevented by the proxy; decision 6 makes them harmless.
- Cross-site navigation (opening the link from Telegram or another app) does not send a
  SameSite=Strict cookie. Without a cookie, the proxy answers with a tiny same-origin
  page that re-navigates to the same URL (then the request is same-site and carries the
  cookie); if there is still no valid session, it shows a localized page with a link to
  sign in to AgentPier and returns afterwards.
- AgentPier's API stays protected from preview pages by its `Origin` check (different
  port ⇒ different origin) and CORS; the builder must confirm no state-changing GET
  route exists that a preview page could trigger same-site, and add a test.
- The proxy does not add AgentPier's CSP or `X-Frame-Options` to the app's responses; the
  app's own headers pass through.

### Proxying behaviour

- Forward to `127.0.0.1:<target>` (fall back to `::1` if the target listens only there),
  preserving method, path, query, body and headers other than those stripped above.
- `Host` sent upstream: `localhost:<target>` (my call: dev servers such as Vite reject
  unknown hosts by default; `localhost` is what they allow). Set `X-Forwarded-Host`,
  `X-Forwarded-Proto`, `X-Forwarded-For` for apps that build absolute URLs.
- Rewrite `Location` headers that point at `http://localhost:<target>` or
  `http://127.0.0.1:<target>` to the preview origin.
- WebSocket upgrades piped raw (Vite HMR connects to the page's own origin by default).
  SSE and chunked responses stream without buffering.
- Upstream not reachable: a localized 502 page "The server on port <target> is not
  answering" with the preview label; the preview stays open (the server may be
  restarting).
- Request bodies are not size-limited beyond Node defaults (my call: uploads are part of
  testing).

### Lifetime

- Session previews close when the session stops or is removed (`onStopped` /
  `onRemoving` in `server/application/services.js`) and when the session's MCP grant is
  revoked; every proxied request re-checks that the session is still running.
- Agent previews close with `preview_close`, when the conversation is deleted, or 24 hours
  after the last proxied request (my call).
- The owner can stop any preview from the session panel or Settings › Remote access.
- Opening, closing and expiring are written to the audit log (session/agent, target port,
  slot; no URLs with query strings, no headers).

### Where the owner sees the link

- **Session view:** a **Previews** section next to the session's Artifacts
  (`web/features/artifacts/SessionArtifacts.jsx` pattern) driven by a live topic
  (e.g. `previews.changed`), each entry with label, target port and **Open preview**
  (opens in a new tab). Optionally the `preview_open` tool result in the chat renders as
  the same card (`ToolOutput`).
- **Agent chat:** a message card with **Open preview**, through the same path as shared
  files (`AgentShares` / attachments) or the action-card store; plus Telegram delivery as
  a message with the link (a URL button if `telegram-send-parts.js` gains one).
- **Settings › Remote access › Previews:** as described above.

### Instructions to sessions and agents

- `preview_open` description and the `agentpier_session` MCP server instructions
  (`server/features/mcp/http-transport.js`): "When you start a server for the user to
  look at or test, call `preview_open` with its port and give the user the returned link
  instead of a localhost URL. Bind the server to 127.0.0.1 or localhost. Close it with
  `preview_close` when it is no longer needed."
- The same guidance in agent bootstrap (`server/features/assistants/assistant-bootstrap.js`)
  for the owner's agents.
- Pipeline sessions do not get the tool (they have no session MCP today).

## Constraints

- AGENTS.md applies: DE/EN catalogs for all UI text and pages served by the proxy,
  ui-guide components only, breakpoints from `web/lib/breakpoints.js`, 600-line files,
  `node:test` + Playwright, docs in the same PR (`docs/remote-access.md`,
  `docs/ssh-access.md` mention of tunnels, a new section on previews, README/README.de
  feature lists).
- Tests never use real Tailscale or the default tmux server; fake the tailscale runner.
- Provisioning of the Tailscale registrations goes through `npm run tailscale` and the
  update path for existing installations.

## Left to the builder

- Module boundaries inside `server/features/previews/`, the live topic name, the exact
  card components (from the ui guide).
- Whether Serve and the local listener can share a port number (see Exposure) and the
  resulting listener layout.
- Which AgentPier-internal ports to forbid, found by inspection.
- How the update path re-applies the Serve registrations (where `npm run tailscale` is
  already part of updates, or a new idempotent step).
- Splitting the work into PR-sized steps, e.g. (1) service, proxy, MCP tools, session
  panel, local + network mode; (2) Tailscale registration and settings card; (3) agent
  bridge action, agent chat card, Telegram. Prefer one PR if it stays reviewable
  (owner prefers fewer CI runs).
