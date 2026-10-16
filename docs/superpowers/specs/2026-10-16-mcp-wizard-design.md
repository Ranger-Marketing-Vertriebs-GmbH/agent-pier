# MCP server wizard and MCP Registry directory (AGENTPIER-84, AGENTPIER-83)

Status: design, ready for planning. Date: 2026-10-16. Grounded in `origin/main` 3084d66b.
Mockups (German copy, seen by the owner): https://claude.ai/artifact/6LvcGrpWnueRmmqvTgM4SR

## Goal

Setting up an MCP server today means one long form (`McpServerDetail.jsx` +
`McpServerFields.jsx`) where the owner has to translate an install guide into AgentPier's
terms by hand, then bind agents somewhere else (agent Settings → Capabilities). The
OPNsense test showed where that breaks: a guide's `npx -y …` became an own command instead
of a pinned package, settings were typed wrong, and the "write switch", agent shell access
and local-command rights were mixed up.

The wizard replaces the long form for **creating and editing** central MCP servers:

1. Pick a source (directory, npm/PyPI package, server on the internet, own command) or
   paste the guide's JSON block.
2. Fill in settings with the guide's or the directory's hints.
3. Review and install (existing package preview and confirmation).
4. Connect coding CLIs **and** agents with one consent card.
5. See per-CLI and per-agent results on a Done screen.

AGENTPIER-83 adds a read-only directory backed by the official MCP Registry, queried on
demand by the AgentPier server.

## Non-goals

- No change to how packages are resolved, pinned, hash-checked and installed
  (`server/features/mcp-packages/`); the wizard only feeds the existing preview.
- No new package types (OCI/Docker, NuGet, Cargo, MCPB stay unsupported).
- No "reviewed by AgentPier" list or reviewed/not-reviewed notices anywhere (owner
  decision Q4).
- No visible (readable) env or header values; every value stays write-only (Q3).
- No background sync of the registry, no publishing to it, no auto-install or auto-update.
- No parsing of Codex TOML or `claude mcp add …` command lines (decision Q10; follow-up
  ticket); they get a clear "not understood" state.
- Agent settings → Capabilities → MCP servers keeps working unchanged.
- Team bindings (`team-mcp.js`) and temporary members are out of scope.

## Decisions

| #   | Decision (binding)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Registry access on demand from the AgentPier server via `/v0.1`, 1 h cache per query and per detail, a setting to turn the directory off and a configurable base URL. No background sync.                                                                                                                                                                                                                                                                                  |
| Q2  | The Connect step binds **coding CLIs (Claude Code, Codex, OpenCode) and agents**. One consent card replaces the separate stdio dialogs for both. Order: the server is saved first, then the CLI targets, then one update per agent. The Done screen shows a result per CLI and per agent; nothing is all-or-nothing across agents. Binding from agent settings stays possible.                                                                                             |
| Q3  | All env and header values stay write-only. `isSecret` from the registry and a name heuristic only decide masking while typing.                                                                                                                                                                                                                                                                                                                                             |
| Q4  | No shipped list of reviewed servers. No reviewed/not-reviewed notices. The only sentence: a directory listing or a guide is not a security review. Where a package is shown, its publisher and source link are shown with it ("Check who published the package before you install it.").                                                                                                                                                                                   |
| Q5  | Unsupported registry types are shown greyed under the "All" filter and hidden by the default filter "Installable here".                                                                                                                                                                                                                                                                                                                                                    |
| Q6  | The wizard is also the edit flow for existing servers. An existing server opens on an overview with one card per step and a "Change" action; each step opens in edit mode with today's locks (connection kind locked, name editable, package changes only through Check update → confirmation, re-binding of CLIs and agents in Connect with the same consent card). Directory updates show as a pill in the MCP list. Details in [Edit flow](#edit-flow-existing-server). |
| Q7  | Connect while a package is still installing: the wizard remembers the CLI and agent choice and connects automatically once the package is installed ("Connect when installed"). Today's rule stays: no new bindings before the package is ready.                                                                                                                                                                                                                           |
| Q8  | The "Update available" pill appears only for servers created from the directory. A newest-version check against npm/PyPI for other packaged servers is a separate ticket.                                                                                                                                                                                                                                                                                                  |
| Q9  | A server created from the directory stores its origin (directory name and version) in a small non-secret column that is included in backups and restore validation.                                                                                                                                                                                                                                                                                                        |
| Q10 | Stage 1 paste formats: JSON blocks and simple `npx`/`uvx`/`pipx` command lines. `claude mcp add …` and Codex TOML come later in a follow-up ticket.                                                                                                                                                                                                                                                                                                                        |

Mockup changes after the owner review: the paste result and the directory detail no
longer carry any "reviewed by AgentPier" box; they show a neutral note with the package's
publisher (from npm/PyPI metadata) and its source link, marked "link given by the
publisher, not verified".

## Today's flow (verified on origin/main)

The flow map in the design exploration holds; the points that shape this design:

- **List**: `web/features/accounts/McpServersGroup.jsx` – "Add MCP server" navigates to
  `/accounts?section=mcp-servers&item=new`; rows open `item=<id>`; last row "Found in the
  CLIs". Routing: `web/features/accounts/routes.js` (`section`, `item` only).
- **Form**: `McpServerFields.jsx`. Name: `[A-Za-z][A-Za-z0-9_-]{0,29}`, editable after
  saving (a rename logs OAuth out under the old name, `mcp-changes.js`). Connection
  (HTTP/SSE/stdio) is shown read-only for a saved server (`transportLocked`). Package
  fields only appear for a server without `source`; a saved package changes only through
  `McpPackagePanel.jsx` (New version → Check update → update confirmation → Update).
  Own command ↔ package switch: `PUT /mcp-servers/:id` with `source` (object attaches and
  needs the install confirmation, `null` detaches to an own command,
  `server/http/routes/mcp-packages.js changeSource`).
