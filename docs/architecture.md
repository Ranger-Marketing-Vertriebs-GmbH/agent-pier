# Architecture

AgentPier hosts native coding CLI sessions on one macOS or Linux machine. React is the browser client; an Express application owns configuration, domain services and a private tmux server. The browser never runs a separate model conversation. Chat sends input to the same session displayed in Terminal.

## Boundaries

| Directory            | Responsibility                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| `web/app`            | Application shell, URL navigation, workspace polling and top-level dialogs         |
| `web/features`       | User-facing feature components, state hooks and local styles                       |
| `web/components`     | Shared controls, dialogs, pagination and error presentation                        |
| `web/lib`            | HTTP client, asynchronous action handling, provider labels and locale dictionaries |
| `web/styles`         | Global primitives, application layout and viewport rules                           |
| `server/application` | Service construction, session launch orchestration and shutdown                    |
| `server/http`        | Express routes, the API registry and route access, WebSocket transport             |
| `server/features`    | Domain services and native CLI adapters, grouped by capability                     |
| `server/lib`         | Filesystem/configuration boundaries, serialization, shared errors and locale data  |
| `tests`              | Unit, integration, blackbox, property, matrix and browser suites                   |

Keep business rules in their feature service. HTTP handlers validate transport shape, call the service and serialize public results. Components render feature state; shared components must not acquire dependencies on feature services. `npm run check:structure` rejects first-party source, style and test files above 600 lines. Extract by responsibility before reaching that limit; splitting one large class across arbitrary numbered files does not establish a useful boundary.

First-party identifiers and comments are English. German product text lives in explicit locale dictionaries. Native protocol names, recorded CLI text and parser examples retain their original spelling.

## Settings pages

Agent settings, Accounts, Settings, Extensions and Projects share one page pattern
(shell, tabs, list cards, per-tab drafts with a save chain, unsaved-changes guard). See
[settings-pattern.md](settings-pattern.md).

## Session launch and lifetime

The launch orchestrator validates the account, directory and launch mode, then composes host-bound GitHub credentials, AgentBus, repository memory, project SSH and native history binding. Each adapter returns additions to a launch description. Failed launches unwind generated resources. Account/provider changes are rejected while affected sessions run. Account usage is also reserved during launch preparation and reloads, including both accounts during an account switch; failed or deferred attempts release their reservations.

`SessionManager` serializes session operations, owns the private tmux socket and persists public session metadata. A web-process restart reconnects to existing terminals; it does not terminate them. New sessions are named `agentpier-<id>`. The rename from the former name `tuiui` runs in two releases, because the tmux server outlives a service restart, update or rollback: the previous release still produced `tuiui-<id>` on `/tmp/tuiui-<uid>-<hash>/tmux.sock` but already understood both names; the current release produces `agentpier-<id>` and still understands `tuiui-<id>`. It finds a session under either name, prefers a live pane when an id has both, then the `agentpier` name, ends both on stop, remove and replace, and counts both in system status. At startup it asks the tmux servers on both sockets, because tmux leaves its socket file behind when a server exits and `exit-empty off` keeps a server running without sessions or with dead panes only: the `agentpier` server wins while any pane of an AgentPier session there lives (or its probe times out); otherwise a server that answers on the `tuiui` socket stays in use, so sessions from before the update keep running there and new ones join it under `agentpier` names; otherwise the server runs on `/tmp/agentpier-<uid>-<hash>/tmux.sock`. While AgentPier runs on the `tuiui` server, system status and `/api/state` name its sessions with a stored record that have any live pane there (any window or split, not only the active pane, from `list-panes -a`) (id and name only), and the start page and the session list show **N sessions still run on the old tmux server**. At startup and before every session start (a new session or a relaunch, inside the exclusive creation lock), AgentPier checks whether only finished AgentPier sessions remain there: it then reads every stored running session once more, so exits and last screens are recorded instead of a lost server, ends the old server with `kill-server` on the `tuiui` socket only and moves to the `agentpier` socket. One server runs at a time, and no old server is left that a rollback could pick up. Any live pane of an AgentPier session, any session without a readable AgentPier record, or an unusable `agentpier` socket folder keeps the old server and leaves a diagnostic in the log (`server/features/sessions/legacy-tmux-server.js`). Release manifests list the understood forms in `tmuxNames`; activation and rollback refuse a release whose manifest lacks `agentpier`, and the release list shows it as not rollbackable (`server/features/sessions/tmux-naming.js`, `server/features/operations/release-schema.js`).

