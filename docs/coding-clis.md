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

| File                      | Runs in       | Holds                                                                |
| ------------------------- | ------------- | -------------------------------------------------------------------- |
| `catalog.js`              | browser, Node | Ids in list order, `cliDefinition`, `cliName`, `isCodingCli`         |
| `<id>/definition.js`      | browser, Node | The definition record (pure data, frozen)                            |
| `drivers.js`              | Node          | `cliDriver(id)`: assembles and freezes each driver                   |
| `<id>/profile.js`         | Node          | `profileEnv`, `configRoot`, `dataRoot`, `parseAuthStatus`            |
| `<id>/session-config.js`  | Node          | `addMcpServer`, `addReminder`                                        |
| `<id>/requests.js`        | Node          | `prepareRequests`, `shellToolName`, `startupDialogs`, `launchRecord` |
| `<id>/history.js`         | Node          | The `history` members                                                |
| `<id>/tui.js`             | Node          | The `tui` members; shared screen helpers live in `tui-screen.js`     |
| `<id>/pipeline.js`        | Node          | The `pipeline` members                                               |
| `<id>/plugins.js`         | Node          | The `plugins` members                                                |
| `<id>/profile-files.js`   | Node          | The `profileFiles` members                                           |
| `<id>/provider.js`        | Node          | The `provider` members (provider environment and launch)             |
| `<id>/transfer.js`        | Node          | The `transfer` members (Codex and Claude Code only)                  |
| `codex/history-client.js` | Node          | Codex's read-only app-server client for its history                  |

`catalog.js` imports only the definitions, and neither imports Node modules or anything
outside `clis/`: the web app bundles them (`web/features/**` imports
`server/features/clis/catalog.js`). `catalog.js` deep-freezes every definition once. A feature reaches a driver through `cliDriver(id)`; it imports a driver's helper module
directly only to avoid an import cycle (for example `opencode-history-page.js`, the
history imports in `provider-history.js` and `inlineConfig`). Drivers are stateless.
Whatever state a call needs is passed in: the launch being built, the environment and
home, or the owning service (for example the `ProviderHistory` instance for `history`).

## Definition