- **Save chain**: `web/features/mcp-servers/mcp-server-save.js` (`mcpServerStep`) asks, in
  order: OAuth switch (drops stored headers), package install (`POST /mcp-packages/preview`
  → `McpPackageConfirmation`; replaces the stdio confirmation), local command for newly
  added CLIs (`CLI_STDIO_REQUIRED`), and the server's own `MCP_STDIO_CONFIRMATION_REQUIRED`.
  `web/lib/settings/save-chain.js` stops at the first error.
- **Server rules**: creating any stdio server needs `confirmStdio` (or the install
  confirmation for a package); updating needs it when command, args, cwd or env change
  (`stdio-confirmation.js changesStdio`) or a CLI is added. Values with `${…}`, `{env:…}`,
  `{file:…}` are refused with `400 MCP_SERVER_VALUE_REFERENCE` (`value-references.js`).
  Limits: ≤100 args of ≤16 KiB, ≤100 env/header entries of ≤16 KiB without NUL/CR/LF,
  env names `^[A-Za-z_][A-Za-z0-9_]*$`, header names are HTTP tokens
  (`extensions/mcp-config.js values`, `mcp-server-fields.js`).
- **CLIs**: `clis` in `POST`/`PUT /mcp-servers` binds in the same transaction. Codex cannot
  take SSE; Claude Code cannot take a stdio server with a working directory
  (`cli-support.js`, mirrored from `cli-native.js`). A new package may carry `clis` in its
  create request (the store keeps the command pending; compilers skip it until the
  install finishes). For a saved package that is not ready the UI refuses new CLIs and
  agents ("…can be added once the package is installed."); the server does not check
  package readiness for bindings.
- **Agents**: `PATCH /assistants/:id { mcpServers, revision, confirmStdio }` replaces the
  agent's whole binding list (`assistant-service.js` `update`,
  `mcp-changes.js` `checkBindings`). Refusals: agent not owner-managed (400), a stdio server for an agent
  with Telegram senders (409), missing stdio confirmation (409), stale revision (409
  conflict), agent busy or an active team member (409 `active`). UI:
  `web/features/assistants/settings/McpGroup.jsx`.
- **Registry access today**: only npm and PyPI metadata (`registry-metadata.js`,
  `download()` from `operations/release-download.js`: size cap, 30 s idle timeout, proxy
  aware, `pinOrigin`). `GET /mcp-packages/versions` returns versions only – no publisher
  or repository.
- **Preferences**: `server/features/settings/preferences.js` (`preferences.json`, `GET` /
  `PATCH /preferences` in `server/http/routes/workspace.js`, UI
  `web/features/settings/WorkspaceTab.jsx`).

## User flows

### Frame (all screens)

- Top bar: back, title ("New MCP server" / server name in edit mode), close (×). Close
  with typed input asks "Discard this new server?" (edit mode: the existing
  `UnsavedChangesSheet`).
- Step indicator: Source · Set up · Install · Connect. Paths without a package show
  Source · Set up · Connect (no Install). An `<ol>` with `aria-current="step"`.
- One topic per screen; full-width sticky primary button above the safe area, secondary as
  a text button above it; body scrolls.
- Desktop (Accounts detail pane, content column ≤ 640 px): step list left instead of dots,
  source cards 2×2, directory detail as side panel, confirmations inline, Enter submits
  the primary action of the focused form.
- Wizard state lives in React memory only (never `localStorage`, `sessionStorage` or the
  URL). The URL carries `step` (allowlisted) so browser back moves between steps; a reload
  drops the state and returns to Source with a notice "The setup was not saved. Start
  again."

### New server

**Entry (list).** "Add MCP server" opens the wizard (`item=new`). Empty list: card "No MCP
servers yet" + "MCP servers give your agents and coding CLIs new tools…" + **Add your
first server**. Rows unchanged, plus stage-2 pill "Update available".