The stable `server/terminal-launcher.js`, `server/adapter-process.js`, `server/git-credential.mjs`, `server/github-credentials.js`, `server/native-session-binding.js` and `server/native-session-opencode.js` entry points are referenced by persisted or running CLI configurations. They remain compatibility boundaries even when their implementations move into features.

## Chat and native observations

Native history adapters normalize stored messages, tasks and available telemetry. Claude Code moves a session transcript into the project directory of its current working directory when it enters or leaves a worktree; the history adapter therefore resolves a transcript by session id across every project directory of the profile and readers verify the transcript's own cwd and session id before use. The chat store maintains a bounded snapshot and its explicit provenance. Native-bound sessions expose their authoritative conversation without a manual conversation picker; the backend rejects manual rebinding. Legacy sessions without native binding retain manual selection. A missing field remains unknown; configured model metadata must not be presented as a native observation. Session activity (working, ready, waiting) comes first from the CLI's own reports. Claude Code sessions carry an `agentpier-activity` plugin whose asynchronous `Stop`, `StopFailure`, `PermissionRequest`, `PreToolUse[AskUserQuestion]`, `Elicitation` and `SessionEnd` hooks, together with the identity plugin's `SessionStart` and `UserPromptSubmit`, write `native-sessions/<id>.activity.json` for the current launch token; `Stop` with running `background_tasks` counts as working. The Codex request bridge derives the state from the app-server's `turn/started`, `turn/completed` and `thread/status/changed` notifications, and the OpenCode TUI plugin from the visible session's busy status and pending dialogs. A pending AgentPier approval or question always means waiting. The terminal reader stays the fallback for older sessions and shells, and corrects a report it contradicts: Claude Code sends no event on Esc or a crash, so a reported turn or wait ends as soon as the session's transcript shows Claude's `[Request interrupted by user]` marker as its newest row after the report (recorded as an `Interrupt` report), or when the terminal shows an idle composer that has not changed for 15 seconds, and any report without screen changes for 10 minutes falls back to the terminal reading. An ended report stays ended until the CLI reports again, so typing in the terminal after Esc cannot revive it. A reload's last check under the session lock uses the same combined reading. The terminal reader uses the current native composer area and bounded caching. Neither path sends model requests to discover activity. A Claude Code 2.1.287 or newer also loads AgentPier's `agentpier-bridge` mod; once it reports for a launch, its turn start and end (an interrupt included) decide working and ready instead of the terminal reading and the interrupt marker, and only a dialog the hooks report afterwards or running background tasks override it (`server/features/claude-mod/`). The same reports also reach an open chat directly over the session's authenticated native request channel, so it reads again without waiting for the file watcher, and a reply streams into the chat while it is written (Codex app-server deltas, OpenCode part events, Claude Code's `agentpier-bridge` mod token by token, or else its asynchronous `MessageDisplay` hook in its own `agentpier-stream` plugin line by line); see [live chat updates](native-chat-delivery.md#live-chat-updates). Live chat file observation follows the reader's scoped source paths, shares session-metadata directory watches and keeps healthy file and tmux observers across recovery reads. A bounded stat probe repairs replaced or missing files; broad account-profile watches are not used.

The URL owns durable navigation state: page, session, Chat/Terminal mode, extension/plugin profile, AgentBus selection and memory filters. Local component state owns transient drafts and pending operations. Navigation cancels obsolete reads; pending mutations retain their operation identity and cannot submit twice.

See [native observation semantics and limitations](chat-observability.md) for the per-CLI context formula, identity correlation and source ordering.

## File Explorer

`server/application/files.js` composes the Explorer services in
`server/features/files/`. The HTTP adapters expose the same service through a global
scope and a session-project scope. A scope ID is an opaque observation of the current
root and read-only state; every mutation must present that current ID. Session scope is
recomputed from canonical CWD and cannot be widened by a request. Headless pipeline
sessions are read-only. The global scope begins at the configured home but is bounded by
the host root and the server process user's OS permissions.

Listings use bounded snapshots. Jobs, publications, Trash adoption, uploads, and ZIP
artifacts are durable in private Explorer storage, allowing recovery after web-process
restart without guessing an unrecorded filesystem outcome. Recovery combines recorded
checkpoints with fresh path observations; it does not make external native writers or
final check/action races transactional. Native descriptors and platform probes preserve
metadata and prove supported name policies before strict writes.

The React Explorer owns navigation and scoped clients. `FileEditorContext` owns tabs and
attempted bytes across route changes in one browser runtime; it never persists draft
content. A context change clears current authority before its replacement read completes,
so retained tabs cannot write through a stale project scope. See the
[File Explorer guide](file-explorer.md) for user workflows, limits, platform constraints,
and HTTP route families.

## Project memory

Memory resolves Git worktrees to their common repository identity. Independent clones, submodules and unrelated directories remain separate. A private SQLite WAL database stores entries, immutable revisions and session capabilities. Updates require the expected revision, so concurrent writers receive a conflict instead of silently overwriting one another.

Every supported coding CLI receives a native MCP server bound to its AgentPier session and project. The server supplies writer provenance, validates capability on each call and exposes bounded search with explicit full-entry retrieval. Shell and login sessions receive no project-memory integration. Memory is deliberately stored as reference material; the application does not promote retrieved notes into trusted system instructions. See [memory contracts and tools](memory.md).

## Provider configuration

The provider catalog retains native identifiers, advertised context, routed context, output limits, source and freshness. Launch adapters separately translate account configuration for Codex, Claude Code and OpenCode. Public account/session projections omit credentials; provider keys are passed through isolated native environment/configuration mechanisms. A model label is not evidence of protocol compatibility or a successful connection. See [provider compatibility and limits](providers.md).

Custom endpoint connections add two features that let every CLI use any endpoint protocol; see [the protocol adapter](protocol-adapter.md). `server/features/protocol-adapter/` is the pure translation library between Anthropic Messages, OpenAI Responses and Chat Completions (no network or filesystem). `server/features/adapter-runtime/` runs it per session: the supervisor inside the terminal launcher, the adapter child process, the HTTP server and the diagnostics file.

## Native pipelines

Pipeline definitions and task profiles are independent from credential accounts. The definition store validates profile configuration and bounded graphs before atomically persisting revisions. Run snapshots retain explicit profile and public account configuration without secrets. The execution engine owns durable attempts, human decisions, bounded loops, verification and recovery; injectable native/workspace ports own process and Git effects.

Native stages reuse the session lifecycle's account, provider, GitHub, AgentBus, memory and history preparation through trusted internal launch options. HTTP request bodies cannot supply executable transforms or pipeline ownership. Headless turns remain normal observable sessions, while the engine owns their input. Exact native results and scoped verdicts drive transitions; terminal appearance does not determine success.

An owned worktree isolates each run from its source checkout. Cancellation preserves it, and deletion has a separate ownership check. Verification plans reside in application data and execute through private supervisors with bounded logs and receipts that survive a web restart. Pipeline routes, filters, profiles and evidence tabs use durable URLs. See [pipelines](pipelines.md) and the [implementation contract](refactor/pipelines-plan.md).

## Live channel

The browser follows changing server state over one WebSocket per tab, `GET /api/live` (`server/http/live-websocket.js`), instead of polling REST routes. The upgrade passes the same origin check, login and admission as the chat stream; logout closes the socket with 1008. At most 16 sockets are open per principal (more are refused with 429).

- **Hub.** `LiveHub` (`server/features/live/live-hub.js`) is a registry of topics. A topic id is a name or `name:param`. Subscribers of the same topic id and access scope share one topic instance (`live-instance.js`), which reads the topic once for all of them, coalesces change signals (150 ms debounce, at most 1 s), raises its revision only when the digest of the value changed, and runs its samplers and change sources only while someone subscribes. A topic the principal may not see answers exactly like an unknown one (`unknown-topic`). `server/application/live-wiring.js` defines the topics and the deny-by-default gate: the owner reaches every topic whose own `authorize` admits him, a restricted user only the patterns in `userTopics` (`server/http/route-access.js`, empty until user pages subscribe).
- **Topics.** `state` (the workspace state of `GET /api/state`, as rows; sessions, accounts, connections and preferences push on every write or collect, the slow CLI and utility detection is cached for 60 s), `session.requests:<id>` (the request list of `GET /api/sessions/:id/requests`), `session.models:<id>` (the model control of `GET /api/sessions/:id/models`), `inbox` (the owner inbox of `GET /api/inbox`), `pipeline.run:<id>` (a run of `GET /api/pipeline-runs/:id`; a run that does not exist or was deleted is `{ run: null }`), `pipeline.queue:<projectId>` (a project's run queue of `GET /api/pipeline-queue/:projectId`), `pipeline.counts` and `pipeline.counts:<projectId>` (the count of each run status and the total, of all runs or of one project, as `GET /api/pipeline-run-counts[?projectId=]` answers it), `pipeline.runs:<projectId|*>:<status|*>` (page 1 of `GET /api/pipeline-runs?view=list` with those filters, `*` for none: each run in its slim list view, without the execution log, verdicts, prompts or actions) and the signal `pipeline.runs.changed[:<projectId>]` (a `changed` frame on any run change, of that project, after which a later page of the run list reads its route once). The pipeline topics are owner only and push on every saved run, on a deleted run and on every queue change; a run's change also reaches the queue that started it, and only the counts and lists the run is or was listed in (`server/features/pipelines/live-topics.js`). A save that changes nothing of the run's list view (an execution log entry) wakes no list, and one that keeps its project and status changes no count. The counts come from an in-memory index (`run-counts.js`) built with one scan of the run store at start and kept current by every save and delete, so the status pills, the run tab's total and the project hints no longer list the runs. The run list pages in SQLite (`RunStore.page`): only the 20 listed documents are parsed. The menu hints and the start page follow `pipeline.counts`, page 1 of `awaiting-human`, `failed` and `running`, and three owner-only topics: `settings.summary` (`GET /api/settings/summary`), `connections.problems` (`GET /api/connections/problems`) and, with agents on, `runtime.updates` (`GET /api/assistant-runtime/updates`). Their sources (about ten stores, the cached release check and the network config) announce no change of their own, so their change source is the write middleware `liveWriteSignals` (`server/application/live-wiring.js`): every successful `/api` write except the frequent session, chat, agent chat, `/me`, file, run, memory and artifact writes signals all three once it has answered, until those stores announce their changes themselves. Switching agents on or off signals the last two. A job that finishes after its request answered (a backup, a diagnosis) is not pushed into `settings.summary` until the next write; live, only its `operations.updates` part is read. `connections.problems` and `runtime.updates` are also sampled every 60 s while a visible tab watches, for stored tests, installs and update phases that change without a write. All three read local state only: no connection test, token check or remote update check runs. Without agent services `runtime.updates` refuses with the route's status (404 with agents off, 503 when they do not run), marked as expected so the hub does not log it, and the client reads the route once. Every topic carries the same value as its REST route, so the route stays the answer for `stale` and the fallback. `session.requests` follows the request broker's events; while a Claude Code session's startup is not complete, and for `STARTUP_GRACE_MS` (20 s) after its startup receipt, a startup dialog has no signal, so only then is the screen sampled every 1.5 s; afterwards the topic is event-driven. `session.models` samples the screen every 3 s while a tab subscribes, and only for a running, interactive session that is not reloading. A model read that fails or hangs is part of the payload (`error: {code}` beside the last model read), not a frame error, so the chat shows it and an unchanged failure sends nothing more.
- **Frames.** The server opens with `{type: "hello", instance}`. The client sends `sub` (with `have`, the revision or row cursor it already holds), `unsub` and `ping`. The answer to a `sub` is `same`, a `snapshot`, or for row topics a `delta` onto the client's cursor; later changes arrive as `state` (whole value) or `delta` (rows). `stale` asks the client for one REST read (a value over the topic's byte limit), as does an `error` without code when the topic's first read failed; `revoked` ends a subscription whose access was withdrawn, and `changed` is a signal without data.
- **Limits.** Client frames are at most 4 KiB; anything malformed closes the socket with 1008. A socket holds at most 64 subscriptions (`error` with code `limit`). A frame over the topic's `maxBytes` (256 KiB by default, 128 KiB for `state`, 1 MiB for `pipeline.run`, whose execution log has no bound) is sent as `stale`. A reader that falls behind keeps only the newest frame per topic above 256 KiB buffered and is closed with 1013 above 2 MiB. A closing server ends the sockets with 1012.
- **Fallback.** The client (`web/lib/live/live-client.js`) reconnects with backoff (0.5 s doubling to 30 s) and resubscribes with what it holds, so a reconnect costs no REST read. After three handshakes in a row fail (a proxy without WebSocket upgrade, for example), `useLiveTopic` polls each topic's REST route at its former interval (`web/lib/live/live-topics.js`), only while the tab is visible, and keeps retrying the socket. A topic the server refuses is polled the same way. After a 1008 close the client checks `GET /auth/status` once, so an expired login shows the sign-in.
- **Hidden tabs.** A hidden tab unsubscribes the sampled topics (`session.requests`, `session.models`, `connections.problems`, `runtime.updates`) at once, so the server stops reading the screen for it; `state` and `inbox` keep coming. A hidden tab sends no REST request: the fallback polling and one-time reads wait until it is visible. After five minutes hidden, or on `pagehide`, the socket closes and reconnects when the tab is visible again.

## Owner inbox

`server/features/inbox/` merges what waits for the owner into one read-only list: the request broker's open native requests of running sessions (`listAll()`, without the side effects of the per-session list), pipeline runs in `awaiting-human`, agent actions in `awaiting_approval` and team proposals. `OwnerInbox` recomputes the list when a source announces a change (broker events, pipeline `onChange`, agent `change` events) and on a timer while an event stream is open, raises its revision only when the waiting set changed, and pushes counts and revision on `/api/inbox/events` and the whole list on the owner-only live `inbox` topic (`server/features/inbox/live-topics.js`). Answers never go through the inbox; the page reuses each source's card and endpoint. Stale item addresses are resolved from the audit log for 24 hours. See [inbox](inbox.md).

## Persistence and safety boundaries

The configured data directory is private to the host user. Temporary application fixtures use their own home, data directory and tmux socket. Same-origin request checks protect browser mutations; untrusted archive, path and configuration inputs pass explicit feature boundaries. Profile separation is configuration isolation, not an operating-system sandbox: native CLIs still run with the host user's file permissions. A session may opt in to nono confinement instead: `server/features/nono/` owns detection, sandbox-profile listing and the adapter that composes `nono wrap` around the CLI, and every other launch adapter declares the grants that confinement needs by appending to the launch description's own grant list. That confinement is partial by construction; see the [sandboxing guide](sandbox.md) for the grant model and its known limitations.

Codex is the exception: it runs inside its own sandbox and defaults to `read-only`, which silently discards additional writable roots. A session that grants the per-session chat attachment directory through `--add-dir` therefore also pins `sandbox_mode="workspace-write"`, so the grant is real rather than merely requested. The YOLO launch mode already runs without a sandbox and is left as the operator chose it.

Managed Codex accounts pin `cli_auth_credentials_store` and `mcp_oauth_credentials_store` to `"file"`. Account creation seeds both in the account's `CODEX_HOME/config.toml`, every managed launch repairs them there, and every Codex process of a managed account (sessions, logins, status probes, history and plugin commands) also passes both as `-c` overrides, which outrank a trusted project's `.codex/config.toml`. The owner's local `~/.codex` stays unchanged. Codex's default store prefers the macOS keychain, whose entries are not scoped by `CODEX_HOME`, so ChatGPT logins and MCP OAuth tokens of managed accounts now stay inside the account profile. An MCP OAuth login that a managed account stored in the keychain before this pin must be repeated once in that account. The old keychain entry (service `Codex MCP Credentials`) stays usable only by the owner's local Codex, which may then use another account's token for the same server; remove it in Keychain Access or with `codex mcp logout <name>` in the owner's profile.

External top-level navigation is allowed only for known HTML routes with `GET`, navigation mode and document destination. WebKit's tested click navigation omitted `Sec-Fetch-User`, so that optional activation signal is not a prerequisite for opening the application. Cross-site API/subresource/frame access and mutations retain their checks. See the [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/); the browser suite verifies the observed behavior in Chromium and WebKit.

Reuse shared path/configuration and shell/TOML serializers rather than adding ad hoc quoting or prefix checks. Never put credentials into process arguments, URLs, public metadata or logs. Preserve structured native configuration when adding temporary integrations.

## Verification

`npm run check` combines lint, formatting, file size, backend strategies and production build. Browser tests run against an isolated application by default. Property failures record reproducible seeds and shrink their examples. Platform and browser CI matrices are defined in `.github/workflows/verify.yml` (pull requests and merge queue), `webkit.yml` (WebKit: nightly and labelled pull requests) and `full.yml` (nightly and release); a configured matrix is not evidence that an unexecuted platform passed. See [testing](testing.md) for commands, fixture ownership and the limits of native compatibility checks.

### Project and session SSH accesses

`server/features/ssh/` owns reusable keys, pinned hosts, project bindings and explicit session grants. Project identity resolves Git worktrees through their common repository and ordinary directories through their canonical filesystem identity. The session separately persists the launch directory's path, device and inode; each project operation revalidates that binding. Shell `cd` cannot switch authority. Effective hosts are the current union of inherited project hosts and explicit assignments, so existing sessions see project changes without copying grants. This is API convenience scoping under one OS user, not an OS sandbox.

One application-owned SSH management service serializes metadata mutations through a private local RPC socket and the application mutation barrier. UI and MCP share this service. A versioned `ssh/catalog.json` atomically publishes keys, hosts, projects and persistent mutation receipts. Key validation/generation prepares isolated files before publication; rollback and startup recovery remove proven unpublished artifacts. Receipts bind project, operation and request ID to current resources. Deletion and reassignment tombstone all affected receipts, preventing replay from recreating data. New growth is limited to 16 MiB without evicting receipts or blocking deletion.

Startup migration preserves legacy resource IDs and explicit grants with global ownership. A durable cutover marker coordinates initial capability revocation, catalog publication and archival of the old active JSON files. The first migration requires CLI reload; ordinary service restarts preserve compatible capabilities. Old and new writers cannot share a data directory, and installations using this format cannot downgrade to releases without unified-catalog support. SSH files, catalog receipts and grants remain excluded from application backups.

Session MCP exposes project key generation, bounded local-path import, public-key discovery, unverified host scanning, independently pinned host registration and connection tests, alongside host listing and execution. Import preserves the source and returns only public metadata; encrypted keys and managed identity sources are rejected. Existing authorized SSH access or a provider workflow supplies bootstrap access. Scanning is not verification, and AgentPier does not install remote authorized keys automatically. Editing, deletion and reassignment remain owner UI operations. Ordinary HTTP results and all MCP results contain public metadata; a separate authenticated owner POST downloads an unencrypted private key from an already-open validated descriptor.

Each SSH invocation captures one endpoint, username, identity and pin revision with an execution-specific known-hosts file. MCP checks effective grants and the revision before spawn and during execution. `server/ssh.mjs` resolves the same effective access for the manual helper; already-started manual connections may continue after revocation. Codex/Claude startup hooks and the OpenCode context plugin compose SSH discovery with Memory, AgentBus and existing user configuration, including zero-host projects. Login/headless sessions remain excluded; shell sessions receive manual access without a model hint. See [SSH accesses](ssh-access.md) for provisioning, reload and storage details.

Agents reach SSH through the `agentpier_ssh` tool of the `agentpier-teams` plugin, not the session MCP server. The loopback team bridge binds the call to the agent's ledger attempt (or, without one, to a bound routine's run session) and hands it to `AgentSsh` (`server/features/assistants/agent-ssh.js`), which runs the command in the AgentPier process through `SshAccessStore.connection()` and `ssh-run.js`. Grants live in `assistant_access.body.sshAccesses`; approvals and trusted runs are `assistant_actions` rows; `SshManagement.removeHost` revokes agent grants before the catalog changes.

