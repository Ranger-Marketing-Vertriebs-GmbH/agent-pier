# Coding CLIs

AgentPier describes each coding CLI (Codex, Claude Code, OpenCode) in one folder under
`server/features/clis/`. A browser-safe **definition** holds the CLI's static facts; a
Node-only **driver** holds the behaviour that reads or writes files, starts processes or
reads the terminal. Features ask the catalog and the drivers instead of branching on the
CLI id.

The GitHub CLI (`gh`), the system shell (`shell`) and the nono sandbox (`nono`) are not
coding CLIs. They stay outside the catalog; tables that also cover them, such as
`nativeInstallers` in `server/features/tools/native-installer.js` or the shell launch in
`server/features/accounts/account-store.js`, keep their own entries for them.

## Layout

| File                      | Runs in       | Holds                                                                                                                                             |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.js`              | browser, Node | Ids in list order, `cliDefinition`, `cliName`, `isCodingCli`                                                                                      |
| `<id>/definition.js`      | browser, Node | The definition record (pure data, frozen)                                                                                                         |
| `drivers.js`              | Node          | `cliDriver(id)`: assembles and freezes each driver                                                                                                |
| `<id>/profile.js`         | Node          | `profileEnv`, `configRoot`, `dataRoot`, `parseAuthStatus`, `credentials`                                                                          |
| `<id>/session-config.js`  | Node          | `addMcpServer`, `addSessionHooks`, `addReminder`, `grantDirectory`, `inlineMcpNames`; Claude Code also `addPluginFolder` and `runtimeInterpreter` |
| `<id>/mcp.js`             | Node          | The `mcp` members (native MCP entry, timeouts)                                                                                                    |
| `<id>/binding.js`         | Node          | The `binding` members (native session binding)                                                                                                    |
| `<id>/requests.js`        | Node          | `prepareRequests`, `shellToolName`, `startupDialogs`, `launchRecord`                                                                              |
| `<id>/history.js`         | Node          | The `history` members                                                                                                                             |
| `<id>/tui.js`             | Node          | The `tui` members; shared screen helpers live in `tui-screen.js`                                                                                  |
| `<id>/pipeline.js`        | Node          | The `pipeline` members                                                                                                                            |
| `<id>/plugins.js`         | Node          | The `plugins` members                                                                                                                             |
| `<id>/profile-files.js`   | Node          | The `profileFiles` members                                                                                                                        |
| `<id>/provider.js`        | Node          | The `provider` members (provider environment and launch)                                                                                          |
| `<id>/transfer.js`        | Node          | The `transfer` members (Codex and Claude Code only)                                                                                               |
| `<id>/sandbox.js`         | Node          | `sandboxLaunch` (Codex and Claude Code only)                                                                                                      |
| `claude/login-store.js`   | Node          | The `loginStore` members; `claude/keychain-shim.sh` is the `security` stand-in it installs                                                        |
| `codex/history-client.js` | Node          | Codex's read-only app-server client for its history                                                                                               |
| `opencode/attachments.js` | Node          | OpenCode's attachment `references` entry (`grantDirectory`)                                                                                       |

`catalog.js` imports only the definitions, and neither imports Node modules or anything
outside `clis/`: the web app bundles them (`web/features/**` imports
`server/features/clis/catalog.js`). `catalog.js` deep-freezes every definition once. A
feature reaches a driver through `cliDriver(id)`; it imports a driver's helper module
directly only to avoid an import cycle (for example `opencode-history-page.js`, the
history imports in `provider-history.js` and `inlineConfig`). Drivers are stateless.
Whatever state a call needs is passed in: the launch being built, the environment and
home, or the owning service (for example the `ProviderHistory` instance for `history`).

## Definition

| Field                            | Meaning                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `shortName`        | Id, full name (`Claude Code`) and short name (`Claude`)                                                                                       |
| `docsUrl`                        | Official installation and update guide                                                                                                        |
| `npmPackage`                     | The npm package of older AgentPier-managed installations                                                                                      |
| `nativeInstaller`                | `{ url, shell, args, directory }` of the official install script                                                                              |
| `updateArgs`                     | Arguments of the CLI's own update command                                                                                                     |
| `minVersion`                     | Minimum version for sessions (see [CLI updates](cli-updates.md#minimum-cli-versions))                                                         |
| `launchModes`                    | `{ mode: args }`; `default` is always present                                                                                                 |
| `defaultLaunchMode`              | The mode new accounts start in                                                                                                                |
| `unattendedModes`                | Modes that skip every approval (Codex `yolo`, Claude `bypass`, OpenCode `auto`)                                                               |
| `unattendedArgs`                 | Pipeline permission arguments that make a session unattended (AgentBus permission class); not launch arguments, which come from `launchModes` |
| `loginArgs`                      | Sign-in command (`[]`: the CLI signs in inside its own TUI)                                                                                   |
| `authStatusArgs`                 | Command whose output `parseAuthStatus` reads                                                                                                  |
| `apiKeyEnv`                      | Variable for API-key accounts                                                                                                                 |
| `resumeArgs(sessionId)`          | Arguments that resume a native session                                                                                                        |
| `questionView(q)`                | Chat view `{ multiple, allowOther, previews, notes }` of one native question                                                                  |
| `sessionIdArgs(id)`              | Arguments that make AgentPier's session id the native one at launch (Claude Code `--session-id`), or `null`                                   |
| `nativeSandbox`                  | The CLI's own sandbox mode for a session (Codex `workspace-write`, published as `AGENTRUNNER_SANDBOX`), or `null`                             |
| `configFormat`                   | Format of the CLI's config files: `toml`, `json` (no comments) or `jsonc`                                                                     |
| `protocol`                       | Custom-endpoint protocol: `responses`, `messages` or `chatCompletions`                                                                        |
| `mcpLoginCommand(name)`          | The command (or slash command) that signs MCP server `name` in inside the CLI                                                                 |
| `mcpSetup({ endpoint, quoted })` | Manual steps that add AgentPier's MCP endpoint: `{ steps: [{ id, value, kind: "command" \| "config", label? }], removeNote? }`                |
| `capabilities`                   | Booleans, listed below                                                                                                                        |
| `pipeline.permissionModes`       | Permission modes a pipeline profile may choose                                                                                                |

Capabilities (every one is read; a new CLI states each of them):

| Capability            | The CLI ...                                                                           | Codex | Claude | OpenCode |
| --------------------- | ------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| `accountTransfer`     | can move a session to another account (`transfer` driver member)                      | yes   | yes    | no       |
| `transcriptCleanup`   | has transcripts the storage cleanup may delete (`history.transcriptFiles`)            | yes   | yes    | no       |
| `storageCleanup`      | takes part in the storage cleanup                                                     | yes   | yes    | no       |
| `transcriptIndex`     | keeps its own thread databases, which the transcript cleanup leaves alone             | yes   | no     | no       |
| `mcpOAuth`            | has per-account MCP OAuth that AgentPier reads and starts                             | yes   | no     | no       |
| `mcpSse`              | accepts an SSE MCP server                                                             | no    | yes    | yes      |
| `mcpStdioCwd`         | starts a stdio MCP server in its `cwd`                                                | yes   | no     | yes      |
| `imagePaste`          | shows pasted image paths as chips (chip-paste path; `tui.images`)                     | no    | yes    | no       |
| `requestHandoff`      | holds a request in a hook that can be released to its own terminal dialog             | no    | yes    | no       |
| `hookTrust`           | makes the user review new hooks before they run, so binding and registration can wait | yes   | no     | no       |
| `pluginBridge`        | runs AgentPier's bridge in process as a CLI plugin instead of hook subprocesses       | no    | no     | yes      |
| `keychainCredentials` | may leave keychain entries behind when its account is deleted                         | no    | yes    | no       |
| `endpointSdkRouting`  | reaches a custom endpoint through its own SDK providers, so routes name a protocol    | no    | no     | yes      |
| `npmPlugins`          | can install plugins as npm packages when no catalog is available                      | no    | no     | yes      |
| `clearResetsBinding`  | starts a new native thread on `/clear`, which the web app waits to confirm            | yes   | no     | no       |

Several capabilities are **bound to one CLI**: setting the flag does not give a new CLI
a generic behaviour, it runs the owning CLI's code or shows its copy. The pins in
`tests/unit/cli-catalog.test.js` fix the owner of each one and must keep failing for a
new CLI until the implementation takes a CLI argument.

| Capability           | Bound to    | What runs when it is set                                                                                                                             | A new CLI first needs                                                                                                                                       |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpOAuth`           | Codex       | `mcp-servers/cli-bindings.js` calls `oauthStatus.codex()` (`codex mcp list`); the web login drives `codex mcp login` (`codex-mcp-logins.js`)         | Its own MCP OAuth status and login commands behind a driver member, and copy without `oauthConnectedCodex` and `codexResultText`                            |
| `hookTrust`          | Codex       | Chat and AgentBus wait for the hook review that `requests/codex-hook-trust.js` reads from Codex's screen; `request-broker.js` names `codexHookTrust` | Its own `tui.blockingScreen` and `startupDialogs` entry, a broker check by capability, and neutral copy (`codexRegistrationPending`, `codexBindingPending`) |
| `endpointSdkRouting` | OpenCode    | `providers/endpoint-routing.js` and the web `endpoint-routes.js` pick sources in OpenCode's order (`OPENCODE_ORDER`) and OpenCode's `ROUTE_CHOICES`  | Its own source order and route choices, passed per CLI                                                                                                      |
| `requestHandoff`     | Claude Code | `requests/request-broker.js` releases a held request through Claude Code's hook protocol                                                             | A hook that holds the request and hands it back to its terminal dialog in the same protocol                                                                 |
| `pluginBridge`       | OpenCode    | AgentBus registers peers through the in-process plugin that OpenCode loads (`addSessionHooks` with `pluginUrl`)                                      | A plugin of its own that loads AgentPier's bridge and reports the native session id                                                                         |
| `transcriptIndex`    | Codex       | The transcript cleanup reports `databasesKept`, and the dashboard shows Codex's note (`codexNote`)                                                   | Neutral copy; the cleanup logic itself is generic                                                                                                           |
| `clearResetsBinding` | Codex       | `web/features/chat/chat-reset.js` waits after `/clear` until the native session id changes, as Codex starts a new thread                             | A binding that publishes the new native session id after `/clear`                                                                                           |

The other capabilities select behaviour through driver members (`transfer`, `history`,
`plugins`, `tui.images`) or only add copy, and suit any CLI that provides those members.

`server/features/tools/` derives the minimum-version table (`MINIMUM_CLI_VERSIONS` in
`cli-version.js`), the install table (`nativeInstallers`) and the update commands
(`updateCommands` in `tool-update.js`) from these fields. Launch arguments per mode come
from `launchModes` (`server/features/accounts/account-store.js`).

## Driver

`cliDriver(id)` returns a frozen object. The JSDoc in `drivers.js` is the short form.

**Account and profile**

- `definition`: the record above.
- `profileEnv(root)`: the variables that isolate one account under `root` (`CODEX_HOME`;
  `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`; OpenCode's four
  `XDG_*_HOME`).
- `configRoot(env, home)`: where the CLI keeps its configuration for `env`, falling back
  to `env.HOME || home`.
- `dataRoot(env, home)`: where it keeps history and databases (OpenCode:
  `XDG_DATA_HOME/opencode`; the others: `configRoot`).
- `parseAuthStatus(stdout, exitCode, stderr)`: `{ signedIn, state }`.
- `credentials`: `null`, or (Codex) how a managed account keeps its credentials:
  `seedProfile(root, { apiKey, providerSelected })` for a new account,
  `storeApiKey(root, apiKey, { providerSelected })` for a rotated key, `args()` (the
  command-line overrides every process of the account takes, read through
  `AccountStore.credentialArgs(id)`) and `pin(launch, profileDir)` (repairs the file
  stores before a plain launch).
- `loginStore`: `null`, or (Claude Code) how a managed account keeps its login in its
  own folder where the CLI would use the macOS keychain: `supported(platform)`,
  `shim` (`{ name, source }`, the stand-in put first on PATH), `marked(root)` (whether
  the account is on the file store), `environment(env, shimDirectory)`,
  `settle(root, { busy, run, user })` (moves an existing keychain item into the file
  while no session of the account runs, and returns `"file"` or `"keychain"`),
  `forget(root, { run, user })`, `localHidden(home, env)` and `managedHidden(root, env)`. Callers go through
  `accounts/managed-logins.js`; [sandbox.md](sandbox.md#what-claude-code-and-codex-need-in-a-sandbox)
  describes the behaviour.
- `sandboxLaunch?(launch)`: the launch with what the CLI itself needs inside a nono
  sandbox, applied by `nono/nono-launch.js` to sandboxed launches only: Codex's
  `SSL_CERT_FILE` on macOS and the operator's own CA file, Claude Code's socket
  folder and the folders a managed account links to `~/.claude`. Absent for OpenCode.
- `provider`: how the CLI runs against a provider connection. `environment(env, {
directory, key, description, adapterRoute, adapterToken })` returns the launch
  environment; `launch(result, ctx)` (Claude Code) or `endpointLaunch` and `catalogLaunch`
  (Codex, OpenCode) configure the launch. The module imports only leaf helpers, never
  `provider-environment.js`, `provider-launch.js` or `drivers.js`.
- `transfer`: `null` unless `capabilities.accountTransfer`; otherwise how a session moves
  between accounts: `locate`, `safePath`, `destination`, `companions` and `validator`.
- `profileFiles`: `{ roots, credentials, backupAllowlist, configFiles }`, the profile
  folders, credential files, per-folder backup rules and editable config files.
  Also `sharedDocuments(root, env)` (the config documents profiles share, with their keys
  and `createIfMissing`), `extensions(args)` (config files, key, skill target and sources
  of the extensions page; `args` carries `env`, `home`, `account`, `boundary`, `shared`,
  `skillScope` and `sharedProfiles`), `assetDirectories` (extra shared asset folders) and
  `nativeFolder` (the CLI's folder below a profile; the home folder is
  `"." + nativeFolder`). `agents` (`{ format: "toml" | "markdown", frontmatter }`) is
  how the Agency page writes a native agent file: TOML, or markdown with that front
  matter.
- `mcp`: the CLI's native MCP entry. `toNative(entry)` builds it from a central server;
  `fromNative(entry, shape)` reads the central fields back, with the parse helpers
  passed in as `shape`; `timeouts` (`{ [nativeKey]: { field, scale } }`, in read and
  write order), `remoteSseAsHttp` (its remote entry cannot tell SSE from HTTP) and
  `keepsOAuthScope` (its native form has no OAuth scope).

**Session launch**

- `addMcpServer(launch, { name, command, args, env? }, claude?)`: adds a stdio MCP
  server to the launch's `args`/`env`. Claude Code also needs
  `{ pluginFolder, manifest, write }`.
- `inlineMcpNames(env)`: the MCP server names the launch environment already holds inline
  (OpenCode's `OPENCODE_CONFIG_CONTENT`, which throws when invalid; `[]` for the others).
  The session, memory and SSH launches reject their reserved names with it.
- `addSessionHooks(launch, options)`: adds a session integration (AgentBus). `options`
  holds `name`, `script`, `events`, `server`, `pluginFolder`, `manifest`, `write`,
  `pluginUrl`, `invalid` and `quote`. It adds one hook per event of `events`
  (`{ [event]: timeoutSeconds }`) running `script` with the event name, plus its MCP
  `server`. Codex adds the server and one `-c hooks.<event>=` override per
  event under the managed hook `name`; Claude Code writes `hooks/hooks.json` into the
  plugin from `pluginFolder()` and adds the server with `manifest`; OpenCode appends
  `pluginUrl` to `OPENCODE_CONFIG_CONTENT.plugin` (its plugin bridges hooks and tools)
  and throws `invalid()` for a malformed configuration.
- `addPluginFolder?(launch, { folder, manifest, write })`: makes `folder` a plugin of the
  launch and returns it (Claude Code), so `addReminder` has a plugin to write into; the
  session secrets hint uses it.
- `addReminder(launch, { name, script, pluginUrl, folder, invalid })`: adds a start hook (a
  Codex hook `name` running `script`, a SessionStart hook in the Claude plugin `folder`,
  or the OpenCode `pluginUrl`).
- `prepareRequests({ broker, id, file, args, env, grants }, launch)`: starts the
  approval relay, changing `args`, `env` and `grants` in place; may return a replacement
  launch (Codex's wrapper).
- `grantDirectory(launch, directory, { reload, ensure, profile, accountDirectory })`:
  grants the session's chat attachment folder and returns whether it did. Claude Code and
  Codex add `--add-dir` after `ensure()` created the folder (a reload skips `ensure`);
  Codex also pins its sandbox unless the mode is `yolo` (on a reload only when the launch
  lacks it). OpenCode writes an account-wide `references` entry into the profile
  (`profile`: a function returning the location, called only by OpenCode) and changes
  nothing on a reload.
- `shellToolName`: the tool whose requests carry a shell command line.
- `requests`: `launchRecord?(env)` adds fields to the launch file (Claude Code's hook
  version and trust file). `capabilities.requestHandoff`: an uncertain request can be
  released to the CLI's own terminal dialog.
- `startupDialogs`: `{ [presentation]: answer(broker, entry, choice) }` for the startup
  dialogs AgentPier answers in the terminal.

**Native session binding** (`binding`; which native thread a session belongs to)

- `idOptional`: a hook may record a launch before the CLI names its session (OpenCode).
- `addHooks(launch, options)`: `options` holds `id`, `directory`, `script`,
  `cliVersion`, `atLeast`, `pluginUrl`, `ensureDir`, `write`, `quote` and `fail`. It
  adds the hooks that run `script --record`. Codex merges them into existing
  `-c hooks.SessionStart=`/`hooks.UserPromptSubmit=` overrides; Claude
  Code adds `--session-id` (unless the launch resumes or names one) and the identity,
  activity and (from 2.1.152) live reply plugins below `directory`; OpenCode writes a
  TUI config with the `pluginUrl` plugin. `fail(key)` builds the session problem `key`.
- `resolve?(binding, session, { forInput, receipt, resolveProcess })`: the thread of the
  running process, or `null` to use the hook receipt (Codex, through its app-server
  history).
- `reportedActivity?(binding, session, activity)`: the reported activity, ended when the
  transcript shows an Esc interrupt (Claude Code).
- `hookActivity?(payload)`: the activity a hook payload reports, or `null` (Claude Code).

A tool without a driver (`shell`) still reaches the binding: it reads the defaults
`{ idOptional: false }` without the optional members, so a hook record needs a native
id, `reportedActivity` returns the reported activity unchanged and a hook payload
reports no activity. `resolve` returns `null` for `shell` and login sessions before any
member is used.

**History** (`history`; each call gets the owning `ProviderHistory` as `history`)

- `list(history, session)`, `read(history, session, id)`.
- `readPage(history, session, id, state)`: the native page, or `null` to fall back to a
  full read.
- `readReloadContext(history, session, id)`.
- `normalize` and `observe` take what the CLI's reader produced: Codex
  `normalize(thread)`, `observe(thread, records)`; Claude Code `normalize(records)`,
  `observe(records)`; OpenCode `normalize(exported)`, `observe(exported)`.
- `watchRoots(env, home, cwd)`: folders to watch while a chat has no known sources.
- `slashCommands(scan, env, cwd)`: discovers custom slash commands.
- `transcriptFiles(home)`: the transcript walk plan (steps of
  `{ folder, depth, pattern, companion, perFolder? }`) of a CLI with
  `capabilities.transcriptCleanup`.
- `models?(history, session)`: the models the CLI's picker can display (Codex), which a
  reload uses to read the displayed model back.

**Terminal** (`tui`)

- `activity({ lines, original, last, tail })`: `{ state, evidence?, animated? }` once the
  shared dialog checks found nothing to answer.
- `composer({ raw, lines, row, line, plain, pane })`: `{ state, text }` of the draft.
- `modelPicker`: `openKeys` (steps of `{ keys }`, `{ type }` or `{ pauseMs }`),
  `parse(raw)` (the picker or `null`), `current(raw)` (the model shown),
  `promptReady(raw)` (whether the picker may be opened), `unsupported(raw)` (a picker
  AgentPier must not drive), and `resolveDisplayed?(displayed, options)`: the
  `{ modelId, reasoningEffort? }` behind the displayed name on a reload, or `undefined`
  when it cannot be kept. `options` holds `observed`, `fallback`, `models`, `identifier`
  and `unavailable`. Without it (OpenCode) only an exact model id is kept.
- `limitWarning({ raw, pane, styled, lines })`: visible native limit warnings.
- `queuedInputs({ raw, styled, lines, row, pane, hashes })`: the hashes of the inputs
  the CLI shows as queued, built with the `hashes(values, pane, limit?)` it is given;
  `row` is the cursor row. Rows that are incomplete, wrapped or restyled read as none.
- `promptState?({ raw, pane })`: the native prompt box
  (`{ state: "empty" | "draft", rows }`, `{ state: "dialog" }` or
  `{ state: "unknown" }`) for CLIs without image chips (Codex, OpenCode); `undefined`
  reads as unknown.
- `promptProof?(rows, text)`: whether the draft rows show `text` in another form than its
  lines (Codex joins wrapped rows).
- `blockingScreen?(raw, { cwd, started })`: a screen that holds chat input as a pending
  request (Codex hook review, Claude Code startup dialogs).
- `images`: `pathText(file)` (the paste of one image path; Codex quotes it),
  `wait?(manager, session, count, { timeoutMs, exact })` (the chip wait, default
  `waitForNativeImages`), and for a CLI with `capabilities.imagePaste`
  `draft?(composer, message, { text })` and `chipsOnly?(raw, pane, count)`.

**Pipelines** (`pipeline`)

- `command({ args, mode, sessionId, resumeNativeId, headless, claudeDefault })`:
  `{ args, permissions }`.
- `sessionArgs(sessionId)`, `promptArgs(prompt)`.
- `events`: `nativeId(event)`, `failed(event)`, `progress(state, event)`,
  `completed(event)`.

**Plugins** (`plugins`)

- `inventory(store, ctx, selected)`, `selection(action, input)`,
  `actionArgs(action, selection)`.
- `configFolders`, `catalogFiles`, `catalogInstall`, `cliList` (how `plugin list` is
  used), and for OpenCode `removeFromConfig(ctx, id, recheck)`.

## Adding a coding CLI

1. Write `server/features/clis/<id>/definition.js` with every field above; add it to
   `catalog.js` and to `CODING_CLI_IDS` at its place in the list order.
2. Write the driver files of the layout table and register them in `drivers.js`.
3. Extend `tests/unit/cli-catalog.test.js`, `tests/unit/cli-drivers.test.js` and the
   launch characterisation (`tests/fixtures/cli-launch-characterisation.json`).
4. Add the installer's redirect target to `bootstrapRedirects` in
   `server/features/tools/native-installer.js`. Provider support goes into
   `server/features/clis/<id>/provider.js` (the `provider` member); the shared endpoint
   metadata stays in `server/features/providers/provider-launch.js`.
5. Extend the per-CLI maps outside `clis/` that the guard below allowlists. Without an
   entry the new CLI falls back to a default or is refused, with no error that says why:
   `ROUTE_CHOICES` and `DEFAULT_ROUTING` in `server/features/providers/endpoint-routing.js`
   and their mirror in `web/features/provider-connections/endpoint-routes.js` (pinned
   by `tests/unit/endpoint-routes-parity.test.js`; without them `validateRouting`
   refuses the CLI), `CLIENT_PROTOCOL` in `providers/adapter-launch.js`, the provider
   key variables in `providers/provider-definitions.js`, the ask-first permission mode in
   `pipelines/standalone-profile.js`, the MCP documentation links in
   `web/features/mcp/setup.js`, the built-in slash commands in
   `web/features/chat/slash-commands.js` and the description copy in
   `web/features/dashboard/ToolGrid.jsx`. Add the CLI's project credential file (for
   example `.codex/auth.json`) to `server/features/pipelines/private-paths.js`, or it is
   not kept private in pipeline diffs and artifacts.
6. Implement every driver member. Callers use the required ones without a check, so a
   missing one throws a `TypeError` instead of falling back to another CLI: `profileEnv`,
   `configRoot`, `dataRoot`, `parseAuthStatus`, `addMcpServer`, `inlineMcpNames`,
   `addSessionHooks`, `addReminder`, `grantDirectory`, `prepareRequests`,
   `shellToolName`, `startupDialogs`, every `history` member except `models` and
   `transcriptFiles`, `tui.activity`, `tui.composer`, `tui.limitWarning`,
   `tui.queuedInputs`, `tui.images.pathText`, the `tui.modelPicker` members except
   `resolveDisplayed`, every `pipeline`, `plugins`, `profileFiles` and `mcp` member,
   `provider.environment` with `launch` or `endpointLaunch` and `catalogLaunch`, and
   `binding.idOptional` and `binding.addHooks`. Members marked `?` above are optional;
   `transfer`, `credentials` and `history.transcriptFiles` follow their capability.
   Check whether the CLI keeps its login in the system keychain or verifies TLS
   through it: a sandboxed session reaches neither, so such a CLI needs a
   `loginStore` or a `sandboxLaunch` (see [sandbox.md](sandbox.md#what-claude-code-and-codex-need-in-a-sandbox)).
   Then walk the files in the branch budget (below) and decide for each whether the new
   CLI needs handling there; prefer a capability or driver member to a new branch.
7. Add the CLI's mark to `web/components/ProviderMark.jsx`; UI copy goes through the
   German and English catalogs.
8. Update [CLI updates](cli-updates.md), [providers](providers.md) and the READMEs.

## Guard tests

`tests/unit/cli-id-lists.test.js` keeps CLI knowledge in the drivers:

- No array literal outside `server/features/clis/` (and the web app outside
  `web/lib/i18n/`) lists two or more coding CLI ids, except allowlisted ones.
- No file outside `server/features/clis/` (and the web app outside `web/lib/i18n/`)
  holds an object literal keyed by two or more coding CLI ids unless it is on
  `MAP_ALLOWED`, the list of per-CLI maps in step 5 of "Adding a coding CLI".
- No server file outside the drivers reads `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME` or the home folders `.codex`, `.claude`,
  `.claude.json`, `.config` and `.local`, except allowlisted files with a reason.
- **Branch budget**: `=== "codex"`, `!== "claude"` and the like outside
  `server/features/clis/` in `server/` and `web/` are counted per file. The counts are
  exact: a file above its count fails, and so does a file below it. Lower or remove the
  entry in the change that removed the branch.

Every allowlist may only shrink; an entry that no longer matches fails the test.

`tests/unit/cli-driver-hooks.test.js` guards the drivers themselves:

- **Import cycles**: no module reachable from `server/features/clis/drivers.js` may
  import `drivers.js`. Modules on the driver import graph may read `catalog.js`, a leaf.
  A driver file imports only leaf helpers from features (`endpoint-launch.js`,
  `claude-provider.js`, `native-config.js`, `codex-credential-stores.js`,
  `adapter-launch.js`, `lib/*`), never `provider-environment.js`, `provider-launch.js`
  or another module that imports `drivers.js`; a helper a driver body needs from such a
  module is passed in as an argument. A second test fails on any new cycle in the graph;
  `KNOWN_CYCLES` lists the two that predate it, both inside
  `server/features/providers/` (`endpoint-config.js` with `provider-definitions.js`,
  and with `endpoint-routing.js`).
- **Frozen drivers**: every member of every driver is frozen all the way down, so no
  caller can change another caller's driver.

## Remaining branches

`BRANCH_BUDGET` holds 47 branches in 28 files. Each one stays on purpose; the default
arm (no special handling) is right for any other CLI.

| Group                         | Files                                                                                                                                                       | Why it stays                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex plugin catalog          | `plugins/codex-catalog.js` (4), `plugins/plugin-store.js` (1), `web/features/plugins/CatalogAccount.jsx` (1)                                                | Codex's signed-in plugin catalog and its remote marketplace are a Codex product feature; the module is Codex by name                               |
| Codex marketplace shape       | `plugins/plugin-schema.js` (2)                                                                                                                              | Reads Codex's `marketplaceSource` payload; the other arm is the generic one                                                                        |
| Codex remote plugins          | `cli-profiles/configuration.js` (2)                                                                                                                         | Codex-only scoping of remote plugins; other CLIs pass through unchanged                                                                            |
| Codex MCP login               | `mcp-servers/cli-oauth-status.js` (2), `mcp-servers/codex-mcp-logins.js` (2)                                                                                | Runs `codex mcp list` and `codex mcp login` and finds the Codex binary; moves to `mcpOAuth` when a second CLI implements it                        |
| Codex process resolver        | `sessions/native-session-process.js` (3)                                                                                                                    | Guards `resolveCodexProcess`, the Codex app-server identity check                                                                                  |
| Guards in CLI-named modules   | `requests/claude-folder-trust.js` (2), `requests/claude-runtime.js` (2), `requests/claude-startup-prompts.js` (1), `requests/codex-hook-trust.js` (1)       | Defensive id checks inside modules that serve one CLI                                                                                              |
| Claude hook protocol          | `requests/request-broker.js` (4), `web/features/requests/NativeRequest.jsx` (1)                                                                             | Hook-script handover, the `AskUserQuestion` tool, the `claude-display` push and Claude's approval presentation are Claude Code wire-protocol facts |
| AgentBus wake quirks          | `agentbus/agentbus-broker.js` (4)                                                                                                                           | Codex notice dedupe and binding check, Claude permission-class hold; a new CLI cannot reach them until AgentBus supports it (`unknownCliTool`)     |
| Claude provider version retry | `accounts/account-store.js` (1)                                                                                                                             | Retry policy of Claude's custom-model version check; no retry is right for the others                                                              |
| Per-CLI copy                  | `web/features/chat/NativeDeliveryBadge.jsx` (1), `web/features/extensions/ExtensionWorkspace.jsx` (1), `web/features/providers/ProviderModelPicker.jsx` (1) | Hints about one CLI's own behaviour (Codex queue after a tool call, Codex shared skills, Anthropic's provider notice)                              |
| Codex catalog field           | `web/features/providers/ProviderModelDetails.jsx` (1)                                                                                                       | `codexContextTokens` is a field of Codex's model catalog                                                                                           |
| CLI marks                     | `web/components/ProviderMark.jsx` (3)                                                                                                                       | SVG artwork per CLI; JSX cannot live in a definition                                                                                               |
| Paste-burst delay             | `sessions/session-chat-input.js` (1), `sessions/session-slash-command.js` (1)                                                                               | Codex needs 250 ms after a typed slash command before Enter (its paste-burst window); one number, little value as a member                         |
| Model-picker resize           | `models/model-controller.js` (1)                                                                                                                            | Claude Code's picker is resized before it opens                                                                                                    |
| Claude subagent watch folder  | `chat/chat-source-watch.js` (1)                                                                                                                             | Also watches Claude Code's subagent transcript folder                                                                                              |
| Claude 1M context             | `chat/context-window.js` (1)                                                                                                                                | Assumes Claude's context window per model family when no limit is reported                                                                         |
| Claude built-in tools         | `requests/request-approvals.js` (1)                                                                                                                         | Claude Code's built-in tools that never need an approval                                                                                           |
| Pipeline `claudeDefault`      | `pipelines/native-profile.js` (1)                                                                                                                           | Computes the `claudeDefault` argument of `pipeline.command` for an interactive Claude Code turn in the default mode                                |

Paths without a leading folder are below `server/features/`.

Known gaps the refactor left in shared code:

- A reload that keeps a reasoning effort adds Codex's `-c model_reasoning_effort=`
  in `server/application/session-reload-lifecycle.js`; only Codex's
  `resolveDisplayed` returns an effort today.
- The copy named under capabilities above still names Codex.
- The two `KNOWN_CYCLES` in `server/features/providers/`.

## Fit check: Gemini CLI and Cursor CLI

A paper check (2026-11-02, from the CLIs' documentation; no code) of whether the
interface could carry two further CLIs. "Unverified" marks points the documentation
leaves open. Terminal sessions stay the core: a CLI that only works through ACP does not
qualify.

| Member                   | Gemini CLI 0.66                                                        | Cursor CLI (`agent`) 2026.10.22                                                                  |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npmPackage`             | `@google/gemini-cli`                                                   | none (native installer only)                                                                     |
| `nativeInstaller`        | none (npm only)                                                        | `https://cursor.com/install`, bash                                                               |
| `updateArgs`             | `["update"]`                                                           | `["update"]`                                                                                     |
| `minVersion`             | `0.66.0`                                                               | `2026.10.22` (date-shaped, parses as x.y.z)                                                      |
| `launchModes`            | `--approval-mode default\|auto_edit\|yolo\|plan`                       | unverified                                                                                       |
| `loginArgs`              | `[]` (Google OAuth in the TUI)                                         | `["login"]`                                                                                      |
| `authStatusArgs`         | none: no status command                                                | `["status"]`                                                                                     |
| `apiKeyEnv`              | `GEMINI_API_KEY`                                                       | `CURSOR_API_KEY`                                                                                 |
| `resumeArgs`             | `["-r", id]`                                                           | `["--resume", id]`                                                                               |
| `protocol`               | Gemini API, none of the three                                          | no custom endpoint                                                                               |
| `profileEnv`             | `GEMINI_CLI_HOME=<root>`, `GEMINI_FORCE_FILE_STORAGE=true`             | `CURSOR_CONFIG_DIR=<root>`, but the macOS login sits in fixed keychain items                     |
| `configRoot`, `dataRoot` | `<GEMINI_CLI_HOME or home>/.gemini`                                    | `CURSOR_CONFIG_DIR`, `XDG_CONFIG_HOME/cursor` or `~/.cursor`                                     |
| `parseAuthStatus`        | no command to read                                                     | `agent status` output (format unverified)                                                        |
| `addMcpServer`           | `mcpServers` in `settings.json` (file, not args/env)                   | `~/.cursor/mcp.json` or `.cursor/mcp.json` (file)                                                |
| `addReminder`            | hooks in `settings.json`; `GEMINI.md`                                  | hooks file; `.cursor/rules`, `AGENTS.md`                                                         |
| `prepareRequests`        | `BeforeTool` can only deny or rewrite; `Notification` only observes    | `beforeShellExecution`/`beforeMCPExecution` allow/deny/ask; `preToolUse` (unverified in the CLI) |
| `shellToolName`          | unverified                                                             | the shell hook is its own event                                                                  |
| `startupDialogs`         | to be recorded                                                         | to be recorded                                                                                   |
| `history` read           | JSONL `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl`             | SQLite `<cfg>/chats/<md5(cwd)>/<uuid>/store.db`, undocumented, changes per release               |
| `watchRoots`             | `<cfg>/tmp/<project_hash>/chats`                                       | `<cfg>/chats/<md5(cwd)>`                                                                         |
| `slashCommands`          | skills in `~/.gemini/skills`; commands unverified                      | unverified                                                                                       |
| `tui`                    | screens to be recorded; `BeforeAgent`/`AfterAgent` hooks for busy/idle | screens to be recorded; `beforeSubmitPrompt`/`stop` hooks; own tmux persistence mode             |
| `pipeline`               | `-p`, `--output-format stream-json`, `-m`                              | `-p`, `--output-format stream-json`, `--model`                                                   |
| `plugins`                | unverified                                                             | none known                                                                                       |
| `profileFiles`           | `.gemini` (file storage forced)                                        | config folder; the macOS keychain login is outside it                                            |

Gaps, as interface follow-ups:

1. **Install channel optional.** Every definition must carry `npmPackage` and
   `nativeInstaller` today; Gemini has no native installer and Cursor no npm package.
2. **No auth-status command** (Gemini). `authStatusArgs`/`parseAuthStatus` need a
   "cannot tell" form that the account page shows as unknown.
3. **Approval relay that cannot approve** (Gemini). Its hooks deny or observe only;
   approving means typing in the TUI. `prepareRequests` needs a way to say "answer in
   the terminal" rather than relay.
4. **MCP servers and reminders through files.** `addMcpServer`/`addReminder` change the
   launch's args and env; Gemini and Cursor read MCP servers and hooks from settings
   files, which would need a per-session file layer.
5. **Account isolation on macOS** (Cursor). Its login lives in fixed keychain items, so
   `profileEnv` cannot separate subscription accounts; only API-key accounts or a
   separate `HOME` would.
6. **History without a stable format** (Cursor). The SQLite store is undocumented and
   changes between releases; `stream-json` covers pipelines but not terminal sessions.
7. **Protocol** (both). `protocol` would need a Gemini API value, or `null` for a CLI
   without custom endpoints.
8. **Own tmux mode** (Cursor). Its undocumented persistence mode
   (`CURSOR_AGENT_PERSIST_SESSION`, private `-L` server) must be kept off in the launch
   environment.
9. **Optional plugins.** `plugins` assumes each CLI has a plugin system.
10. **History context.** History members take the `ProviderHistory` instance (clients,
    caches, running jobs); a new CLI has to learn which of its parts it may use.

Not interface gaps but product facts: since 2026-06-18 Gemini CLI targets Code Assist
Standard/Enterprise (free users moved to Antigravity CLI), and reusing its OAuth token
outside the real binary can suspend accounts.
