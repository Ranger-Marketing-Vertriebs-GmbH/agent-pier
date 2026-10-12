# Central MCP servers in the coding CLIs: qualification

What AgentPier relies on when it writes central MCP servers into the native
configuration of Claude Code, Codex and OpenCode, and how to re-establish it after a
CLI update. Contracts: `tests/integration/cli-mcp-contract.test.js` and
`tests/integration/cli-mcp-login-probe.test.js`; both run the installed CLIs only in a
temporary HOME.

```sh
AGENTPIER_CLI_MCP_CONTRACT=1 AGENTPIER_CLI_CONTRACT_DATA_DIR=<AgentPier data dir> \
  node --test tests/integration/cli-mcp-contract.test.js
AGENTPIER_CLI_MCP_LOGIN_PROBE=1 AGENTPIER_CLI_CONTRACT_DATA_DIR=<AgentPier data dir> \
  node --test tests/integration/cli-mcp-login-probe.test.js
```

Qualified versions: Claude Code 2.1.296, Codex 0.160.1, OpenCode 1.18.35.

The temporary HOME (`tests/helpers/cli-contract.js` `isolatedHome()`) also holds
`CODEX_HOME`, the XDG directories and Claude Code's `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR`. `CLAUDE_SECURESTORAGE_CONFIG_DIR` does not keep
Claude Code off the macOS keychain: it only changes the hashed service name of its
items (`Claude Code-credentials-<hash>`). The tests keep the keychain and any browser
out with stubs for `security`, `open`, `xdg-open` and `$BROWSER` first on PATH:
Claude Code runs `security` through PATH, the stub fails, and Claude Code keeps
credentials in `$CLAUDE_CONFIG_DIR/.credentials.json`. Codex runs with
`mcp_oauth_credentials_store="file"`; OpenCode keeps tokens in its XDG data
directory.

## Native entries

`tests/fixtures/cli-mcp-shapes.js` is the source of truth; `nativeMcp()` produces it.

| Server             | Claude Code (`~/.claude.json` `mcpServers`) | Codex (`~/.codex/config.toml` `mcp_servers`) | OpenCode (`opencode.json(c)` `mcp`)                              |
| ------------------ | ------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| stdio              | `{type:"stdio",command,args,env}`           | `{command,args,env[,cwd]}`                   | `{type:"local",command:[cmd,...args],environment[,cwd],enabled}` |
| HTTP, headers      | `{type:"http",url,headers}`                 | `{url,http_headers}`                         | `{type:"remote",url,headers,enabled}`                            |
| SSE, headers       | `{type:"sse",url,headers}`                  | none (no SSE)                                | `{type:"remote",url,headers,enabled}`                            |
| HTTP or SSE, OAuth | `{type:"http"\|"sse",url}`                  | `{url[,scopes:[...]]}` (HTTP only)           | `{type:"remote",url,oauth:{[scope]},enabled}`                    |

## Support

- Claude Code: stdio, HTTP, SSE. A stdio `cwd` is not in its schema (`claude mcp add-json` drops it), so a server with a working directory cannot be bound.
- Codex: stdio (with `cwd`) and streamable HTTP. There is no SSE form; an SSE endpoint written as `url` is treated as streamable HTTP. SSE servers cannot be bound.
- OpenCode: stdio (`local`) and `remote`; `remote` reaches SSE servers (it falls back from streamable HTTP to SSE). A `local` entry's `cwd` is honoured: OpenCode starts the command in that directory (the contract compares real paths, since `/tmp` is `/private/tmp` on macOS).
- Claude Code rewrites `~/.claude.json` on every start but keeps `mcpServers` entries as written; the TOML and JSONC files keep entries as written. Entry hashes therefore stay stable.

## Listing and OAuth status

- `claude mcp list` (text, health-checks each server): `<name>: <url> (HTTP|SSE) - <status>`; an OAuth server without a login shows a status asking for authentication (`! Needs authentication`), a connected one `✔ Connected`. `claude mcp get <name>` prints a `Status:` line with the same values. No machine-readable output: AgentPier shows the login hint "run `/mcp`".
- `codex mcp list --json`: one object per server with `transport.type` (`stdio`, `streamable_http`) and `auth_status` (`o_auth` logged in, `not_logged_in`, `bearer_token`, `unsupported`, `unknown`). AgentPier reads OAuth status from here, for the owner's own profile (`local-codex`, `~/.codex`) only. AgentPier-managed Codex accounts pin `mcp_oauth_credentials_store="file"` in their own `CODEX_HOME`, so their logins are separate and not reflected in that status; each logs in with `codex mcp login <name>` in a session of that account. Observed: `bearer_token` for an entry with an `Authorization` header, `unsupported` for stdio, `unknown` for a URL that does not announce OAuth.
- `opencode mcp list` and `opencode mcp auth list` (text): status per server, `authenticated`/`not authenticated` for OAuth servers. `mcp auth list` lists every `remote` server, including header-only ones (shown as `not authenticated`), so only entries AgentPier wrote with `oauth` carry meaning there. No machine-readable output: AgentPier shows the hint `opencode mcp auth <name>`.

## OAuth login brokering

AgentPier brokers agent logins by receiving the provider's callback on its own origin.
For the CLIs the probe starts each login with the authorization URL printed instead of
a browser, approves it, and hands the callback URL back to the CLI, once directly and
once rewritten to AgentPier's origin (with the CLI's custom-redirect setting where one
exists: Codex `mcp_oauth_callback_url`, OpenCode `oauth.redirectUri`; Claude Code has
only `--callback-port`).

| CLI         | Redirect URIs requested                                                                                         | Status after the brokered login                                                               | Brokering     |
| ----------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| Claude Code | `http://localhost:<random port>/callback`                                                                       | `Status: ✔ Connected` from a pasted callback, but the redirect never names AgentPier's origin | does not work |
| Codex       | `https://agentpier.example.test/api/mcp-servers/cli-oauth/callback/<suffix>` (configured URL plus a suffix)     | `o_auth`                                                                                      | works         |
| OpenCode    | none: with an `https` `redirectUri` it fails before authorizing ("Failed to start server. Is port 443 in use?") | `not authenticated`                                                                           | does not work |

Details from the probe:

- Codex appends a per-server path segment (the same in each login of one server, for
  example `/CfF3l-D9FucJ`) to `mcp_oauth_callback_url`, also to its default loopback
  callback. A broker must accept `<callback>/<segment>` and hand the full callback URL,
  path included, to `codex mcp login --no-browser`; the query alone is refused.
- Claude Code's `--no-browser` login accepts a pasted callback URL of any origin (it
  reads `code` and `state`), but the authorization server always redirects the browser
  to `http://localhost:<port>/callback`, which has no setting.
- OpenCode has no prompt for a pasted callback. It always listens for the callback
  itself: on `127.0.0.1:19876` by default (a fixed port), or on the host and port of
  `oauth.redirectUri`, which must therefore be a local address it can bind. A callback
  delivered to that listener completes the login (`authenticated`).

Brokered CLI logins are a separate follow-up task, only for the CLIs marked "works".
Until then AgentPier shows each CLI's own login command.