Email grants live in `assistant_access.body.mailAccesses` as `{ accountId, level: "read" | "send", recipients }` (`server/features/assistants/mail/agent-mail-grants.js`). Only the owner's own agents and permanent team members hold them; user agents, temporary members and agents with their own Telegram bot for other people are refused on the server. `MailAccountStore.remove` revokes every agent's grant for the account before the catalog changes (`AssistantAccess.revokeMail`).

`server/features/mail/` owns the owner's IMAP/SMTP accounts and every mailbox operation: `MailAccountStore` keeps `mail/accounts.json` and one owner-only password file per account through `SshPasswordStore` (`mail/passwords/`), binds a saved password to the account's hosts, ports and security, and opens one `imapflow` connection or `nodemailer` transport per call with certificate validation and TLS 1.2 or newer (`mail-connection.js`, errors reduced to `MAIL_*` codes). The other modules list, read and search within fixed bounds, flag, move (MOVE only, never expunge), save drafts and compose messages; `mail-backup.js` seals the accounts into passphrase backups. `server/http/routes/mail.js` is the owner-only route. Agents reach mailboxes through the `agentpier_mail` tool of the `agentpier-teams` plugin: the team bridge hands the call to `AgentMail` (`server/features/assistants/mail/`), which checks the turn's origin class, the live grant and the recipient rules, and keeps sends that need the owner as `mail_send` rows in `assistant_actions`. The web side is `web/features/mail/` (Connections › Email accounts) and the Access tab's `MailAccess.jsx`, `MailGrantPage.jsx` and chat cards `MailApprovalCard.jsx` and `MailRunNote.jsx`. See [Email for agents](mail.md).

