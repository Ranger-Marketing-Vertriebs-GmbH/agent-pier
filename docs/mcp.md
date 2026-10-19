# Local and remote MCP

AgentPier exposes OAuth-protected Streamable HTTP at `/mcp`. A configured HTTPS origin serves remote clients privately through the Tailscale tailnet. Without a configured remote origin, the server offers its actual fixed-port loopback HTTP address for CLIs running on the AgentPier host. AgentPier runs the authorized pipelines on its host.

Grants limit the MCP API. They do not provide OS-level isolation from the trusted local host user or the AgentPier owner, who retain administrative access to application files and the owner interface.

## Prepare the connection

Open **Settings → Access → MCP & access** to copy the actual server address. For use on the same machine, HTTP is allowed only for `localhost`, `127.0.0.1` or `[::1]` with an explicit fixed port. The server supplies `http://127.0.0.1:<actual-port>/mcp` when no remote origin is configured; do not copy that address to another computer.

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

To start pipelines, explicitly select **Start runs** (`runs:start`) during browser consent, together with the needed projects, source accounts and provider connections. The initial read-only selection does not authorize starting runs. Add `definitions:write` only when the client should edit profiles or pipelines, and `runs:cancel` when it should cancel its own runs.

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

The session toolbar's **AgentPier tools** button shows permissions and access status
and allows immediate revocation. Grants have no time limit while the session is
running. Access ends when the session stops, is removed or its owner revokes it.
Reloading a session with access still enabled rotates its credential while retaining
run ownership. Existing grants with a legacy expiry also follow this session
lifecycle; updating AgentPier restores access for running sessions without a CLI
reload. A web-only restart preserves existing sessions and grants; the
stdio helper reconnects on its next request. Calls made while the web service is
unavailable fail without automatically replaying mutations.

Credentials are stored only in private generation-specific files below
`session-mcp/<session-id>/` in the data directory. Launch arguments contain file
paths, never tokens; browser session metadata contains only the enabled state,
selection and generation. Each request validates the generation and active session
identity, and mutations recheck authorization after asynchronous waits.
Internal credentials are not accepted by the public HTTP MCP endpoint. Logical
backups omit the credential directory, and restored historical sessions lose this
integration. These grants constrain MCP access, not the host user's OS access:
native coding processes still have the host permissions described in the pipeline
and account documentation.

### Publishing private artifacts

Hosted sessions with AgentPier tools enabled also receive `artifact_publish` and
`artifacts_list`. Publish HTML, images or static bundles from the session working
directory and return the private viewer URL to the owner. Updates use the existing
artifact ID with a new request ID. Artifact ownership uses the authenticated
session; external OAuth grants do not expose these tools. See
[Private artifacts](artifacts.md) for examples, supported resources, retention and
backup limits.

## Central MCP servers in the coding CLIs