**Source.** "Where does the server come from?" Cards: Search the directory (stage 2;
hidden in stage 1, disabled with "Directory turned off" / "Directory not reachable right
now" when unavailable), Package from npm or PyPI, Server on the internet, Own command
(Advanced chip). Row: **Paste setup from a guide**. States: default, directory off,
directory unreachable (health check failed; other cards still work).

**Set up – directory search (stage 2).** Helper: "The MCP Registry lists servers published
by their makers. A listing is not a security review. Your search is sent to <host>."
Search field (names only), chips "Installable here" (default) / "All". Result card:
title or name, namespace + "verified publisher" explanation, description (plain text),
offer chips (npm package, PyPI package, Online (HTTP), "Docker – not supported" greyed),
version, "Deprecated" chip. States: empty hint ("Search matches server names only…"),
loading (3 skeletons + status text), no hit (+ buttons Package / Paste), error/timeout/429
(+ Try again), paging via **Show more**.
Detail sheet: title, publisher namespace and what "verified" means (namespace and package
ownership only, nobody reviewed the code), status and date, source link ("link given by
the publisher, not verified"), **How it runs** radio list (unsupported options greyed with
reason), **Settings it needs** (or "The publisher did not mark which settings are
required."), neutral note "A directory listing is not a security review. Check who
published the package before you install it." **Use this server** → Settings with
package/remote prefilled; never installs.

**Set up – package.** Registry segment npm/PyPI, package name, lookup line "Found:
<name> · newest <v> · <date> · published by <publisher>" or "No package with this name on
<registry>", version select (today's markers, Show prereleases), More options
(constraints PyPI only, Allow install scripts or source builds + warning). States:
versions loading, registry unreachable, not found, deprecated/withdrawn version selected
(inline warning). Stage 2: "Listed in the directory as … – use its setup hints?" only when
the directory entry was reached from this wizard (no reverse lookup by identifier exists
in the registry API).

**Set up – server on the internet.** Address; connection auto-detected (HTTP; SSE behind
"change" with "SSE is an older kind; Codex cannot use it."). Sign-in cards: OAuth
(Advanced: scope), API key or token (header rows, preset `Authorization` with "Bearer"
prefix toggle), No sign-in. Warnings: `http://` to a non-loopback host; a token-like query
parameter ("Put the token in a header instead; addresses are shown."). Registry URL
templates (`{var}`) show one field per variable before the address preview.

**Set up – own command.** Command (resolved path or "Not found on this computer" via a new
read-only resolve call, see Architecture), arguments as a row list, working directory
(note: Claude Code cannot use it). When the command is `npx`, `bunx`, `pnpm dlx`, `yarn
dlx`, `uvx`, `uv tool run`, `pipx run` → banner "This looks like a package. Let AgentPier
install it instead?" **Switch to package** (prefilled by the paste parser's command
mapper). `docker`/`podman` → "Docker is not supported; it runs as an own command with
your user's rights."

**Paste.** Large monospace textarea (Paste button only where `navigator.clipboard.readText`
exists), **Read setup**. Helper (corrected copy): "Paste the JSON block meant for Claude
Desktop, Cursor or a similar app. AgentPier reads it in this browser. Only the package
name is looked up at npm or PyPI; your values stay on this computer." (The mockup's "nothing
is sent anywhere" is not accurate once the package is looked up.)
Result card "Here is what we found": Name (editable), Source, Arguments, Settings (secrets
masked, "All values are stored on this computer only and are never shown again."), the
neutral publisher note (package, publisher from registry metadata, source link), **Not
taken over** list with reasons, other servers in the block ("2 more servers in this block:
github, fetch – set them up one at a time", chooser). **Continue** → Settings; **Edit the
text**. Parse states in [Paste parser](#paste-parser).

**Settings.** "Settings for <name>". One card per variable: mono name, description (from
directory or "No description"), chips Required/Secret/Optional, input (masked with
show-eye for secrets, select for `choices`, switch for `format: boolean`), default as
placeholder, Remove on optional rows, **Add a setting**. Collapsed Arguments (row list)
and Working directory (stdio). Remote with headers: header rows here. Write-switch helper
when name or description matches `ALLOW_WRITES|READ_?ONLY|READWRITE|WRITE_ENABLED`: "This
setting decides whether the server may change things. Leave it off to start read-only."
Validation inline: required empty ("Needed to start the server"), reference syntax
("This value points to another setting (${…}). Type the real value here."), name rule,
value limits.

**Install (package path).** Summary line "Name … · N settings (M secret)" and the
`McpPackageConfirmation` content inline (not modal): package@version, registry, integrity,
constraints, program choice, total packages, scripts warning, run note. States: preview
loading ("Checking the package and all its dependencies…"), preview refused (back to the
package step with the field marked via `refusalField`), needs scripts (blocked + link back).
**Install** saves the server (`POST /mcp-servers` with `confirmInstall`, `previewId`,
`program`, no `clis`). Then progress: Saved → Downloading toolchain (first time only) →
Installing N packages → Checking the program, from the existing 2 s status poll; **Show
installation log**; end states Installed (→ **Next: connect**), Choose program (**Use this
program**), Installation failed (reason, log, **Try again** = Reinstall, **Change
version** = back to package step in edit mode). Leaving is allowed ("Installation continues
in the background; you'll find it under MCP servers").

**Review (URL and own command paths).** Card with name, address or command, sign-in,
settings count. Own command: the card carries today's "Run a local command?" text and the
primary reads **Allow and save** (sends `confirmStdio: true`). Remote: **Save server**.
Saves with `POST /mcp-servers` without `clis`.

**Connect.** "Who may use <name>?" Both target kinds on one screen:

- **Coding CLIs** – switch rows Claude Code, Codex, OpenCode with today's one-liner and
  disabled reasons (`cliSupport`).
- **Agents** (only when agents are enabled) – switch row per owner-managed agent (from
  `GET /assistants`, rows with an `mcpServers` array). Locked rows with reason: Telegram
  senders + stdio, temporary member (not listed).
- **What this allows** card (always visible; this is the single consent):
  1. stdio only: "Runs on this computer with your user's rights. Every session of the
     chosen CLIs and agents starts it, also when you start a CLI in a terminal."
  2. Write switch: from the Settings step in the new flow ("OPNSENSE_ALLOW_WRITES is off,
     so it can only read."); in edit mode values are unreadable, so: "OPNSENSE_ALLOW_WRITES
     is stored; AgentPier cannot show its value." Without a match: "No known write switch –
     what it can change depends on the key you gave it."
  3. "Shell access is separate: agents with shell access can run any command anyway."
     followed by each chosen agent's shell level and a link to its settings.
- OAuth note: "After saving you sign in once per CLI; the next screen shows how."
- Package still installing: rows stay selectable; the primary reads **Connect when
  installed** and the screen shows the live status; the wizard applies the choice when the
  status becomes `ready` (today's rule: no new bindings before the package is ready). On
  failure nothing is bound and Done shows why. Closing the wizard while waiting warns
  "Your CLI and agent choice is not saved yet." (Decision Q7.)
- Primary **Save and connect** (stdio with new targets: **Allow and connect**, which sends
  `confirmStdio: true` for the CLI update and for each agent that gains the server).
  Secondary **Skip for now** → Done.

**Done.** "<name> is ready" (or "<name> is saved" with failures). Cards:

- Package status (Installed / Installing… in the background / failed).
- One line per CLI from the refreshed server (`McpCliStatus` wording: written, will be
  written, could not write + reason) and, when the CLI step itself failed, the error
  with **Try again**.
- One line per agent: connected / failed with the server's message (busy, Telegram
  senders, conflict after retry) and **Try again**.
- Settings: "N stored, values hidden".
- Next steps: "Restart running sessions to see the new tools." OAuth: per CLI login action
  (Codex accounts **Log in**; Claude "open /mcp in a session"; OpenCode
  `opencode mcp auth <name>` with copy button; agents **Log in** via `McpOAuthLogin`).
- **Open server** (overview) / **Add another server**.

### Edit flow (existing server)

Entry: a list row opens the server **overview** (`item=<id>`), which replaces today's long
form. It keeps the live parts of `McpServerDetail` as they are: `McpServerInfo` (badges,
per-CLI status, Write AgentPier's version / Adopt), OAuth (`McpCodexAccounts`,
`McpOAuthLogin`), `McpPackagePanel` (status, log, program choice, Reinstall, update area),
`UsedByGroup`, **Remove** with `McpRemoveConfirmation`. Above them, one summary card per
step, each with **Change**:

| Step card              | Opens                        | Editable                                                                                                                                                                                                                                                                                                                               | Locked                                                                                                                                           |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source and name        | `step=setup` in edit mode    | Name (rename note: "Running sessions keep the old name until they restart; OAuth logins under the old name are signed out."). Remote: address, sign-in kind (header → OAuth asks "Switch to OAuth?" as today), scope. Own command: command, args, cwd; **Install as package instead** (attach). Package: **Use own command** (detach). | Connection kind (HTTP/SSE/stdio), shown read-only with "The connection type cannot be changed after saving." Package registry/name/version here. |
| Settings               | `step=settings` in edit mode | Stored names shown as "stored" with Replace / Remove; new rows; required markers from the directory when the server came from it (stage 2).                                                                                                                                                                                            | Stored values are never shown.                                                                                                                   |
| Package (package only) | overview `McpPackagePanel`   | New version / constraints / scripts → **Check update** → update confirmation with lock diff → **Update**; Reinstall; program choice. A directory update pill pre-fills New version.                                                                                                                                                    | Registry and package name (change = add a new server).                                                                                           |
| Who may use it         | `step=connect` in edit mode  | CLI and agent switches prechecked with the current bindings; the same consent card, shown when a new stdio target is added; removing needs no consent.                                                                                                                                                                                 | Rows locked by today's rules (unsupported CLI, Telegram senders, package not ready).                                                             |

Edit-mode rules:

- Each step saves on its own with the settings-pattern `SaveBar` ("Save changes") and
  returns to the overview with a notice; no hidden multi-screen draft. This matches
  `docs/settings-pattern.md` (one bar per subpage) and keeps revision conflicts local
  (Reload / Overwrite anyway via `useAccountDraft`).
- Setup and Settings saves of a stdio server go through `mcpServerStep`, so changed
  command/args/cwd/env still ask "Run a local command?" (`StdioConfirmation`), and an
  attach still shows `McpPackageConfirmation`.
- Connect in edit mode computes a diff: CLI set → one `PUT /mcp-servers/:id { clis,
revision, confirmStdio? }`; agents → one PATCH per changed agent; results on a compact
  result screen ("Changes saved", per CLI and per agent, Try again) before returning.
- Agent settings → Capabilities → MCP servers keeps binding per agent; both paths write
  the same data and refresh each other through the existing reloads.
- "Found in the CLIs" adoption is unchanged.

## Paste parser

A pure browser module (`web/features/mcp-servers/wizard/paste-parser.js` +
`command-mapper.js`), no network, no `eval`, deterministic. Output is a wizard draft plus
`ignored[]`, `warnings[]`, `others[]` (other server names in the block).

### Accepted shapes

1. `{ "mcpServers": { "<name>": entry } }` – Claude Desktop, Claude Code `.mcp.json`,
   Cursor, Windsurf, Cline.
2. `{ "servers": { "<name>": entry }, "inputs": [...] }` – VS Code `mcp.json`.
3. `{ "mcp": { "<name>": entry } }` – OpenCode (`type: "local"` with `command` array and
   `environment`; `type: "remote"` with `url`, `headers`).
4. `{ "context_servers": { "<name>": entry } }` – Zed (`command` as string or
   `{ path, args, env }`).
5. A single entry object (has `command` or `url`/`serverUrl`), name left empty for the
   owner.
6. Fragments without outer braces: `"mcpServers": {…}` or `"opnsense": {…}` – wrapped in
   `{}` and parsed again.
7. A single command line without shell operators: `npx -y pkg`, `uvx pkg`, `pipx run pkg`
   (guides that only say "run …").

JSON with comments (`//`, `/* */`) and trailing commas is accepted (VS Code allows them) by
a small tokenizer that strips them outside strings; nothing else is relaxed.

### Mapping rules

| Input                                                                                         | Result                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| key                                                                                           | Name, sanitised to `[A-Za-z][A-Za-z0-9_-]{0,29}` (invalid characters → `-`, leading non-letter dropped, cut at 30); a name already taken gets `-2`… and a hint.                                                                |
| `npx` / `bunx` / `pnpm dlx` / `yarn dlx` with `-y`, `--yes`, `-q`; `-p pkg`/`--package=pkg`   | npm package. `pkg@<exact semver>` preselects that version; ranges, tags (`latest`, `^1`) → newest stable with note "Pinned to an exact version when you install." `-p pkg prog` → program preference `prog`. Rest → arguments. |
| `uvx pkg[==v\|@v]`, `uv tool run`, `uvx --from pkg[==v] prog`, `pipx run [--spec pkg] pkg`    | PyPI package, same version rule (PEP 440 exact only), `--from` → program preference. `--with x`, `--python x` → ignored with warning ("AgentPier resolves dependencies itself").                                               |
| PyPI extras `pkg[extra]`                                                                      | Package without extras + warning "Extras are not installed."                                                                                                                                                                   |
| `cmd /c <cmd>` (Windows guides)                                                               | Unwrapped, noted in ignored.                                                                                                                                                                                                   |
| `docker run …`, `podman run …`                                                                | Own command with warning "Docker is not supported as a package; this runs as an own command with your user's rights."                                                                                                          |
| anything else (`node path`, `python -m x`, absolute path)                                     | Own command, `args` as rows.                                                                                                                                                                                                   |
| `args` (string array; OpenCode/Zed command arrays split into command + args)                  | Arguments; non-string items → refused entry with message.                                                                                                                                                                      |
| `env` / `environment` (object of strings; numbers and booleans stringified with a note)       | Settings rows; masking by name heuristic `KEY\|SECRET\|TOKEN\|PASSWORD\|PASSWD\|AUTH\|CREDENTIAL\|PRIVATE` (masking only, Q3).                                                                                                 |
| `cwd`                                                                                         | Working directory (absolute only, else warning and field emptied).                                                                                                                                                             |
| `url` / `serverUrl` + `type`/`transport` (`http`, `streamable-http`, `streamableHttp`, `sse`) | Remote. Without a type: HTTP, or SSE when the path ends in `/sse` (with "Guessed from the address; change if needed").                                                                                                         |
| `headers`                                                                                     | Header rows; `Authorization: Bearer <x>` → sign-in "API key or token" with Bearer prefix on.                                                                                                                                   |
| `type: "stdio"` / `"local"` / `"remote"`                                                      | Consumed (decides the path).                                                                                                                                                                                                   |

### Ignored (listed by key with a reason, never silently)

`npx`/`uvx`/`pipx` themselves ("AgentPier installs the package itself instead of
downloading it at every start"), `-y`/`--yes` ("only needed for npx"), `disabled`,
`enabled`, `autoApprove`, `alwaysAllow`, `timeout`, `trust`, `includeTools`,
`excludeTools`, `transportType` after use, `envFile` ("AgentPier cannot read env files;
type the values here"), `oauth` (OpenCode; sign-in is chosen on the address step), and any
unknown key (name only, value never shown).

### References and placeholders (refused, become required empty fields)

- `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `${input:id}`, `{env:VAR}`, `{file:path}` in
  any value → field emptied, required, message names the reference only by its variable
  name. VS Code `inputs` entries supply description and `password: true` → secret. The
  parser reuses the server's reference definition (a shared copy of `hasReference`'s
  openers, kept in sync by a contract test against `value-references.js`).
- Obvious placeholders: empty, `…`/`...`, `<…>`, `YOUR_…`, `your-…-here`, `xxx+`,
  `changeme`, `TODO` → emptied, required, "The guide shows a placeholder here."
- A token-looking value in `args` or the URL query → warning "Put tokens in settings or
  headers; arguments and addresses are shown."

### Edge cases

Invalid JSON → "This is not valid JSON. Copy the whole block including the braces { }."
with line and column; valid JSON but no server → "No server found. AgentPier understands
mcpServers, servers, mcp and context_servers blocks."; several servers → chooser, one at a
time, the rest stay in memory until the wizard closes; duplicate keys → last wins (JSON
semantics) with a warning; Codex TOML (`[mcp_servers.` prefix) or `claude mcp add` →
"This is not JSON. Paste the JSON variant from the guide, or set the server up by hand."

### Untrusted input limits

Input ≤ 64 KiB (longer: "This is too long for a setup block."), nesting depth ≤ 16,
≤ 20 servers, per server ≤ 100 args and ≤ 100 env/header entries, values ≤ 16 KiB, names
by the server rules; keys `__proto__`, `constructor`, `prototype` are dropped (parse into
`Object.create(null)` maps); control characters except tab rejected in values (server
refuses NUL/CR/LF anyway). Everything rendered as text, never HTML. The pasted text is
cleared from memory when the wizard closes and never logged or sent; only the package name
goes to `GET /mcp-packages/versions`.

## Registry client (stage 2)

Server module `server/features/mcp-directory/` with routes
`server/http/routes/mcp-directory.js`.

### Endpoints

AgentPier → registry (`<base>` default `https://registry.modelcontextprotocol.io`):

- `GET <base>/v0.1/servers?search=<q>&limit=30&version=latest[&cursor=<c>]`
- `GET <base>/v0.1/servers/<urlencoded name>/versions/latest`
- `GET <base>/v0.1/health` (Source card availability, cached 5 min)

Browser → AgentPier (`Cache-Control: no-store`, login required like every `/api` route):

- `GET /api/mcp-directory/status` → `{ enabled, host, reachable }`
- `GET /api/mcp-directory/servers?search=&cursor=` → `{ entries: Entry[], nextCursor }`
- `GET /api/mcp-directory/servers/:name` → `EntryDetail`
- Setting: `PATCH /preferences { mcpDirectory: { enabled, baseUrl } }` (in
  `preferences.js`; UI row in Settings → Workspace, "MCP directory" with switch and base
  URL behind Advanced; the wizard's "turned off" state links there).

The server returns a normalised DTO, never raw `server.json`: `name`, `title`,
`description`, `version`, `namespace`, `status`, `statusMessage`, `publishedAt`,
`repositoryUrl`, `websiteUrl`, `options[]` (each `{ kind: "npm"|"pypi"|"remote-http"|
"remote-sse"|"unsupported", identifier, version, transport, url, urlVariables[],
env[], headers[], packageArgs[], ignored[], unsupportedReason }`) and `installable`.

### Cache

In-memory LRU (≤ 200 entries) keyed by normalised base URL + query (search lower-cased,
trimmed, ≤ 100 chars; cursor) or by name. TTL 1 h for successes; failures are not cached
except a 60 s negative entry for 429/5xx to avoid hammering. Changing the setting clears
the cache. No disk cache, no prefetch, no background refresh.

### Settings

`enabled` default `true`; `baseUrl` must be `https:` (or `http:` on a loopback host, for
tests and local subregistries), no credentials, no query or fragment, ≤ 512 chars; stored
normalised without trailing slash. Disabled → directory routes answer `409
MCP_DIRECTORY_DISABLED`, the Source card shows "Directory turned off".

### Untrusted data validation and size limits

- Download through `download()` with `pinOrigin: true`, `accept: application/json`, size
  caps 2 MiB (list) and 512 KiB (detail), overall timeout 10 s, no cookies, no
  `Authorization`, proxy handling as for npm/PyPI.
- JSON parsed, then validated field by field; an invalid entry is dropped (list) or answers
  `502 MCP_DIRECTORY_INVALID` (detail). Accept schema versions `2025-09-16`, `2025-09-29`,
  `2025-12-11` and unknown later dates (additive) – fields are read by name, unknown
  fields ignored.
- Strings: control and bidi-override characters stripped; caps name 200, title 100,
  description 300 (registry says 100; longer is cut with "…"), statusMessage 300, env
  description 500, URLs 2048. Links only `https:`/`http:` and rendered with
  `rel="noopener noreferrer"`, shown as host + path text. `icons` and
  `_meta.publisher-provided` are ignored (no remote images, no free-form data).
- Packages: `registryType` npm/pypi only; `registryBaseUrl` absent or exactly
  `https://registry.npmjs.org` / `https://pypi.org`, otherwise `unsupported`; identifier
  must pass `packageName()`; version must be exact (semver / PEP 440). `runtimeHint` and
  `runtimeArguments` → `ignored[]`. `packageArguments`: positional/named values mapped to
  argument rows; an argument with `isSecret` or a required argument without value and
  without a safe placeholder → option `unsupported` ("needs a secret as an argument").
- Env/header inputs: names must pass the server's name rules, ≤ 100 each; `{var}`
  templates in header values and remote URLs become `urlVariables`/header variables the
  owner fills; the final value is composed in the browser and saved as a literal.
- `status: deleted` entries are never shown; `deprecated` shows `statusMessage`.
- Cursor passed back only if ≤ 512 printable chars.

### Offline and errors

Network failure, timeout, non-2xx, invalid JSON, oversize → `503
MCP_DIRECTORY_UNAVAILABLE` (browser: "The directory is not reachable right now. Try
again, or set the server up another way."); 404 on detail → `404 MCP_DIRECTORY_NOT_FOUND`.
Errors are logged once with code and host, never with the search term. The rest of the
wizard works offline from the directory.

### Never auto-install

Selecting an entry only fills the wizard draft. Installing still needs the package preview
and **Install**; binding still needs Connect. Directory data is never written to CLI
configs or agent configs directly, and nothing is fetched without an owner action (open
the directory, search, open a detail, or open the MCP list for the update pill).

### Update pill (stage 2)

A server created from a directory entry stores its origin `{ directoryName, version }`
(non-secret; validated like the DTO; included in backup/restore validation). When the MCP
list opens, the server asks the directory for the `latest` detail of each such server
(≤ 20, cache 1 h, in parallel ≤ 4). If the latest version's npm/PyPI option has the same
identifier and a newer exact version, the row shows "Update available"; the overview's
package panel shows "Version <v> is listed in the directory" and pre-fills New version.
The update then runs the existing Check update → confirmation flow. Identifier changes or
a remote URL change are shown as a hint only, never applied. (Decisions Q8 and Q9.)

## Architecture

### Web

`web/features/mcp-servers/wizard/` (each file < 600 lines, `check:structure`):

| File                                                                             | Role                                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `McpWizard.jsx`                                                                  | Frame: top bar, step indicator, step switch, close confirmation, sticky bar; new and edit mode.                                               |
| `wizard-state.js`                                                                | Reducer; path → step order; draft shape = `mcpServerValues()` plus `agents[]`, `origin`, `hints` (descriptions, required/secret markers).     |
| `SourceStep.jsx`, `PackageStep.jsx`, `RemoteStep.jsx`, `OwnCommandStep.jsx`      | Set-up screens; reuse `McpPackageFields` pieces, `useMcpPackageVersions`, `McpAuthFields`.                                                    |
| `PasteStep.jsx`, `paste-parser.js`, `command-mapper.js`, `paste-placeholders.js` | Paste screen and pure parser.                                                                                                                 |
| `SettingsStep.jsx`, `SettingRow.jsx`                                             | Env/header/argument cards; stored rows reuse `McpSecretRows` semantics (replace/remove/keep).                                                 |
| `InstallStep.jsx`                                                                | Inline `McpPackageConfirmation` (new `inline` prop) and progress from `McpPackagePanel`'s status poll (extracted into `usePackageStatus.js`). |
| `ReviewStep.jsx`                                                                 | URL / own command review card.                                                                                                                |
| `ConnectStep.jsx`, `ConsentCard.jsx`, `connect-plan.js`                          | Targets, consent card, diff + runner.                                                                                                         |
| `DoneStep.jsx`                                                                   | Results; reuses `McpCliStatus`, `McpCodexAccounts`, `McpOAuthLogin`.                                                                          |
| `McpServerOverview.jsx`                                                          | Edit hub (replaces the long form in `McpServerDetail.jsx`).                                                                                   |
| stage 2: `DirectoryStep.jsx`, `DirectoryDetail.jsx`, `directory-api.js`          | Search, results, detail sheet (`Sheet`).                                                                                                      |

Routing: `web/features/accounts/routes.js` gains an optional `step` query value,
allowlisted (`source|directory|package|remote|command|paste|settings|install|review|
connect|done` for `item=new`; `setup|settings|connect` for an id). `accountsQuery` writes
it; anything else is dropped.

Save chain reuse:

- `mcpServerStep` stays the single place that builds the server request and asks the
  OAuth-switch, install and stdio questions. The wizard calls it with a `confirmations`
  object prefilled from its own consent UI (inline confirmation instead of a sheet).
- `connect-plan.js` is new and does **not** use `runSaveChain` (which stops at the first
  error): it runs (1) the CLI update `PUT /mcp-servers/:id { clis, revision,
confirmStdio }` when the CLI set changed, then (2) for each agent whose membership
  changes, `PATCH /assistants/:id { mcpServers, revision, confirmStdio }`, sequentially,
  collecting `{ target, ok, error }`. The agent list is computed from a fresh
  `GET /assistants` record as `fresh.mcpServers ± serverId` so other bindings are never
  overwritten; a 409 conflict re-reads once and retries; `active`, Telegram senders and
  other refusals are reported per agent. `confirmStdio` is only sent when the consent card
  was shown for a stdio server and the target gains it.
- The CLI step runs before agents so a CLI refusal does not hide agent results; both are
  reported independently.

Refactored out of the long form: `McpServerFields.jsx` splits into `NameField`,
`ConnectionField`, `SourceField`, `CommandFields`, used by the steps; `McpServerDetail.jsx`
becomes `McpServerOverview` + edit-mode wizard steps; `McpCliChoices.jsx` moves into
`ConnectStep`; `StdioConfirmation` text is reused in `ConsentCard` and `ReviewStep`. The
long single-page form is removed once the browser specs run against the wizard (stage 1).

### Server

- Stage 1: no new routes for the wizard. Additions:
  - `GET /mcp-packages/versions` also returns `publisher` (npm: `author.name` and
    maintainer account names of the selected/latest version; PyPI: `info.author` /
    `info.maintainer`) and `repositoryUrl` (npm `repository.url` normalised; PyPI
    `project_urls` Source/Repository/Homepage), each text-capped (200) and http(s)-only.
    Shown as "published by … (according to npm/PyPI)" and "link given by the publisher,
    not verified". The fields are added where the version list is built
    (`npmVersions`/`pypiVersions` in `registry-metadata.js`); `mcp-packages.js` passes
    the adapter result through unchanged and needs no edit.
  - `GET /mcp-commands/resolve?name=` – resolves an own command to an absolute path with
    `resolveCommand()` from `command-resolution.js` (the same PATH lookup the save uses),
    answers `{ found, path }`; never executes anything, `Cache-Control: no-store`. A
    separate path keeps it clear of `/mcp-servers/:id`.
  - `mcp.created` audit details gain `origin: "manual"|"paste"|"directory"` (no values).
- Stage 2: `server/features/mcp-directory/{client.js,normalise.js,cache.js}`, routes above,
  `mcpDirectory` in `preferences.js`, optional `origin` on server records
  (`mcp-server-store.js` column + backup validation), list decoration for the update pill.
- Backend messages for new codes in `server/lib/i18n/de/` with stable identifiers.

## Accessibility, mobile first, i18n

- Mobile first at 390 px: one column, 16 px gutters, targets ≥ 44 px, sticky bar with
  `var(--safe-area-inset-bottom)`, sheet for the directory detail, no horizontal scroll
  (long package names wrap with `word-break: break-all`). Tablet and desktop use the
  Accounts detail pane.
- Each step has one `h1`; focus moves to it on step change; the step indicator is an
  ordered list with `aria-current="step"` and a visually hidden "Step 2 of 4".
- Source and sign-in cards are native radio inputs in a `fieldset`/`legend`; filter chips
  are buttons with `aria-pressed`; CLI/agent rows reuse `ToggleRow` (`role="switch"`).
- Parse results, search status and install progress announce through one `role="status"`
  region; errors use `role="alert"` and `aria-describedby` on their field (as
  `McpServerFields` does today).
- Skeletons are `aria-hidden`; masked inputs have a labelled show/hide toggle; the consent
  card is a `section` with a heading and is the description of the primary button.
- Reduced motion: no animated step transitions.
- i18n: new catalogs `web/lib/i18n/{de,en}/mcp-wizard.js` and `mcp-directory.js` with
  matching keys and interpolation, reactive exports in `web/lib/i18n/messages/`; parity
  tests (`tests/unit/i18n-catalogs.test.js`). Directory and guide text (names,
  descriptions) stays in its original language; dates via `Intl` in the UI locale. Every
  screen is exercised in English in the browser specs.

## Security analysis

| Threat                                                               | Mitigation                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious paste (huge, deep, prototype keys, HTML)                   | Browser-only parser with size/depth/count caps, null-prototype maps, text rendering only, no `eval`.                                                                                                                                                       |
| Secrets leaking from paste or settings                               | Values only in React memory until the normal save; never in URL, storage, logs, audit, the registry request or the package lookup; write-only after save (Q3).                                                                                             |
| References expanded differently by CLIs                              | Refused in the parser (required fields) and still refused by the server (`MCP_SERVER_VALUE_REFERENCE`).                                                                                                                                                    |
| Typosquatting / wrong package from a guide                           | Publisher and source link shown with "Check who published the package before you install it."; exact version pinned; hash-checked install; dependency preview; install scripts off by default; `npx`/`uvx` own commands detected and turned into packages. |
| Misleading trust signals                                             | No reviewed list (Q4); "verified" only explains namespace ownership; every directory screen says a listing is not a security review.                                                                                                                       |
| Untrusted registry data (XSS, oversized, spoofed links, prompt text) | Server-side normalisation, caps, control/bidi stripping, http(s)-only links with `noopener noreferrer`, no icons or free-form `_meta`; descriptions are shown to the owner only, never passed to agents or CLIs.                                           |
| SSRF / exfiltration via the base URL                                 | Owner-only setting, https (loopback http only), no credentials, origin-pinned redirects, size caps, timeouts; search term is the only data sent and the screen names the host.                                                                             |
| Silent install or update                                             | Never auto-install; update pill only pre-fills Check update; confirmations unchanged.                                                                                                                                                                      |
| Local command rights                                                 | One consent card per Connect that names the rights; server still requires `confirmStdio` / install confirmation; Telegram-senders agents never get stdio servers (UI lock + server 409).                                                                   |
| Overwriting other agent bindings                                     | Per-agent read-modify-write with revision and one retry; only the wizard's server id is added or removed.                                                                                                                                                  |
| Privacy                                                              | No background traffic; directory off switch; errors logged without search terms.                                                                                                                                                                           |

## Testing strategy

- **Unit** (`tests/unit/`): `paste-parser` table tests for every accepted shape, mapping
  rule, ignored key, reference and placeholder; fast-check properties (never throws on any
  string ≤ 64 KiB, output never holds a reference, caps respected, names always match the
  name rule, unknown keys never surface values); `command-mapper` (npx/uvx/pipx/bunx
  variants); contract test that the parser's reference openers equal
  `value-references.js`; `wizard-state` step orders per path and edit locks;
  `connect-plan` diff and runner (property: bindings other than the server are preserved;
  partial failures reported per target); i18n parity. Stage 2: `normalise` against
  trimmed real registry fixtures in `tests/fixtures/mcp-registry/` (opnsense, pulsemcp
  remote-filesystem, smithery remote, oci-only, deleted, deprecated, oversize strings,
  bidi), cache TTL with a fake clock, base URL validation.
- **Integration** (`tests/integration/`): `/mcp-packages/versions` publisher fields
  against the existing npm/PyPI fixtures; command resolve route; audit `origin`; stage 2:
  directory routes against a loopback fake registry (size caps, timeout, redirect to
  another origin refused, 429 negative cache, malformed JSON, disabled setting 409,
  preferences PATCH validation), origin field in backup/restore
  (`mcp-server-backup-crafted.test.js` style).
- **Browser** (`tests/browser/`, Chromium and WebKit in CI): new
  `mcp-wizard-remote.spec.js`, `mcp-wizard-command.spec.js`,
  `mcp-wizard-package.spec.js` (with `mcp-packages-fixture.js`),
  `mcp-wizard-paste.spec.js` (OPNsense example, references, several servers),
  `mcp-wizard-connect.spec.js` (CLIs + agents, consent card, per-target failures),
  `mcp-wizard-edit.spec.js` (overview, locks, rename, re-binding), stage 2
  `mcp-directory.spec.js`. Each wizard spec also runs at 390×844 with touch. Existing
  `mcp-*.spec.js` that drive the long form are migrated, not deleted, so coverage of
  OAuth, value references, package panel and CLI notices stays. If an
  `assistant*.spec.js` is touched (agent MCP group), run it in WebKit so the `tablet`
  project (820×1180, `assistant*.spec.js` only) repeats it. All suites use isolated data
  directories, fake registries and the test tmux server; never real user data.

## Rollout

Ship in stages, each a reviewable PR on its own branch from `main`:

1. **PR 1 – wizard core and edit flow (stage 1a):** frame, Source (without directory),
   package/remote/own-command set-up, Settings, Install/Review, Connect with CLIs and
   agents + consent card, Done, overview + edit mode, removal of the long form, publisher
   fields and command resolve, docs (`docs/mcp.md`, `docs/settings-pattern.md` if a
   pattern is added).
2. **PR 2 – paste parser (stage 1b):** Paste screen and parser with its tests; own-command
   "looks like a package" banner.
3. **PR 3 – directory backend (stage 2a):** registry client, cache, setting and Settings →
   Workspace row; routes behind the setting; no UI in the wizard yet.
4. **PR 4 – directory UI and update pill (stage 2b):** directory search and detail, origin
   field, list pill, package-panel hint; delete this spec and its plans; update
   `docs/mcp.md`.

Stage 1 alone is a complete feature (no hidden directory card). Release notes mention
the directory's preview status and that searches go to the configured registry host.

## Coordination with parallel work

Another session changes `server/features/mcp-packages/mcp-packages.js`,
`program-select.js`, `server/features/mcp-servers/cli-reconciler.js` and `cli-bindings.js`
in separate bug-fix PRs. This design requires **no change** to `cli-reconciler.js`,
`cli-bindings.js` or `program-select.js`, and none to `mcp-packages.js` in stage 1 (CLI
bindings go through the existing `clis` field of `POST`/`PUT /mcp-servers`). Stage 2's
`origin` column touches `mcp-server-store.js` and the backup validation only. The
mcp-wizard PRs rebase onto `main` after those bug-fix PRs merge and re-run the MCP suites
before review.

## Open questions

None. The owner answered all of them; see decisions Q7–Q10.