SFTP hosts are a second host type in the same catalog (`sftpHosts`, so a release without SFTP keeps its SSH list). `server/features/sftp/` holds the in-process `ssh2` client (host-key pinning, password or key sign-in, no `sshpass`), confined remote and local paths, transfer planning with a plan digest, and `SftpJobs`, the cancellable background jobs. Coding sessions reach them through the `sftp_*` tools of the SSH MCP server (`sftp-session-tools.js`), agents through the SFTP actions of `agentpier_ssh` (`agent-sftp*.js`: policy, runs, approval cards, grants and Telegram notices). Passwords are kept by `SshPasswordStore` under `ssh/passwords/`. See [SFTP access](sftp-access.md).

Agents hand the owner files through the same plugin's `agentpier_share_file` tool: the bridge binds it to the ledger attempt, a routine's or hook's run, or, for any other run of the owner's chat, to that chat (`owner-shares.js`), and hands it to `AgentShares` (`server/features/assistants/agent-shares.js`), which reads the file from the agent's workspace (`agent-share-source.js`), stores the copy outside the workspace (`agent-share-store.js`) and, for a Telegram turn, queues a `file` notice in the channel outbox. See [Files agents share](assistant-gateway.md#files-agents-share-2026-10-17).

## Agents (managed OpenClaw)

