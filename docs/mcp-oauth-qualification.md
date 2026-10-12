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

`tests/integration/assistant-mcp-oauth-compiled-contract.test.js` drives AgentPier's
own path instead of the CLI by hand, in team mode as
`server/application/assistant-graph.js` wires it: the server store, the start
compile and `McpChanges`' live patches, `McpOAuthLogins` with the real CLI wrapper
(`supervisorMcpCli`) on the Gateway's private state, and the HTTP routes
(`mcpServerRoutes`, `mcpOAuthCallbackRoutes`) on a loopback listener whose port is
the compiled redirect, as AgentPier's own listener is. One test, see
[the compiled path](#compiled-path) below.

## Running the contract

```sh
set -a; . /tmp/contracts.env; set +a   # see docs/assistant-mcp-qualification.md
node --test --test-concurrency=1 tests/integration/assistant-mcp-oauth-contract.test.js \
  tests/integration/assistant-mcp-oauth-compiled-contract.test.js
```

Both need `AGENTPIER_MCP_CONTRACT_RUNTIME` and `AGENTPIER_ASSISTANT_CONTRACT_DIR` and
skip without them. The `native-contracts` CI job runs them with the other native
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

AgentPier does so once after every successful login (`--code`, or a start that only
refreshed) while a Gateway is ready: `McpOAuthLogins.resetBackoff` patches
`mcp.sessionIdleTtlMs` through `patchConfig` under the assistants' admission lock.
Unset and `0` mean the same to OpenClaw (MCP runtimes live until their session
ends), so the patch toggles between them (`nudgedIdleTtl`: unset to `0`, `0` to
unset; an owner's positive value moves by 1 ms). The contract applies exactly this
patch (unset to `0`); a manual probe on 2026-10-11 confirmed that `0` to unset lifts
the backoff as well. The compiled MCP signature does not include the key, so the
toggle never triggers a re-apply (a unit test applies after the nudge and sees no
patch), and a Gateway start drops it. The reset is not free: the reload disposes the
MCP runtimes of every session (stdio servers restart too), once per login.

**Known defect (OpenClaw 2026.9.8): verifier mismatch.** Rarely, `login --code`
exits `1` with `[openclaw] Reason: InvalidGrantError`. The authorization server
refused the code exchange because the `code_verifier` did not match the
`code_challenge` in the URL that the same `login` had just printed. OpenClaw's SDK
then repeats the exchange with the now-used code, which is refused as well. There was
one registration, one authorization and no other OAuth traffic, and AgentPier ran no
other CLI call in between. The mismatch is therefore inside OpenClaw. Every
occurrence followed a turn that had just started the server without credentials:
a first login, the login after the start-up drain, or the live contract's login
after its logged-out turn (CI job 114686246612, 2026-10-12, Linux). Frequency: two
of about twelve CI runs of the compiled contract on 2026-10-12, and about one in
twelve loaded local runs. Owner impact: a rare failed login (`oauth=error`,
`reason=cli-failed`) that succeeds when started again. The compiled contract repeats
such a login once and reports it with a test diagnostic. Any other failure, or a
second mismatch, still fails.

Accepted exposure: the CLI takes the code only as an argument (no stdin input), so
for the about one second `login --code=<code>` runs, other local users of the
AgentPier host can see the authorization code in the process list. PKCE (the
verifier stays in OpenClaw's private state) and single use limit what such a code is
worth; AgentPier accepts this and never logs the code itself.

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
| a turn tried it without any login     | no     | no      | no     | –        | –         | –       | `pending-authorization`  |
| a Gateway request after logout        | no     | no      | no     | no       | no        | no      | `pending-authorization`  |
| token still refused after a refresh   | yes    | yes     | yes    | no       | yes       | no      | `requires-authorization` |

A revoked refresh token does **not** yield `requires-authorization`: the MCP SDK
drops the tokens on `invalid_grant`, which leaves `pending-authorization` without
tokens. AgentPier must treat "`pending-authorization` and `hasTokens: false` with no
login in progress" as needing a login, like `requires-authorization`, but only when
OpenClaw holds a client registration (`hasClientInformation`) or AgentPier connected
the server before: an agent turn that tries a server never logged in leaves
`pending-authorization` without a client (the compiled contract reads the flags the
wrapper keeps; `–` was not recorded), and that server still reads "Not connected".
The contract asserts the top-level keys of `status --json` (`path`, `servers`) and of
each server entry (the fields above), and the full `authStatus` of every state in
the table.
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
  `MCP OAuth credentials cleared for "<name>".`; every flag false (the DCR client is
  dropped too; the row becomes `{ credentialState: "cleared" }`). The state is
  `unauthenticated` only while no Gateway MCP request reaches the server: any such
  request after the logout is answered 401, and OpenClaw records the server's
  `WWW-Authenticate` challenge on the cleared row (`authorizationChallenge` without
  `requiresAuthorization`), which `projectMcpOAuthCredentialsStatus` reports as
  `pending-authorization` with every flag false, as for a server never logged in.
  This happened once on macOS CI (2026-10-12), between the logout and the next
  status read, after the `requires-authorization` step. The contract therefore
  asserts all flags false and either state right after the logout, then runs a turn
  (after the backoff-reset nudge) and asserts `pending-authorization` without flags;
  `unauthenticated` exactly is asserted in (f), with the Gateway stopped. AgentPier
  needs no change: that state without a client and without an AgentPier login reads
  "not-connected" (or "login-required" for a server connected before).
- Renaming the server (same URL) shows the new name `unauthenticated`; changing the
  URL (here `127.0.0.1` to `localhost`) shows `unauthenticated`; restoring the
  original name and URL shows `authorized` again. The row stays in
  `<state>/state/openclaw.sqlite` as an orphan, keyed by name and URL. AgentPier must
  run `logout` under the old name and URL before renaming or changing it.
- `logout` also works when the Gateway's config no longer names the server: with
  `OPENCLAW_CONFIG_PATH` pointing at a private one-server config (`{ mcp: { servers:
{ <name>: <compiled entry> } } }`) and the Gateway's state directory, the login for
  that name and URL is cleared. The contract renames the server away, clears the
  orphan this way, and finds it `unauthenticated` when the name returns.

AgentPier therefore always logs out through such a config, written to a 0700
directory with a 0600 file inside the Gateway's private state directory and removed
afterwards (leftovers of a killed run are swept when the assistant services start).
A logout that fails anyway (runtime unavailable, timeout, CLI error) never blocks the
owner's edit or delete. It is recorded in `oauth_logouts` (name, URL, transport; no
secret beyond the URL the store already holds) and:

- an OAuth server with that same name and URL is not compiled (left out like an
  unbound server, status "login-required" with reason `logout-pending`) until the
  logout went through, so OpenClaw cannot reuse the old tokens;
- the entries drain in the background, outside the admission lock, one at a time,
  retried from one second up to ten minutes; a drain that frees a current server
  applies the store so it compiles again. Entries that match no server never make
  an apply pending;
- one bounded pass runs before a Gateway start compiles; it stops at the first
  timeout or missing runtime, so a broken CLI delays a start by one timeout at most;
- a login of a server with that name and URL clears its entry first and is refused
  while that fails.

### (f) Environment

The CLI needs `HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` of the
Gateway (`runtimeEnvironment(paths, …)`; plus a `PATH`). It needs neither
`OPENCLAW_GATEWAY_TOKEN` nor a running Gateway: `status`, `login` and `logout`
worked the same after `runtime.close()`. With `HOME` alone it reads
`<HOME>/.openclaw/openclaw.json` and lists no servers. The Gateway picks up tokens
written by the CLI on its next request; no restart happened.

The CLI and the Gateway share the state database (`state/openclaw.sqlite`). OpenClaw
2026.9.8 takes the per-server OAuth lease (`core:mcp-oauth/<server>`) in write
transactions with `busyTimeoutMs=0`: while another process writes, `login` and
`logout` exit `1` at once with `[openclaw] Reason: database is locked`
(`failureKind=lock-contention`, `step=begin`), and the Gateway fails an MCP server
start the same way (`State lease operation and cleanup failed | ... database is
locked`). CI saw the CLI case on macOS (2026-10-12); a second process holding short
write transactions failed 2 of 10 sequential logouts. A failed release can leave
the lease held until it expires (60 s): the next call waits up to 30 s and fails
with `state lease ... is held by ...`. The wrapper repeats a call (after 250 ms and
1 s) only when the lease's own transaction could not start: `store unavailable
(sqlite-busy)`, or `database is locked` from `operation=state.lease ... step=begin`.
Before the lease nothing has happened, so a `--code` keeps its code unused. The same
signature can come from the lease's release after a completed `--code`. The dead CLI
then still holds the lease, so the repeat usually ends in `cli-timeout` after about
22 s. Otherwise it ends in `session-missing`. Either way it never exchanges again,
and the saved tokens stay. When `--code` fails, AgentPier reads `mcp status` once.
If OpenClaw reads `authorized` with tokens, the login counts as connected: it is
recorded, the backoff is lifted and the callback reports success. A lock
anywhere else may come after the code exchange. Repeating `--code` with the used
code would make the SDK invalidate the tokens it had just saved, so such a failure
is reported as it is. Each repeat puts `--code=<code>` in the process list once more,
within the exposure accepted in (b).

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

## Compiled path

The compiled contract runs one server `docs` (logged in) and one server `spare`
(never logged in), both `auth: "oauth"`, created through `POST /api/mcp-servers` and
bound to one agent. It verifies, against the pinned Gateway and the mock
authorization server:

- **Compile.** The start compiles both with
  `oauth: { redirectUrl: "http://127.0.0.1:<listener port>/api/mcp-servers/oauth/callback" }`,
  `auth: "oauth"` and no headers; the list reads "not-connected".
- **Backoff and nudge.** A turn before any login runs (`agent.wait` `ok`), is
  offered no MCP tool and backs the servers off; OpenClaw then reports
  `pending-authorization` without a client, which still reads "not-connected".
- **Login.** `POST /api/mcp-servers/<id>/oauth/login` (origin `http://127.0.0.1:<port>`)
  answers `authorize` with a URL for the compiled redirect; the list reads
  "login-pending". The mock authorization server auto-approves; the callback route
  with `code` and `state` answers `303` to `/accounts?oauth=connected&server=<id>`,
  and replaying it answers `400 state-invalid`. The list reads "connected" with
  `oauthExpiresAt`, OpenClaw `authorized`, and the post-login nudge set
  `mcp.sessionIdleTtlMs` to `0`. The next turn, inside the backoff window of the
  failed one, is offered `docs__echo` and calls it.
- **Refresh.** The first token is stale at once (31 s lifetime against the 30 s
  skew); the turn after the login refreshes it unattended. After a server-side
  expiry the call refreshes once and succeeds.
- **Unauthenticated server.** `spare` is bound throughout and never offered; no
  turn fails because of it and it never reaches its token endpoint.
- **Logout.** `POST .../oauth/logout` answers `204`; OpenClaw holds no login
  (`unauthenticated`, or `pending-authorization` without flags once a Gateway MCP
  request reached the server, see (e)), the list reads "not-connected", and the next
  turn has no tools.
- **Rename.** After a second login, `PUT` renames `docs` to `renamed`: the logout
  under the old name runs first, `renamed` holds no login, and renaming back finds
  none for `docs` either (OpenClaw alone keeps the orphan, see (e)). No Gateway
  restart happened up to here.
- **Deferred logout drained at the start.** After a third login the Gateway stops
  and the wrapper's logouts fail as a timed-out CLI would. A rename answers with
  `oauthWarning.code: "oauth-logout-deferred"`; after renaming back, `docs` (same
  name and URL as the deferred entry) reads "login-required" with reason
  `logout-pending`. The next start drains the entry with the real CLI before it
  compiles: no deferred logout remains, `docs` is compiled again and
  `unauthenticated`, and a fourth login offers the tool again.

On 2026-10-11 it passed on macOS arm64 against the same runtime in about 65
seconds.
