# MCP OAuth qualification

An opt-in contract checks how OpenClaw 2026.9.8 authorizes remote MCP servers with
OAuth (AGENTPIER-37), driven the way AgentPier drives it: the `openclaw` CLI run
against the private state of an isolated Gateway that `RuntimeSupervisor` starts in
a temporary data directory. No external server, account or credential is involved.

`tests/helpers/mcp-oauth-test-server.js` serves, on one `127.0.0.1` origin:

- a Streamable HTTP MCP server at `/mcp` with one tool, `echo`, that accepts only
  unexpired bearer tokens and answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`;
- RFC 9728 protected resource metadata (`resource: <origin>/mcp`), RFC 8414
  authorization server metadata, RFC 7591 dynamic client registration;
- `/authorize` with PKCE S256, auto-approved: it redirects straight to the
  registered redirect URI with `code` and `state` (the test reads the `Location`
  header instead of following it, as the user's browser would);
- `/token` with the authorization code grant (verifier, redirect URI and client
  checked; codes single-use) and the refresh token grant (rotating), configurable
  access token lifetime, refresh token revocation and a mode that refuses every
  token.

`tests/integration/assistant-mcp-oauth-contract.test.js` has two tests:

1. **Login, refresh, revocation, logout, orphaning, environment.** One server
   `docs` with `auth: "oauth"` and `oauth.redirectUrl` on a loopback port the test
   holds open (as AgentPier's own listener holds its port), bound to one agent on
   the deterministic model.
2. **HTTPS redirect URL.** `oauth.redirectUrl` on an HTTPS origin that does not
   resolve locally.

## Running the contract

```sh
set -a; . /tmp/contracts.env; set +a   # see docs/assistant-mcp-qualification.md
node --test --test-concurrency=1 tests/integration/assistant-mcp-oauth-contract.test.js
```

It needs `AGENTPIER_MCP_CONTRACT_RUNTIME` and `AGENTPIER_ASSISTANT_CONTRACT_DIR` and
skips without them. The `native-contracts` CI job runs it with the other native
contracts and fails on any skip.

On 2026-10-11 it passed on macOS arm64 (Darwin 25.5) against the
`2026.9.8-node26.7.0-darwin-arm64-lock563cf3904093` runtime: 2 tests in about 60
seconds, 0 skips, 0 failures. Each CLI call took 1.0 to 1.9 seconds.

## Configuration

```json
{
  "url": "https://mcp.example.com/mcp",
  "transport": "streamable-http",
  "auth": "oauth",
  "oauth": { "redirectUrl": "<AgentPier origin>/api/mcp-servers/oauth/callback" }
}
```

`mcp.servers.*.auth` and `mcp.servers.*.oauth` reload hot. OpenClaw registers
itself by DCR as a public client for exactly the configured redirect URL:
`{"client_name":"OpenClaw MCP","redirect_uris":[<redirectUrl>],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}`.

## Verified facts

### (a) `openclaw mcp login <name>` with the redirect port taken

Exit code `0`, empty stderr, about 1.1 seconds, no hang. Stdout, exactly:

```
Could not start the local OAuth callback (listen EADDRINUSE: address already in use 127.0.0.1:<port>).
Open this URL to authorize "<name>":
<authorization URL>
After approval, run openclaw mcp login <name> --code <code>.
```

The authorization URL is the line after `Open this URL to authorize "<name>":`. Its
query carries `response_type=code`, `client_id`, `code_challenge`,
`code_challenge_method=S256`, `redirect_uri` (the configured URL), `state` (a UUID,
36 characters) and `resource` (the server URL). AgentPier reads `state` from that
URL (`new URL(line).searchParams.get("state")`).

If the CLI can bind the redirect host and port (loopback HTTP only), it does not
exit: it prints `Waiting for the browser to return to OpenClaw...` and waits up to
300 seconds for the callback (from the 2026.9.8 source, `MCP_OAUTH_CALLBACK_TIMEOUT_MS`;
not exercised). A `localhost` redirect binds every address `localhost` resolves to,
and any failed bind counts as taken. AgentPier must therefore always configure a
redirect URL its own listener occupies (or an HTTPS one, see (g)).

### (b) `openclaw mcp login <name> --code <code>`

Exit code `0`, stdout `MCP OAuth credentials saved for "<name>".`. The CLI takes
only the code: **it does not check `state`**, so AgentPier's callback must compare
the callback's `state` with the one from the printed URL before passing the code.
A second `--code` after completion exits `1` with
`Reason: Missing MCP OAuth authorization session. Run the login flow again.` on
stderr (the PKCE verifier is consumed).

Without a config reload, the next agent turn offers `<name>__echo` and calls the
server with the new token, **provided no turn tried to start the server while it
lacked credentials within the startup backoff** (see below).

**Startup backoff.** A turn that starts an OAuth server without usable credentials
fails the start (`[bundle-mcp] failed to start server "<name>" ... requires OAuth
authorization. Run openclaw mcp login <name>.`), runs on without the tools, and
backs that server off: other sessions are offered nothing for 30 seconds, doubling
with every further failed start up to 10 minutes. The key includes the workspace,
agent and server config fingerprint. Valid tokens written by `login --code` do not
lift it: a turn right after a completed re-login was offered nothing. Any hot change
under `mcp` resets the backoff (the reload plan's `disposeMcpRuntimes`); after
`patchConfig` with `mcp.sessionIdleTtlMs` the next turn offered the tool. The
Gateway has no RPC to reset it otherwise (`mcp.*` RPCs: only `mcp.authLogin`).
AgentPier must reset the backoff after a successful login, for example by a
deliberate `mcp` patch.

### (c) `openclaw mcp status --json`

```json
{
  "path": "<OPENCLAW_CONFIG_PATH>",
  "servers": [
    {
      "name": "docs",
      "configured": true,
      "enabled": true,
      "ok": true,
      "transport": "streamable-http",
      "launch": "http://127.0.0.1:<port>/mcp",
      "requestTimeoutMs": 60000,
      "connectionTimeoutMs": 30000,
      "supportsParallelToolCalls": false,
      "auth": "oauth",
      "authStatus": {
        "hasTokens": false,
        "requiresAuthorization": false,
        "hasClientInformation": false,
        "hasCodeVerifier": false,
        "hasDiscoveryState": false,
        "hasLastAuthorizationUrl": false,
        "state": "unauthenticated"
      }
    }
  ]
}
```

`authStatus` by situation (flags in the order above, `expiresAt` in epoch ms):

| Situation                             | tokens | reqAuth | client | verifier | discovery | lastUrl | `state`                  |
| ------------------------------------- | ------ | ------- | ------ | -------- | --------- | ------- | ------------------------ |
| never logged in, or after logout      | no     | no      | no     | no       | no        | no      | `unauthenticated`        |
| login printed the URL                 | no     | no      | yes    | yes      | yes       | yes     | `pending-authorization`  |
| `--code` completed                    | yes    | no      | yes    | no       | yes       | no      | `authorized` + expiresAt |
| refresh token revoked (invalid_grant) | no     | no      | yes    | no       | yes       | no      | `pending-authorization`  |
| token still refused after a refresh   | yes    | yes     | yes    | no       | yes       | no      | `requires-authorization` |

A revoked refresh token does **not** yield `requires-authorization`: the MCP SDK
drops the tokens on `invalid_grant`, which leaves `pending-authorization` without
tokens. AgentPier must treat "`pending-authorization` and `hasTokens: false` with no
login in progress" as needing a login, like `requires-authorization`.
`requires-authorization` arises when the server refuses the token again after one
refresh (or answers 403 `insufficient_scope`). `expiresAt` follows the token's
`expires_in`; it moves forward after each refresh.

### (d) Refresh

- Proactive: a token within 30 seconds of `expiresAt` is refreshed on the next
  request (`refresh_token` grant), unattended; the turn is offered and calls the
  tool.
- Reactive: when the server answers 401 to a token OpenClaw believes valid, it
  refreshes once and retries; the call succeeds.
- Revoked refresh token: the turn still completes (`agent.wait` status `ok`),
  without the server's tools; status as in (c); the start enters the backoff.
- `openclaw mcp login <name>` on a server that still holds a refresh token
  refreshes and prints `MCP OAuth credentials saved for "<name>".` without a URL.

### (e) Logout, rename, URL change

- `openclaw mcp logout <name>`: exit `0`, stdout
  `MCP OAuth credentials cleared for "<name>".`; status `unauthenticated` with every
  flag false (the DCR client is dropped too).
- Renaming the server (same URL) shows the new name `unauthenticated`; changing the
  URL (here `127.0.0.1` to `localhost`) shows `unauthenticated`; restoring the
  original name and URL shows `authorized` again. The row stays in
  `<state>/state/openclaw.sqlite` as an orphan, keyed by name and URL. AgentPier must
  run `logout` under the old name and URL before renaming or changing it.

### (f) Environment

The CLI needs `HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` of the
Gateway (`runtimeEnvironment(paths, …)`; plus a `PATH`). It needs neither
`OPENCLAW_GATEWAY_TOKEN` nor a running Gateway: `status`, `login` and `logout`
worked the same after `runtime.close()`. With `HOME` alone it reads
`<HOME>/.openclaw/openclaw.json` and lists no servers. The Gateway picks up tokens
written by the CLI on its next request; no restart happened.

### (g) HTTPS redirect URL

With `oauth.redirectUrl: "https://agentpier.invalid/api/mcp-servers/oauth/callback"`
`login` exits `0` at once and prints:

```
Could not start the local OAuth callback (OAuth callback redirect must use HTTP on a loopback address).
Open this URL to authorize "<name>":
<authorization URL>
After approval, run openclaw mcp login <name> --code <code>.
```

The URL carries that `redirect_uri`; the authorization server redirects there, and
`--code` with that code completes (`authorized`).