Agents are optional. While they are switched on, AgentPier supervises one pinned
OpenClaw Gateway per host as the same OS user and talks to it over authenticated
loopback WSS with a pinned certificate. The browser never reaches the Gateway
directly.

- `server/features/assistants/`: the runtime manifest, installation and update
  lifecycle (`runtime-*.js`), the supervisor (`runtime-supervisor.js`), the Gateway
  client, and the OpenClaw configuration compiler (`openclaw-config/`). The compiler
  writes locked paths and AgentPier-owned settings, plus only the allow-listed
  overrides from the advanced settings (`advanced-config.js`). The same directory
  holds agent profiles and conversations, capabilities and skills, shell approvals and
  the allowlist, teams (`team-*.js`, with the bundled `team-plugin/`), lead requests
  (`lead-request*.js`), agent SSH access (`agent-ssh*.js`), reminders, routines and check-ins (`native-*.js`) and chat
  attachments (`agent-attachments.js`, chunked videos in `agent-video-*.js`, the owner's
  usage, clear and verified folder removal in `agent-attachment-storage.js`).
- `server/features/assistant-channels/`: Telegram pairing, ingress, delivery and the
  durable outbox, and agents' own bots for other people (`telegram-senders.js`).
- `server/features/mcp-servers/`: the central MCP server store, bindings to agents and
  to the coding CLIs, and OAuth logins (see below).
- HTTP routes live in `server/http/routes/assistant*.js` and `mcp-*.js`.

See [the user guide](agents.md), [the Gateway design](assistant-gateway.md) and
[ADR 0002](adr/0002-managed-openclaw-assistants.md).

## Central MCP servers in the coding CLIs

`server/features/mcp-servers/` writes servers bound to Claude Code, Codex or OpenCode
into each CLI's native configuration before every session start and on every save. It
records the entries it wrote by name and SHA-256 hash, changes only entries that still
match, and offers entries found in the CLIs for adoption. See
[MCP](mcp.md#central-mcp-servers-in-the-coding-clis).

## Artifacts

`server/features/artifacts/` stores private static pages published by sessions and
agents through the `artifact_publish` MCP tool and shows them in a sandboxed viewer
without scripts. See [artifacts](artifacts.md).

## Operations

`server/features/operations/` owns host backups (streamed format 2 in
`archive-v2.js`, format 1 still restorable, CLI profiles captured by allowlist),
restores with resumable uploads, diagnostics, and versioned releases with activation,
rollback, cleanup, session migration and the Stable and Preview channels. See
[backups](backups.md), [operations](operations.md) and
[release channels](release-channels.md).