Accounts → **MCP servers** is the one place for the MCP servers the owner uses. A server
can be given to agents and to the coding CLIs Claude Code, Codex and OpenCode (**Coding
CLIs** on the wizard's **Connect** step). A server bound to a CLI is written into that CLI's own
configuration (`~/.claude.json` `mcpServers`, `~/.codex/config.toml` `mcp_servers`,
`~/.config/opencode/opencode.json(c)` `mcp`), so it also works when the CLI is started
in a terminal, and the shared CLI profile carries it to every AgentPier account of that
CLI. AgentPier writes at every save and before every session start; running sessions
see a change after a restart. The list, the CLI bindings and the finds work with or
without agents; agent OAuth logins need agents. A local (stdio) command given to a CLI
needs the owner's confirmation, because every session of that CLI starts it.

**Add MCP server** opens a wizard: **Source** (package from npm or PyPI, server on the
internet, own command, or [the MCP directory](#mcp-directory)), **Set up**, **Settings**, then **Install** (package) or
**Check and save**, **Connect** and a result screen. Connect lists the coding CLIs and,
with agents on, every owner-managed agent; one card **What this allows** names what a
local server may do (your user's rights, the server's own write switch, and that shell
access is separate). The server is saved first, then the CLIs (one change), then each
agent on its own; the result screen shows every target and offers **Try again** for the
ones that failed. While a package still installs, **Connect when installed** keeps the
choice and connects once it is ready. A saved server opens an overview with one card
per step (**Source and name**, **Settings**, the package panel, **Who may use it**);
**Change** opens that step, which saves on its own.

**Paste setup from a guide** on the Source step reads a guide's JSON block in the
browser: `mcpServers` (Claude Desktop, Claude Code `.mcp.json`, Cursor, Windsurf,
Cline), `servers` with `inputs` (VS Code), `mcp` (OpenCode), `context_servers` (Zed), a
single entry, a block without its outer braces, or one package runner command line
(`npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `uvx`, `uv tool run`, `pipx run`). Comments and
trailing commas are accepted. Such a runner becomes a package that AgentPier installs
and pins itself; Docker stays an own command. Every key that is not taken over is
listed by name with its reason, never with its value. Values that refer to another
setting (`${…}`, `{env:…}`, `{file:…}`) or that are obvious placeholders become empty,
required settings. Nothing is sent while reading except the package name, which is
looked up at npm or PyPI; the pasted text stays in the wizard and is dropped when it
closes. A block may hold up to 20 servers in 64 KiB; after one is finished, **Add
another server** offers the rest without pasting again. Codex TOML and `claude mcp add`
lines are not read yet. The own-command step offers **Switch to package** when its
command is such a runner.

- **Support.** Claude Code: stdio, HTTP, SSE. Codex: stdio, HTTP (no SSE). OpenCode:
  stdio and HTTP or SSE (`remote`). Only Claude Code cannot start a stdio command in a
  working directory. Unsupported combinations are disabled with a reason in the form
  and refused by the API (`400 MCP_CLI_TRANSPORT_UNSUPPORTED`,
  `400 MCP_CLI_CWD_UNSUPPORTED`). No CLI takes a server with
  [agent placeholders](#agent-placeholders) (`400 MCP_CLI_PLACEHOLDER_UNSUPPORTED`). When an edit rules out a CLI the server is bound to,
  the form says that saving removes the server from that CLI; a newly chosen CLI that
  drops out is named too. [cli-mcp-qualification.md](cli-mcp-qualification.md)
  records the native forms and how they were verified.
- **Own command lookup.** The own-command step shows where the command resolves on the
  AgentPier service's PATH (`GET /api/mcp-commands/resolve`, read-only, nothing runs).
  An absolute path is checked by walking listed directory entries from `/`, so the
  lookup reports directories it may not list and paths with `..` as not found.
- **Ownership.** AgentPier records each entry it wrote by name and SHA-256 hash in
  `<data>/mcp-servers/servers.sqlite` (`cli_entries`); the native files get no marker.
  An entry is AgentPier's while it still matches that hash. Entries anyone else wrote
  are never modified or removed; unbinding or deleting removes only an unchanged
  AgentPier entry.
- **Targeted edits.** AgentPier changes only the entry it manages. The bytes of the
  file outside that entry stay identical, and the result is parsed again and verified
  before it replaces the file. A file whose layout does not allow this (for example an
  entry shared with other content in one construct) is refused with the reason
  _layout_ and left untouched.
- **Status per CLI.** _written_; _will be written_ (restored at the next save or
  session start); _edited by hand in the CLI_, with **Write AgentPier's version** or
  **Adopt the change** (the edit becomes the central definition for every bound CLI and
  agent); _name taken_ by another entry, with **Adopt** (that entry becomes the
  server's); _could not write_, with a reason: _unreadable_ (unreadable or symlinked
  file), _too-large_ (the file is larger than 64 MiB, the read limit for native CLI
  configurations; AgentPier neither reads nor writes it; a file of many MiB makes
  each save and session start slower, though an unchanged file is parsed only once),
  _duplicate_ (the name is defined in two OpenCode files), _changed_ (the file kept
  changing during three attempts), _layout_, _write-failed_ or _failed_ (AgentPier
  could not prepare the CLI's servers and tries again at the next session start). A single
  server can also be _invalid_ for a CLI (for example a value stored before AgentPier
  refused unpaired UTF-16 surrogates, which no CLI file can hold); it fails only its own
  entry. Another CLI or the agents are never held up by one CLI's file.
- **Found in the CLIs.** Entries added to a CLI outside AgentPier are listed with
  **Adopt** and **Adopt all**; they are never changed until adopted. Identical entries
  from several CLIs become one server bound to each; the same name with different
  content stays separate (a Codex startup timeout, which the other CLIs cannot hold,
  does not count; the server keeps it). Invalid or taken names get a proposal. Adopting replaces the
  old entry with AgentPier's only while it is unchanged since it was shown (otherwise
  `409`). Entries with the timeouts AgentPier manages (Codex `startup_timeout_sec` and
  `tool_timeout_sec`, the Claude Code and OpenCode `timeout`) are adoptable and keep
  their values; see **Timeouts**. Entries using settings AgentPier does not manage (for
  example Codex `startup_timeout_ms`, `env_vars`, `bearer_token_env_var`, a timeout
  outside the bounds or not in whole seconds, or a disabled entry) stay in the CLI. So do entries whose values refer to the CLI's environment or files
  (Claude Code `${…}` with any name, `${VAR:-default}` included; OpenCode `{env:VAR}`
  or `{file:path}`) instead of holding them: another CLI or an agent would get the
  reference literally.
  A `${…}` that Codex holds literally stays as well, because Claude Code would expand
  it, and so does an entry whose URL host or working directory a reference makes
  unreadable. The find names the headers, environment variables or fields that use
  one (never a value), Adopt all skips it, and adopting it by key fails with the reason
  _env-references_ (`MCP_CLI_FIND_ENV_REFERENCES` from the adoption service).
  **Adopt the change** for a hand edit that adds a reference is refused with
  `409 MCP_CLI_CHANGE_ENV_REFERENCES`. A field the CLI cannot express keeps the
  server's value: adopting a Claude Code edit keeps the OAuth scope, and a Claude Code
  or OpenCode edit keeps the startup timeout.
- **Timeouts.** **Advanced: timeouts** (wizard **Settings** step, and **Source and
  name** of a saved server) holds an optional startup timeout (1 to 600 seconds) and an
  optional tool timeout (1 to 3600 seconds) for any server; empty fields keep each
  CLI's default. The API takes `startupTimeoutSec` and `toolTimeoutSec` (whole seconds,
  `null` clears) and refuses other values with `400` (`mcpServers.invalidStartupTimeout`,
  `mcpServers.invalidToolTimeout`). Ten minutes of startup cover a first package
  download; an hour per tool call covers long analyses such as decompiler runs without
  letting a hung server hold a turn indefinitely. Codex gets both as
  `startup_timeout_sec` and `tool_timeout_sec` in `[mcp_servers.<name>]`. Claude Code
  and OpenCode have no per-server startup timeout (Claude Code only the global
  `MCP_TIMEOUT`), so the startup timeout is Codex-only; the tool timeout goes to their
  per-server `timeout` in milliseconds. OpenCode applies that one value to connecting
  and every request, so it waits as long to connect. Agents (OpenClaw) do not receive
  the timeouts.
- **Literal values.** AgentPier stores what the owner enters literally. Creating or
  updating a server with a reference in a header or environment value, the URL, the
  command, its arguments or the working directory is refused with
  `400 MCP_SERVER_VALUE_REFERENCE`, the `field` and, for headers and environment
  variables, their `names` (never the value); the form shows the message at that field.
  Only values a write changes are checked, before any stdio confirmation; a stored
  server is not migrated. Text with an unpaired UTF-16 surrogate in the command, an
  argument, the working directory, a header or environment value or the OAuth scope is
  refused as invalid. A shell argument such as `sh -c "srv --dir ${HOME}"` is
  refused too; use a wrapper script for it. The one exception are the fixed
  [agent placeholders](#agent-placeholders) of a local server.
- **Secrets.** Header and environment values are stored by AgentPier and written in
  plain text into the CLI files with mode 0600, because the CLIs read them there. They
  never appear in API responses, logs or the audit trail (names only).
- **OAuth.** AgentPier writes each CLI's OAuth form without static headers. Only Codex
  has a reliable login state (`codex mcp list --json`); for Claude Code (`/mcp` in a
  session) and OpenCode (`opencode mcp auth <name>`) AgentPier shows the login command.
  Login states and commands are shown only while AgentPier's entry is in effect in
  that CLI (_written_): the CLIs log in by name, so for a taken name the state would be
  the owner's other entry's, and **Log in** for Codex is refused with
  `409 not-in-effect`.
  The first Codex line is the owner's own profile (`~/.codex`): AgentPier never logs in
  there (its tokens may live in the keychain) and shows `codex mcp login <name>`.
- **Codex accounts.** Below it, an OAuth server bound to Codex lists every
  AgentPier-managed Codex account with its own login: logged in, login required,
  status unknown (before the account's first session or login knows the server), login
  in progress, or login failed with its reason. Each account keeps its tokens in its
  own `CODEX_HOME` (`mcp_oauth_credentials_store = "file"`), so every account logs in
  once; new sessions of the account use the login. **Log in** opens the provider in a
  new tab; AgentPier runs `codex mcp login <name> --no-browser` in that account with
  the callback URL `<origin>/api/mcp-servers/cli-oauth/callback`, receives the
  provider's redirect there (Codex appends a path segment per server URL; the login is
  found by its `state`), hands the full callback URL to the waiting Codex on stdin and
  returns the tab to the Accounts page with the result. Codex itself exchanges the code
  and stores the tokens; AgentPier keeps only the pending process in memory.
  - At most one login per account and server (a new one ends the previous), at most
    eight at once (counted from the moment a login starts), each for five minutes
    (Codex's own limit); **Cancel** ends it, also while Codex is still starting, and
    AgentPier ends all of them when it stops (SIGTERM, SIGKILL after two seconds).
  - A connected account offers **Log in again**: Codex only reports stored
    credentials, so after the provider revoked a login the account still reads
    "logged in" until it logs in again.
  - `<origin>` is the HTTPS remote origin when one is configured, else
    `http://127.0.0.1:<port>`. Like agent logins, a login starts only from HTTPS or on
    the AgentPier host itself; over plain HTTP from the network the list shows the CLI
    command instead.
  - The provider must support dynamic client registration (Codex registers on every
    login, so a changed origin only needs a new login).
  - `codex mcp list --json` reports stored credentials, not their validity: after the
    provider revokes a login the account can still read "logged in" until a session
    fails to start the server.
  - Routes (owner only): `POST` and `DELETE /api/mcp-servers/:id/cli-oauth/codex/login`
    with `{ accountId }`; the callback `GET /api/mcp-servers/cli-oauth/callback/<segment>`
    needs no session cookie (its single-use `state` authenticates it). Callback URLs,
    codes and states are never logged; responses never carry a token.
  - Audit: `mcp.started` when a login starts, then exactly one closing event:
    `mcp.completed`, `mcp.cancelled` (the owner cancelled) or `mcp.failed` with a
    `failReason` (a provider error such as `access-denied`, `cli-failed`,
    `cli-timeout`, `expired`, `replaced` by a newer login, or `obsolete` when the
    account was removed or the server deleted, renamed, moved to another URL or auth
    method or unbound from Codex; these
    last ones come from `source: "system"`). Agent OAuth logins use the same
    `mcp.completed`/`mcp.failed` actions; a Codex login is told apart by
    `details.accountId` (always set) together with `details.clis: ["codex"]`, which
    an agent login never carries.
  - Pending logins of an account that is removed, or of a server that is deleted,
    renamed, given another URL or auth method or unbound from Codex, end at once.
- **Sandbox.** A bound stdio server whose entry is in effect (_written_) runs inside the CLI's nono sandbox; see
  [sandbox.md](sandbox.md#the-grant-model) for its grants and the working directories
  that get none (`MCP_CWD_TOO_BROAD`).
- **Audit.** Binding and unbinding CLIs, conflict choices and adoptions are recorded as
  `mcp.updated`/`mcp.created` with the CLIs, never with an entry or a value.
- **Extensions** does not edit MCP servers: Skills and Plugins show a reference row
  with the number of central servers bound to that CLI, linking to Accounts →
  **MCP servers**.

### Agent placeholders

A local package often takes one folder setting, such as elevenlabs-mcp's
`ELEVENLABS_MCP_BASE_PATH`, which bounds the files it reads and the folder it writes
to. With one literal path every agent bound to the server shares that folder. Agent
placeholders give each agent its own folder instead:

| Placeholder           | Resolves to, for each bound agent                                          |
| --------------------- | -------------------------------------------------------------------------- |
| `{agent.workspace}`   | the agent's own workspace, `<data>/assistants/workspaces/<agent id>`       |
| `{agent.attachments}` | the attachments folder inside it, where chat attachments to the agent land |

- **Where.** In a local (stdio) server's settings (environment values), its arguments
  and its working directory. A value holds one placeholder, as the whole value or
  followed by a subfolder (`{agent.workspace}/voice`); an argument may also start with
  fixed text (`--output-dir={agent.workspace}/voice`). There are no other placeholders
  and no expressions: anything else in `{agent.…}` or `{session.…}`, a `.` or `..`
  folder, an empty folder name, a placeholder in the command, a URL or a header is
  refused with `400 MCP_SERVER_PLACEHOLDER`, the `field` and, for settings, their
  `names`.
- **Wizard.** The **Settings** step explains the placeholders under **How agent
  placeholders work**. A setting whose name looks like a path (`PATH`, `DIR`,
  `FOLDER`, `BASE`, `OUTPUT`, …) offers **Use agent workspace** and **Use agent
  attachments**; the working directory offers **Use the agent's workspace as working
  directory**. A wrong placeholder is named at its field before anything is sent.
- **One server per agent.** OpenClaw's `mcp.servers` is one list for the whole
  Gateway, without per-agent environment values. AgentPier therefore compiles a
  separate entry for every bound agent, named `<name>-<hash>` (the server's name cut
  to 21 characters and 8 hex characters of the server and agent ids), with that agent's
  folders filled in, and grants each agent only its own entry (`<name>-<hash>__*`).
  The agent's tools carry that prefix. Each entry starts its own process per session, as
  every stdio server does
  ([qualification](assistant-mcp-qualification.md#h-agent-placeholders-and-openclaw-2026103)).
- **Safety.** A resolved path is always inside the agent's own workspace. Before every
  compile AgentPier checks the way there on disk: a symbolic link or a file in the way
  (for example a link the agent created in its workspace) means the agent gets no entry
  for this server, and the server is reported as skipped. Settings without
  placeholders, such as an API key, are passed to every entry unchanged and stay
  write-only. Agents' MCP servers run without nono, like every agent MCP server; the
  agent itself can already read and write its workspace, so a placeholder grants no
  shared folder.
- **Overview.** A saved server with placeholders shows an **Agent folders** card: per
  bound agent the resolved values and whether the agent's entry is _in use_ by the
  running Gateway, _applied with the next change or start_, _not started_ because a
  link or file blocks the folder, or unavailable because agents are not set up. The
  edit step shows a stored placeholder setting with its template; other values stay
  hidden.
- **Coding CLIs.** A CLI's MCP configuration is one file for every session of that
  CLI (and the shared CLI profile carries it to every account), so a per-session
  folder such as the session's working directory cannot be written into it; the CLIs'
  own references (`${…}`, `{env:…}`) differ per CLI and Codex holds them literally.
  A server with placeholders is therefore for agents only: the wizard disables the
  CLIs with the reason, and the API refuses the binding. Without a working directory a
  CLI starts a stdio server from its own session process, so a server that resolves
  relative paths against its working directory usually works in the session's
  project folder (not qualified by AgentPier's contracts).

Example, elevenlabs-mcp installed as a package from PyPI:

| Setting                    | Value                       |
| -------------------------- | --------------------------- |
| `ELEVENLABS_API_KEY`       | the key (secret, shared)    |
| `ELEVENLABS_MCP_BASE_PATH` | `{agent.attachments}/voice` |

Each bound agent then reads its input files from and writes generated audio to its
own `attachments/voice` folder. When an agent only needs the generated audio, not
files from its folder, `ELEVENLABS_MCP_OUTPUT_MODE=resources` returns the audio in the
tool result instead and needs no folder at all.

### Installing a server package

A local (stdio) server can come from an npm or PyPI package instead of an own command.
In **Accounts → MCP servers** choose **Package from npm or PyPI** on the wizard's
**Source** step, then the **Registry** (npm or PyPI), the **Package** and a **Version**.
The package step names the publisher and source link as npm or PyPI state them, marked
"Link given by the publisher, not verified."; **More options** holds the PyPI
constraints and **Allow install scripts or source builds**. The version list is
read from the registry, newest first; prereleases are hidden unless **Show
prereleases** is on, deprecated npm versions are marked, and PyPI versions withdrawn
by their author are marked "withdrawn by its author" (yanked) and are not installed. An existing
server with an own command switches to a package on **Source and name → Change** in its
overview: its arguments and environment stay,
and the CLIs and agents keep running its own command until the install is ready, also
while the program choice waits and after a failed install (the overview then still shows
that command, for example for **Use own command**).

**Install** first resolves the complete dependency graph without running package code
(unless source builds are allowed for a PyPI package) and shows **Install this package?**
on the page; a saved server asks the same, or **Update this package?** for an update, in
a dialog. The confirmation shows the package, its integrity (for a PyPI package the number of files, for example
"3 files", and the file expected to be installed, "Expected: …"), the number of
packages in total and the **Program** it starts; nothing is installed before you
confirm with **Install**. The expected file is a forecast of the wheel the installer
picks, not a guarantee. A package that is built from source has no file yet: the
confirmation then says "Expected build from …" and "The program is chosen after the build." This
confirmation replaces the usual local-command confirmation, and it states that the
program runs with your user's rights in the CLIs and agents you choose.

AgentPier installs the frozen graph with its own pinned toolchain (Node for npm, uv
with CPython for PyPI) into `mcp-packages/installs/` in the data directory as a
background job, without install scripts. A package that needs install scripts or a
source build is refused with a hint until you tick **Allow install scripts or source
builds** for it; its code then runs during installation with your user's rights, so
allow it only for packages you trust. Only `registry.npmjs.org` (npm) and `pypi.org`
(PyPI, files from `files.pythonhosted.org`) are accepted anywhere in the graph; a
redirect to another host is refused, and so is a release whose integrity lists several
hashes. Behind a
TLS-intercepting proxy, uv trusts the CA set in `NODE_EXTRA_CA_CERTS` (see
[Installation](installation.md)). The job log
(**Installation log**) replaces the data directory and the home directory with
placeholders, and credentials in URLs are masked. npm and uv run without standard
input, in their own process group and with one shared limit for their output.

PyPI packages install from wheels into their own virtual environment with AgentPier's
CPython 3.14.7 and uv. A package that does not support Python 3.14 fails to install.
The frozen graph matches the platform it was resolved on; after a restore on another
platform, **Reinstall** can fail and an update resolves it again. Moving the data
directory leaves the toolchain's build settings pointing at the old path; source
builds then need the toolchain to be provisioned again.

**Source builds (PyPI).** A package that has no usable wheel installs only with
**Allow install scripts or source builds** ticked. The preview and the confirmation
already run the package's build code while the package is checked, with your user's
rights. The build uses the system compilers (`CC=cc`, `CXX=c++`); builds that need
Rust or other tools outside `/usr/bin` are not supported. Build tools that the build
fetches at build time (for example setuptools) come from PyPI outside the frozen,
hash-checked lock; the confirmation says so ("Build tools such as setuptools are then
downloaded from PyPI during the build; they are not part of the frozen, hash-checked
dependency list."). Because the program of a built package is only known after the
build, the confirmation does not name it yet. A source-only package whose build installs
several programs stops at _Choose program_: the package panel lists the programs, and
**Use this program** starts the chosen one without installing again. A preview that
fails names the reason instead of a log: dependency limits that no set of versions
satisfies are reported at the constraints field (for npm at the version), a release that
does not support the managed Python version is reported at the version, and any other
failure asks you to check the version or try again later. An `npm ci` install of an
already checked lock never reports unsatisfiable limits; its failure points to the log.

**Dependency constraints (PyPI only).** For a PyPI package you can enter up to 10
dependency constraints, one per line, each a PyPI package name with version limits
(for example `fastmcp<4`), at most 100 characters per line. They narrow the resolution
when the package is checked, installed or updated, for example to stay on a release
line a server still works with. The result is frozen with hashes as usual,
**Reinstall** uses the frozen list without resolving again, and an update keeps the
constraints unless you change them. URLs, paths, extras and markers are refused. npm
packages have no constraints field.

**Notes for servers.** The server runs with the environment you set; a `PATH` set on
the server that omits `/usr/bin` breaks the PyPI program's relocatable virtual
environment wrapper, because it needs `dirname` and `realpath`. A server may not find
tools the CLIs' `PATH` offers (for example `pandoc`): point it at them with an
environment value. Servers that store data next to their code (for example the npm
`server-memory`, which writes `memory.jsonl`) lose it when an update or reinstall
replaces the install directory; set the path the server offers for its data (for
`server-memory` `MEMORY_FILE_PATH`) to a folder of your own. Qualified servers are
listed in [MCP package qualification](mcp-package-qualification.md).

The form shows the status: _Installing…_, _Installed_, _Choose program_ (a build
installed several programs and waits for your choice), _Installation failed_ or
_Installation missing_ (the files of a ready install are gone or changed).

- **Bindings.** Until the package is ready, the controls for Coding CLIs and agents
  are locked for new bindings ("Coding CLIs and agents can be added once the package
  is installed."), and the CLIs and agents never receive a server whose package is not
  ready (reason "its package is not installed yet or is missing"); a server switching
  from an own command keeps running that command until then. Existing bindings stay. A missing install is removed from the CLIs' entries when AgentPier
  starts, before a session of that CLI, or with any MCP server change.
- **Update.** Choose the version in **New version**; **Check update** resolves it and
  shows the changes to the installed packages (_Added_, _Removed_, _Changed_ with old
  and new version, taken from the lock) before you confirm with **Update**. The new
  install is activated only after it succeeded; a failed update keeps the old install,
  which no cleanup removes while the switch runs. A new version whose only program has
  another name starts that program; the confirmation names the rename ("This version
  renamed the program … to …"), and a build that names its programs only after the
  install does the same without that notice.
- **Reinstall.** Installs exactly the stored lock again, for example after a failed
  install, a missing install or a restore on another computer.
- **Use own command.** Switches a packaged server back to an own command: the form
  then asks for the command, and saving removes the installed package.
  **Keep package** cancels the switch. Detaching is refused while an install runs.
  Deleting the server is allowed during a running install: AgentPier stops the
  running npm or uv process (with the scripts and builds it started) at once and
  removes the unfinished install. While a first install still downloads its Node.js or
  Python toolchain, that download completes before the install stops. Stopping
  AgentPier ends running installs the same way: a first install then shows as failed
  (**Reinstall** starts it again), and an update keeps the previous install.
- **Backups.** A backup contains the package record and its lock, not the installed
  files; after a restore the status is _Installation missing_ and **Reinstall**
  recreates the install from the lock.
- **Cleanup.** Removing a server (or switching it to an own command) deletes its
  installs and the bundled skills copied from them. Toolchain versions that no packaged server and no running install uses
  are removed from `toolchains/` in the data directory.
- **Audit.** A confirmed install (new server or switch to a package), update,
  reinstall and switch back to an own command are recorded on the server as
  `package.installed`, `package.updated`, `package.reinstalled` and
  `package.detached` with the registry, package name, version, the install-scripts
  choice and the dependency constraints (PyPI); never an argument, environment value or
  path. They are recorded when the change is accepted, so they do not say whether the
  background install succeeded (its status and log do). Choosing the program after a
  build is recorded as `package.activated` with the same details.

#### Bundled skills of a package

Some npm packages ship skills for the coding CLIs next to the server, for example a
`skills/<name>/SKILL.md` folder. Once an npm package is _Installed_, the wizard's
install step and the package panel list them under **Bundled skills**, read from the
install of the locked tarball: each skill's name, description and files, and
**Show SKILL.md** shows the skill's instructions as plain text for review. The
listing reads only names, sizes and `SKILL.md`; the other files are read when a skill
is installed. A folder with a link or a hard-linked file, a nested `node_modules`, plugin, Git or MCP configuration
(`.claude-plugin`, `.codex-plugin`, `.git`, `.mcp.json`), invalid `SKILL.md`
metadata or the size limits of an uploaded skill (1,000 files, 20 MiB) is not offered,
and neither is a skill name the package ships twice; all skills of one package
together are limited to 100 MiB and 5,000 files. PyPI packages are not searched.

Nothing is copied automatically. Tick the skills, choose the CLI profile in
**Install into CLI profile** and confirm **Install** after **Install selected skills**;
the confirmation warns that skill content comes from the package author and is not
checked. The copy goes into the same profile directory as
**Extensions → Skills → Install skill** and an existing directory is never overwritten:
if one of the chosen skills' folders exists, none of them is copied. Installing a skill
this package already installed in that profile again changes nothing.
AgentPier owns the copy and ties it to the package version: an update (or reinstall)
replaces it with the skill of the installed version and removes it when that version
no longer ships it, and removing the server or switching it to an own command removes
it. AgentPier records a digest of every file it wrote (path, permissions, SHA-256) and
replaces or removes a copy only while it is still exactly that: a copy you edited,
extended, replaced or deleted is no longer owned, keeps your changes and then shows as
your own skill on **Extensions → Skills**. The package's own code runs with your
user's rights (as an allowed install script, and as the server itself at any time),
so it can change the installed skill files before they are copied; review skills
before you install them, especially those of packages you trust less.

### MCP directory

**Settings → Workspace → MCP directory → Search the MCP Registry** lets AgentPier search
the official [MCP Registry](https://registry.modelcontextprotocol.io) on demand (on by
default). The AgentPier server sends only the search term or the entry name to the
configured **Registry address** (under **Advanced**; `https://` only, `http://` only
for a registry on this computer, no credentials, query or fragment), keeps answers for
an hour in memory (failed answers for 429 or 5xx for one minute; changing the setting
empties it) and never syncs, prefetches or installs anything. Downloads stay on the
registry's origin, are limited in size and time out after 10 seconds. Entries are
checked and shortened before the browser sees them: unknown fields, icons and
publisher metadata are dropped, links must be `https://` or `http://`, and only npm and
PyPI packages with exact versions are offered. A directory listing is not a security
review.

- `GET /api/mcp-directory/status` answers `{ enabled, host, reachable }`.
- `GET /api/mcp-directory/servers?search=&cursor=` answers `{ entries, nextCursor }`.
- `GET /api/mcp-directory/servers/:name` answers one entry's latest version,
  `404 MCP_DIRECTORY_NOT_FOUND` when the registry does not know it and
  `502 MCP_DIRECTORY_INVALID` when its data fails the checks.
- `GET /api/mcp-directory/updates` answers `{ updates }`, each `{ serverId, version }`
  for a newer version of the same package or `{ serverId, hint }` (`identifier` or
  `remote`); it answers no updates and asks nothing while the setting is off.

Search and entry answer `409 MCP_DIRECTORY_DISABLED` while the setting is off and
`503 MCP_DIRECTORY_UNAVAILABLE` when the registry cannot be reached, times out or
answers with an error, invalid JSON or too much data. Failures are logged with the code
and host, never with the search term.

On the wizard's Source step, **Search the directory** searches server names; the
default filter **Installable here** hides entries AgentPier cannot run (Docker/OCI,
NuGet, Cargo, MCPB), **All** shows them greyed with the reason. When the filter
hides every hit, the screen says so and offers **Show all**. An entry's detail
names its publisher namespace (the registry verified namespace and package ownership;
nobody reviewed the code), its status, its source link (given by the publisher, not
verified), how it runs and the settings it needs. **Use this server** only fills in the
setup; installing still needs **Install** and binding still needs **Connect**. A server
set up from the directory remembers that entry (name and version, part of backups);
when the MCP list opens, AgentPier asks the directory for at most 20 such servers and
shows **Update available** when a newer exact version of the same package is listed.
The package panel then pre-fills that version for **Check update**. A different
package or address is shown as a hint only.
