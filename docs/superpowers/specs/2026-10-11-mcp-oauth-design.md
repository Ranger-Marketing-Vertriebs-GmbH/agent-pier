# OAuth for remote MCP servers

Status: agreed design. Plane: AGENTPIER-37 (follows AGENTPIER-29, central MCP list).

Date: 2026-10-11

## Goal

A remote MCP server in AgentPier's central list can sign in with OAuth. The owner
clicks "Log in", approves at the provider, and the server's tools become available
to the agents bound to it. Tokens are refreshed without the owner's involvement.

## Owner decisions

- OAuth is the second authentication method for remote servers, next to static
  headers (token). Servers without dynamic client registration, for example
  GitHub, keep using a token in the headers.
- The redirect target is AgentPier's own address:
  - the configured HTTPS remote origin (Tailscale Serve) when present;
  - otherwise the loopback address on the AgentPier host.

  In network mode without Tailscale (plain HTTP), AgentPier states before the login
  starts that OAuth needs HTTPS or the AgentPier host itself.

- OAuth logins are not part of backups. After a restore the server shows "Login
  required".
- Only the owner starts a login in AgentPier. Agents do not start MCP logins.
- Optional OAuth settings (scope) live in the server's advanced section.

## Verified facts (OpenClaw 2026.9.8, read from the dist; live check in Task 1)

- Config: `mcp.servers.<name>.auth: "oauth"` and an optional strict
  `oauth: { scope?, redirectUrl?, clientMetadataUrl?, identity?, authProfileId? }`.
  There is no client id or secret key; registration uses dynamic client
  registration (or a client metadata document).
- The bundled MCP SDK 1.30.0 performs discovery, registration, PKCE, code exchange
  and refresh. OpenClaw stores everything in `<state-dir>/state/openclaw.sqlite`
  (table `mcp_oauth_stores`), keyed by a hash of server name and URL. Renaming a
  server or changing its URL orphans the login.
- At runtime OpenClaw injects the token on every request, refreshes ahead of
  expiry, retries once on 401, and omits a server without credentials from the
  agent's tools instead of failing the turn. A new token is used on the next
  request without a config reload.
- Login entry points:
  - CLI `openclaw mcp login <name>` binds a loopback listener on the redirect
    URL's host and port. If it cannot bind, it prints the authorization URL and
    exits.
  - `openclaw mcp login <name> --code <code>` completes the exchange without
    checking `state`.
  - `openclaw mcp logout <name>` clears the stored login.
  - `openclaw mcp status --json` reports `authStatus.state`: `authorized`
    (with `expiresAt`), `requires-authorization`, `pending-authorization`,
    `unauthenticated`.
- The Gateway RPC `mcp.authLogin` requires the browser on the Gateway's own
  origin with a fixed callback path, so it does not fit behind AgentPier.

## Architecture

### Configuration

- A remote server record gains `auth: "headers" | "oauth"` (default `headers`,
  existing records unchanged) and optional `oauthScope`.
- The compiler writes `auth: "oauth"` and
  `oauth: { redirectUrl, scope? }` for OAuth servers. `redirectUrl` is
  `<AgentPier origin>/api/mcp-servers/oauth/callback`, where the origin is the
  configured HTTPS remote origin or else the loopback address. A change of origin
  changes the compiled config like any other MCP change (hot reload).
- An OAuth server compiles no `Authorization` header; OpenClaw strips it anyway.

### Login flow

1. The owner presses "Log in" on a server. AgentPier refuses with a clear message
   when no usable redirect origin exists (plain HTTP, non-loopback).
2. AgentPier runs `openclaw mcp login <name>` with the Gateway's private
   HOME/state/config environment. The redirect port is AgentPier's own, so the
   CLI cannot bind it, prints the authorization URL and exits.
3. AgentPier parses the URL, records `{ server, state, startedAt }` as a pending
   login (expires after 10 minutes) and returns the URL. The browser opens it.
4. The provider redirects to the callback route. AgentPier requires an
   authenticated owner session, matches `state` to a pending login (single use),
   and runs `openclaw mcp login <name> --code <code>`.
5. The callback page reports success or the provider's error and returns to the
   MCP list.

Every CLI call has a timeout, never logs the authorization code or tokens, and
returns stable error identifiers (DE/EN messages in the UI).

### Status and logout

- The MCP list shows per OAuth server: "Connected" (with expiry if known),
  "Login required", "Login in progress", "Not connected". The status comes from
  `openclaw mcp status --json`, cached briefly and refreshed after login, logout
  and on opening the list.
- "Log out" runs `openclaw mcp logout <name>`.
- Before a rename, URL change, switch to headers, or delete of an OAuth server,
  AgentPier logs out under the old name and URL. Afterwards the server shows
  "Login required" where applicable.

### Errors

- A provider without dynamic client registration: the login fails with a message
  pointing to the token option.
- A provider rejecting the redirect URI: the message names the redirect address
  in use.
- `insufficient_scope` or a revoked token: the status changes to "Login
  required"; agents keep running without that server's tools.

### Backups

OAuth logins are not exported. Restored OAuth servers show "Login required".

### Agents

Bindings are unchanged. A bound OAuth server without a valid login is omitted by
OpenClaw from the agent's tools. The binding UI shows the server's login status.

## Testing

- **Live contract against OpenClaw 2026.9.8** with a local mock authorization
  server (protected resource metadata, dynamic client registration, PKCE, refresh)
  and a mock MCP server requiring the bearer token:
  - the login CLI prints a parsable URL when the port is taken;
  - `--code` completes and the agent's next turn lists the server's tools;
  - refresh after expiry works unattended;
  - logout makes the server unavailable;
  - status JSON shapes for each state;
  - rename and URL change orphan the login (pinning the logout-first rule).
- **Unit and integration:** compile output, redirect origin selection, pending
  login state (expiry, single use, wrong state), CLI wrapper (timeouts, parsing,
  redaction), routes, status caching.
- **Browser:** log in, status, log out, error states, English and German, 390 px.

## Out of scope

Per-requester OAuth identities (stage 2), `authProfileId`, client metadata
documents, OAuth for stdio servers, OAuth for CLI profile bindings
(AGENTPIER-38).
