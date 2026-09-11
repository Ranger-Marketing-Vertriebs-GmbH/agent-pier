# Local and remote MCP

AgentPier exposes OAuth-protected Streamable HTTP at `/mcp`. A configured HTTPS origin serves remote clients privately through the Tailscale tailnet. Without a configured remote origin, the server offers its actual fixed-port loopback HTTP address for CLIs running on the AgentPier host. AgentPier runs the authorized pipelines on its host.

Grants limit the MCP API. They do not provide OS-level isolation from the trusted local host user or the AgentPier owner, who retain administrative access to application files and the owner interface.

## Prepare the connection

Open **Settings → MCP & Zugriffe** to copy the actual server address. For use on the same machine, HTTP is allowed only for `localhost`, `127.0.0.1` or `[::1]` with an explicit fixed port. The server supplies `http://127.0.0.1:<actual-port>/mcp` when no remote origin is configured; do not copy that address to another computer.

For a CLI on another computer, configure [private HTTPS access](remote-access.md) on the AgentPier host. Its setup script records the actual `remoteUrl`. A configured HTTPS address remains HTTPS, and an invalid remote configuration is reported rather than silently downgraded to local HTTP. Other HTTP hostnames, LAN addresses and tailnet addresses are not offered as MCP setup URLs.

For remote access, your CLI computer must be connected to the same tailnet. For local HTTP, run both the CLI and browser on the AgentPier host. Complete browser authorization on the CLI computer using the AgentPier owner's access, so that its loopback callback reaches the CLI. No provider API key belongs in these commands.

The commands below use `MCP_URL` for the exact address copied from Settings. The in-app instructions substitute the configured address directly.

## Codex

```sh
codex mcp add agentpier --url "$MCP_URL"
codex mcp get agentpier
codex mcp list
```

Adding the server already starts OAuth and opens browser consent. Only if that login needs to be retried, run:

```sh
codex mcp login agentpier --oauth-client-registration dcr
```

DCR explicitly selects dynamic public-client registration for this retry. Repeating login after a successful add can create another grant. For removal:

```sh
codex mcp logout agentpier
codex mcp remove agentpier
```

See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Command options were checked against the existing Codex 0.153.4 binary and official documentation on 2026-09-07.

## Claude Code

```sh
claude mcp add --transport http --scope user agentpier "$MCP_URL"
```

Open Claude Code, run `/mcp`, choose AgentPier and authenticate in the browser. Check and remove with:

```sh
claude mcp get agentpier
claude mcp list
claude mcp remove --scope user agentpier
```

See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp). The HTTP and user-scope syntax was checked against the existing Claude Code 2.1.263 binary and official documentation on 2026-09-07.

## OpenCode 1.x

