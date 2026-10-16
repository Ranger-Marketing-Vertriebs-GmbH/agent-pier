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
CLIs** in the server form). A server bound to a CLI is written into that CLI's own
configuration (`~/.claude.json` `mcpServers`, `~/.codex/config.toml` `mcp_servers`,
`~/.config/opencode/opencode.json(c)` `mcp`), so it also works when the CLI is started
in a terminal, and the shared CLI profile carries it to every AgentPier account of that
CLI. AgentPier writes at every save and before every session start; running sessions
see a change after a restart. The list, the CLI bindings and the finds work with or
without agents; agent OAuth logins need agents. A local (stdio) command given to a CLI
needs the owner's confirmation, because every session of that CLI starts it.

- **Support.** Claude Code: stdio, HTTP, SSE. Codex: stdio, HTTP (no SSE). OpenCode:
  stdio and HTTP or SSE (`remote`). Only Claude Code cannot start a stdio command in a
  working directory. Unsupported combinations are disabled with a reason in the form
  and refused by the API (`400 MCP_CLI_TRANSPORT_UNSUPPORTED`,
  `400 MCP_CLI_CWD_UNSUPPORTED`). When an edit rules out a CLI the server is bound to,
  the form says that saving removes the server from that CLI; a newly chosen CLI that
  drops out is named too. [cli-mcp-qualification.md](cli-mcp-qualification.md)
  records the native forms and how they were verified.
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
  server can also be _invalid_ for a CLI. Another CLI or the agents are never held up by
  one CLI's file.
- **Found in the CLIs.** Entries added to a CLI outside AgentPier are listed with
  **Adopt** and **Adopt all**; they are never changed until adopted. Identical entries
  from several CLIs become one server bound to each; the same name with different
  content stays separate. Invalid or taken names get a proposal. Adopting replaces the
  old entry with AgentPier's only while it is unchanged since it was shown (otherwise
  `409`). Entries using settings AgentPier does not manage (for example Codex
  `startup_timeout_sec`, `env_vars`, `bearer_token_env_var` or a disabled entry) stay
  in the CLI. So do entries whose values refer to the CLI's environment or files
  (Claude Code `${…}` with any name, `${VAR:-default}` included; OpenCode `{env:VAR}`
  or `{file:path}`) instead of holding them: another CLI or an agent would get the
  reference literally.
  A `${…}` that Codex holds literally stays as well, because Claude Code would expand
  it, and so does an entry whose URL host or working directory a reference makes
  unreadable. The find names the headers, environment variables or fields that use
  one (never a value), Adopt all skips it, and adopting it by key fails with the reason
  _env-references_ (`MCP_CLI_FIND_ENV_REFERENCES` from the adoption service).
  **Adopt the change** for a hand edit that adds a reference is refused with
  `409 MCP_CLI_CHANGE_ENV_REFERENCES`.
- **Literal values.** AgentPier stores what the owner enters literally. Creating or
  updating a server with a reference in a header or environment value, the URL, the
  command, its arguments or the working directory is refused with
  `400 MCP_SERVER_VALUE_REFERENCE`, the `field` and, for headers and environment
  variables, their `names` (never the value); the form shows the message at that field.
  Only values a write changes are checked, before any stdio confirmation; a stored
  server is not migrated. A shell argument such as `sh -c "srv --dir ${HOME}"` is
  refused too; use a wrapper script for it.
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

### Installing a server package

A local (stdio) server can come from an npm or PyPI package instead of an own command.
In **Accounts → MCP servers** set **Source** to **Install package**, choose the
**Registry** (npm or PyPI), enter the **Package** and choose a **Version**. The list is
read from the registry, newest first; prereleases are hidden unless **Show
prereleases** is on, deprecated npm versions are marked, and PyPI versions withdrawn
by their author are marked "withdrawn by its author" (yanked) and are not installed. An existing
server with an own command switches the same way: its arguments and environment stay,
and the CLIs and agents keep running its own command until the install is ready, also
while the program choice waits and after a failed install (the form then still shows
that command, for example for **Use own command**).

Saving first resolves the complete dependency graph without running package code
(unless source builds are allowed for a PyPI package) and asks **Install this package?** (**Update this package?** for an update). The dialog
shows the package, its integrity (for a PyPI package the number of files, for example
"3 files", and the file expected to be installed, "Expected: …"), the number of
packages in total and the **Program** it starts; nothing is installed before you
confirm with **Install**. The expected file is a forecast of the wheel the installer
picks, not a guarantee. A package that is built from source has no file yet: the
dialog then says "Expected build from …" and "The program is chosen after the build." This
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
  installs. Toolchain versions that no packaged server and no running install uses
  are removed from `toolchains/` in the data directory.
- **Audit.** A confirmed install (new server or switch to a package), update,
  reinstall and switch back to an own command are recorded on the server as
  `package.installed`, `package.updated`, `package.reinstalled` and
  `package.detached` with the registry, package name, version, the install-scripts
  choice and the dependency constraints (PyPI); never an argument, environment value or
  path. They are recorded when the change is accepted, so they do not say whether the
  background install succeeded (its status and log do). Choosing the program after a
  build is recorded as `package.activated` with the same details.