| Field                      | Meaning                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `shortName`  | Id, full name (`Claude Code`) and short name (`Claude`)                                                                                                                                                                               |
| `docsUrl`                  | Official installation and update guide                                                                                                                                                                                                |
| `npmPackage`               | The npm package of older AgentPier-managed installations                                                                                                                                                                              |
| `nativeInstaller`          | `{ url, shell, args, directory }` of the official install script                                                                                                                                                                      |
| `updateArgs`               | Arguments of the CLI's own update command                                                                                                                                                                                             |
| `minVersion`               | Minimum version for sessions (see [CLI updates](cli-updates.md#minimum-cli-versions))                                                                                                                                                 |
| `launchModes`              | `{ mode: args }`; `default` is always present                                                                                                                                                                                         |
| `defaultLaunchMode`        | The mode new accounts start in                                                                                                                                                                                                        |
| `unattendedModes`          | Modes that skip every approval (Codex `yolo`, Claude `bypass`, OpenCode `auto`)                                                                                                                                                       |
| `unattendedArgs`           | Permission arguments that make a session unattended (AgentBus permission class)                                                                                                                                                       |
| `loginArgs`                | Sign-in command (`[]`: the CLI signs in inside its own TUI)                                                                                                                                                                           |
| `authStatusArgs`           | Command whose output `parseAuthStatus` reads                                                                                                                                                                                          |
| `apiKeyEnv`                | Variable for API-key accounts                                                                                                                                                                                                         |
| `resumeArgs(sessionId)`    | Arguments that resume a native session                                                                                                                                                                                                |
| `questionView(q)`          | Chat view `{ multiple, allowOther, previews, notes }` of one native question                                                                                                                                                          |
| `configFormat`             | Format of the CLI's config files: `toml`, `json` (no comments) or `jsonc`                                                                                                                                                             |
| `protocol`                 | Custom-endpoint protocol: `responses`, `messages` or `chatCompletions`                                                                                                                                                                |
| `capabilities`             | `accountTransfer`, `transcriptCleanup`, `storageCleanup`, `mcpOAuth`, `imagePaste`, `endpointSdkRouting`, `requestHandoff`, `hookTrust`, `keychainCredentials`, `transcriptIndex`, `npmPlugins`, `pluginBridge`, `clearResetsBinding` |
| `pipeline.permissionModes` | Permission modes a pipeline profile may choose                                                                                                                                                                                        |

`accountTransfer`, `transcriptCleanup`, `storageCleanup`, `mcpOAuth` and
`endpointSdkRouting` (the CLI reaches a custom endpoint through its own SDK providers, so
its route choices name a protocol: OpenCode) are read by their consumers. `imagePaste` is declared; consumers still branch on the id
(counted in the branch budget of `tests/unit/cli-id-lists.test.js`).

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
  `nativeFolder` (the CLI's folder below a profile; the home folder is `"." + nativeFolder`). `agents` (`{ format: "toml" | "markdown", frontmatter }`) is how
  the Agency page writes a native agent file: TOML, or markdown with that front matter.

**Session launch**

- `addMcpServer(launch, { name, command, args, env? }, claude?)`: adds a stdio MCP
  server to the launch's `args`/`env`. Claude Code also needs
  `{ pluginFolder, manifest, write }`.
- `inlineMcpNames(env)`: the MCP server names the launch environment already holds inline
  (OpenCode's `OPENCODE_CONFIG_CONTENT`, which throws when invalid; `[]` for the others).
  The session, memory and SSH launches reject their reserved names with it.
- `addReminder(launch, { name, script, pluginUrl, folder, invalid })`: adds a start hook (a
  Codex hook `name` running `script`, a SessionStart hook in the Claude plugin `folder`,
  or the OpenCode `pluginUrl`).
- `prepareRequests({ broker, id, file, args, env, grants }, launch)`: starts the
  approval relay, changing `args`, `env` and `grants` in place; may return a replacement
  launch (Codex's wrapper).
- `shellToolName`: the tool whose requests carry a shell command line.
- `requests`: `launchRecord?(env)` adds fields to the launch file (Claude Code's hook
  version and trust file). `capabilities.requestHandoff`: an uncertain request can be
  released to the CLI's own terminal dialog.
- `startupDialogs`: `{ [presentation]: answer(broker, entry, choice) }` for the startup
  dialogs AgentPier answers in the terminal.

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
- `transcriptFiles(home)`: the transcript walk plan (steps of `{ folder, depth, pattern, companion, perFolder? }`) of a CLI with `capabilities.transcriptCleanup`.

**Terminal** (`tui`)

- `activity({ lines, original, last, tail })`: `{ state, evidence?, animated? }` once the
  shared dialog checks found nothing to answer.
- `composer({ raw, lines, row, line, plain, pane })`: `{ state, text }` of the draft.
- `modelPicker`: `openKeys` (steps of `{ keys }`, `{ type }` or `{ pauseMs }`),
  `parse(raw)` (the picker or `null`), `current(raw)` (the model shown),
  `promptReady(raw)` (whether the picker may be opened), `unsupported(raw)` (a picker
  AgentPier must not drive).
- `limitWarning({ raw, pane, styled, lines })`: visible native limit warnings.

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
   `server/features/tools/native-installer.js` and the provider support in
   `server/features/providers/`.
5. Walk the files in the branch budget (below) and decide for each whether the new CLI
   needs handling there; prefer a capability or driver member to a new branch.
6. Add the CLI's mark to `web/components/ProviderMark.jsx`; UI copy goes through the
   German and English catalogs.
7. Update [CLI updates](cli-updates.md), [providers](providers.md) and the READMEs.

## Guard tests

`tests/unit/cli-id-lists.test.js` keeps CLI knowledge in the drivers:

- No array literal outside `server/features/clis/` (and the web app outside
  `web/lib/i18n/`) lists two or more coding CLI ids, except allowlisted ones.
- No server file outside the drivers reads `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME` or the home folders `.codex`, `.claude`,
  `.claude.json`, `.config` and `.local`, except allowlisted files with a reason.
- **Branch budget**: `=== "codex"`, `!== "claude"` and the like outside
  `server/features/clis/` in `server/` and `web/` are counted per file. The counts are
  exact: a file above its count fails, and so does a file below it. Lower or remove the
  entry in the change that removed the branch.

Every allowlist may only shrink; an entry that no longer matches fails the test.

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