Merge the following entry into `mcp` in your existing `opencode.json`, replacing `COPIED_MCP_URL` with the address from Settings. Keep your other configuration entries.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentpier": {
      "type": "remote",
      "url": "COPIED_MCP_URL",
      "enabled": true
    }
  }
}
```

```sh
opencode mcp auth agentpier
opencode mcp list
opencode mcp debug agentpier
```

To remove credentials, run `opencode mcp logout agentpier`, then remove `mcp.agentpier` from the configuration. See the [official OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/). Command availability was checked against the existing OpenCode 1.18.29 binary on 2026-09-07. This uses the 1.x configuration format, not the separate v2 documentation schema.

## Review and revoke access

CLI login redirects to `/settings/mcp?authorization=<opaque-id>`. The owner sees the client-provided name, client ID, callback URLs, expiry and requested permissions. Names and callback addresses are shown as text. The initial selection includes only requested catalog and run read permissions. Projects, source accounts and provider connections all start unselected; each resource group remains inaccessible until explicitly selected. Select both the source account and central provider connection when granting runs that use a central provider.

To start pipelines, explicitly select **Läufe starten** (`runs:start`) during browser consent, together with the needed projects, source accounts and provider connections. The initial read-only selection does not authorize starting runs. Add `definitions:write` only when the client should edit profiles or pipelines, and `runs:cancel` when it should cancel its own runs.

Publication is a separate, initially unchecked permission. It permits pipeline publication steps such as pushes and pull requests. Human approval gates remain in the web interface.

The connected-client list shows grants in pages of 20, including permissions, resource limits, dates, last use and revocation status. Revoking a grant stops future access using its credentials. Removing a server or logging out in the CLI does not necessarily revoke its server grant; revoke it in Settings as well.

Browser reloads only read state. Approval, denial and revocation require explicit actions. Expired or rejected requests show an error; restart login from the CLI to obtain a fresh authorization request.

## Verification limits

Browser regressions use synthetic API fixtures and an isolated application data directory. They cover setup, copy actions, consent selections, callbacks, expiry/errors, revocation, pagination and mobile layout. These checks do not by themselves establish successful native OAuth UX in all three CLIs. Endpoint tests cover explicit-port loopback HTTP and reject non-loopback HTTP, missing ports and credentials/query fragments. End-to-end protocol and authorization tests are separate from these UI fixtures.

Installed CLI verification against an isolated HTTPS fixture confirmed Codex 0.153.4 automatic add/login OAuth and OpenCode 1.18.29 OAuth plus authenticated MCP discovery. Claude Code 2.1.263 reached registration and owner consent; its token exchange was not verified because the fixture deliberately blocked macOS keychain access. No model turn or real project was used.

OpenCode also completed the native OAuth flow, authenticated initialization and tool discovery against a local application with no remote URL configured, using its actual loopback HTTP port. The installed release was checked over private HTTPS with a temporary read-only grant, an empty resource selection, authenticated tool discovery and a restricted project listing; that grant was revoked after verification.

## Tools for sessions hosted by AgentPier

In **New session**, **AgentPier tools** is checked by default for standalone
Codex, Claude Code and OpenCode sessions. This single checkbox enables every MCP
tool for all projects, source accounts and provider connections, including resources
added later. There are no permission submenus. Uncheck it to launch without access.
The working directory is registered as a project when access is enabled.

AgentPier injects `agentpier_session` as a native stdio MCP into that session's
launch configuration. No global MCP configuration, browser OAuth callback or SSH
tunnel is needed. Existing external MCP registrations are independent and remain
configured. The helper relays MCP over a private Unix socket to the same tool
service and scope/resource checks used by external OAuth clients. There is no
second owner API or access to human approval gates through this connection.

New full-access sessions may inspect and cancel runs across all projects. Previously
issued restricted grants retain their permissions until replaced. Start retries
reuse the existing durable `requestId` contract; a disconnect never justifies
blindly starting another run. Ending or revoking the controlling session does not
cancel its pipeline runs. Their state remains available to the owner in AgentPier.
Login, shell and pipeline-owned sessions do not receive this integration. A
pipeline cannot obtain it by adding launch parameters, so internal start rights
are not automatically inherited by its workers.

The session toolbar's **AgentPier tools** button shows permissions and expiry and
allows immediate revocation. Grants expire after twelve hours, or earlier when the
session stops, is removed or its owner revokes access. Reloading a session with
access still enabled renews the grant and rotates its credential, while retaining
run ownership. A web-only restart preserves existing sessions and grants; the
stdio helper reconnects on its next request. Calls made while the web service is
unavailable fail without automatically replaying mutations.

Credentials are stored only in private generation-specific files below
`session-mcp/<session-id>/` in the data directory. Launch arguments contain file
paths, never tokens; browser session metadata contains only the selection,
generation and expiry. Each request validates the generation, expiry and active
session identity, and mutations recheck authorization after asynchronous waits.
Internal credentials are not accepted by the public HTTP MCP endpoint. Logical
backups omit the credential directory, and restored historical sessions lose this
integration. These grants constrain MCP access, not the host user's OS access:
native coding processes still have the host permissions described in the pipeline
and account documentation.
