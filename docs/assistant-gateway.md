# Managed assistant Gateway design

For setup and everyday use, start with the [agents guide](agents.md).

Status: operating guide for the optional managed agent subsystem. Agents are off
until the owner turns them on; foundation, ChatGPT and provider accounts, Telegram
with Deepgram, visible teams, team coding requests, lead questions and tasks with
@-mentions, native memory, reminders, routines with the agent's tools, check-ins,
web, browser and document tools, MCP servers, shell access, skills, agents' own
Telegram bots, chat attachments and the advanced settings are implemented. Service
adapters (Gmail, Microsoft 365, Google Calendar, Apple) and a sandbox remain
deferred. Date: 2026-10-08, updated 2026-10-14.
Companion to [ADR 0002](adr/0002-managed-openclaw-assistants.md) and the
[status/recovery evidence](research/openclaw-status-recovery-spike.md).
Chronological qualification and spike logs live in `docs/research/`:
[team qualification and owner trials](research/openclaw-team-qualification-log.md)
and [native memory and automation spike](research/openclaw-native-memory-automation-spike.md).

## User-facing shape

Agent chats remain directly reachable in the sidebar, with team members nested
under their assigning assistant in two sections: permanent members (also promoted
ones) and temporary members grouped by team. A permanent member becomes a root agent
only when its lead is archived. The Agents directory manages profiles. Per-agent
settings configure instructions, models, service access and team permission.

Place shared service operation under **Agents › Runtime › Agent service** (formerly Settings › Workspace › Agents › Agent service). Call the main card **Agent service**; show OpenClaw as its managed runtime, not another
application the user must administer. The card shows readiness, host, active work,
restart preparation and diagnostics. Central model/service connections remain in
AgentPier. Technical details such as protocol, pin and private state locations are
secondary, expandable information; credentials never appear there.

The private interactive study illustrates three states with synthetic data:
ready, reconnecting, and reachable after an interrupted task. Its controls simulate
UI behavior only. DE/EN copy is included; publication does not deploy a service.

![Synthetic assistant runtime settings study](adr/assets/0002-gateway.png)

## Runtime boundary

```mermaid
flowchart TB
  UI[AgentPier chats and settings] --> API[Assistant API]
  API --> Ledger[Request ledger and identity mappings]
  API --> Adapter[Gateway adapter and state reconciliation]
  Supervisor[AgentPier process supervisor] --> OC[One native OpenClaw Gateway]
  Adapter <-->|Authenticated loopback WSS, pinned certificate| OC
  Profiles[Assistant profiles and conversations] --- OC
  Telegram[Telegram] <--> Channels[AgentPier channel workers and durable inbox]
  Channels --> API
  Channels --> STT[Central Deepgram connection]
  OC --> Models[Central model connections]
  OC --> Services[Google / M365 / Apple adapters]
  OC --> Bridge[AgentPier tools for profiles and coding work]
  Bridge --> API
```

AgentPier owns process lifecycle, user authorization, central connection references,
request identities and its UI projection. OpenClaw owns its agent loop, session
internals and model/tool execution. AgentPier owns Telegram transport and speech
transcription. The browser talks only to the
AgentPier backend. No iframe of the upstream dashboard is needed.

One Gateway hosts several assistant profiles and their conversations. A separate
Gateway is a future deployment choice for independent lifecycle/configuration; it
does not automatically form a team with the first instance. Multiple profiles or
processes on the same native host are not an OS sandbox.

## Opt-in switch

Agents are off by default. **Agents › Runtime › Function** (and the **Enable agents** page shown while agents are off) carries the single switch
("Enable agents"). While it is off the subsystem is dormant: AgentPier creates no `assistants/`
folder or database, starts no Gateway, poller, scheduler or background loop, installs
or downloads nothing, and shows no agent navigation or account sections. Turning it
on provisions the runtime and starts the service. The choice is stored in
`assistant-feature.json` in the data directory. Installations from before the switch
migrate to enabled when they already ran the runtime or hold a stored agent, so
existing users keep their agents. An unsafe `assistants/` folder (a link, a file, or
another owner) reports `ASSISTANT_STORAGE_UNSAFE` and is never followed or created
over.

## Starting and operating the service

1. Provision the tested package and compatible Node runtime through installation
   and update paths. Keep the runtime pin distinct from AgentPier's own Node support.
2. Allocate private state/config/workspace/log locations, a loopback listener and
   backend-only credentials. Launch an owned foreground child with a narrow env.
3. Wait for authenticated readiness. An open port or live PID alone is insufficient.
   The wait is a wall-clock budget: at least 90 s, or three times the previous
   spawn-to-ready time when that was longer, because a restart also loads the agents
   and sessions created since the first start. A Gateway that exits ends it at once.
4. Reconnect subscriptions and reconcile profile/session/run identities before
   presenting current status. Serve stored history while reconciliation is pending.
5. On unexpected exit, restart with bounded backoff. Preserve state, identify
   interrupted work and expose unresolved outcomes instead of replaying everything.
6. For a planned restart, pause new admission and let current work finish. Coordinate
   Gateway and channel ingress, not just AgentPier's HTTP queue. If work cannot drain
   in time, show the outstanding work and a separate explicit cancellation choice.
7. Keep updates explicit, with compatibility checks and backups. Rolling back a
   package does not necessarily reverse a state migration.

The supervisor, authenticated readiness, bounded restarts and the maintenance gate
are implemented (see below and [runtime updates](assistant-runtime-updates.md)).
Native crash behavior on hosts beyond the qualified ones remains a release gate.

### Gateway transport and authentication

Transport: loopback TCP with TLS and a pinned certificate, `wss://127.0.0.1:<port>`.
AgentPier probes for a free loopback port. Another local process can still take that
port before OpenClaw binds it, so the shared gateway token must reach only our own
Gateway. OpenClaw 2026.9.8 has no way for the server to prove it knows the token
during the challenge: its `connect.challenge` carries only a server nonce. It also
cannot listen on an inherited socket descriptor or a Unix domain socket: it only
calls `listen(port, host)`. It does support `gateway.tls`, so AgentPier uses that:

- On every start, AgentPier issues a fresh self-signed ECDSA P-256 certificate,
  valid for one year, in `assistants/tls/` (folder 0700, files 0600). AgentPier writes the DER encoding
  itself, so no `openssl` binary is needed. The config sets `gateway.tls.enabled`
  with these `certPath`/`keyPath` values and `autoGenerate: false`.
- For every connection, the client reads the certificate file from that private
  folder and trusts only that certificate. It also checks that the certificate's
  SHA-256 fingerprint matches. Any other certificate is rejected, even one a public
  CA would accept, and so is plain TCP or `ws://`. The pin is never learned from
  the network. A regenerated certificate takes effect on the next connection.
- The token is sent in `connect` only after the pinned TLS handshake has succeeded.
  If an impostor holds the port, the attempt fails with `ENDPOINT_UNTRUSTED`. The
  port is drawn free and then released, so another listener can take it before the
  Gateway binds it. The same start therefore stops the child and launches again on
  a fresh port, up to three ports. It does the same when the Gateway exits while
  starting and the port is still held by someone else (its bind failed), even if
  that listener never answered. Only then does the start fail, and a restart on a
  fresh port follows the crash backoff; the retries within a start use none of its
  five attempts. Any
  failure after the TCP connection and before the TLS handshake completes counts as
  `ENDPOINT_UNTRUSTED`; a refused connection while the Gateway is still starting is
  retried.

The Gateway serves no browser surface: every start rewrites
`gateway.controlUi.enabled` and `gateway.terminal.enabled` to `false`, also over
values an existing configuration holds. OpenClaw enables the operator terminal by
default; it gives admin-scoped clients a host shell with the Gateway's environment.

### Process ownership and supervision

`assistants/owner.json` records the Gateway's pid, its process start time, the
real path of the runtime's Node executable and the entry path. Before a new start,
the record is checked:

- **Dead pid, or pid reused:** the pid is gone, or now belongs to a process with
  another start time. The record is removed.
- **Our own orphan:** same start time and executable, and argv contains the entry
  path or OpenClaw's own process title (`openclaw-gateway`). AgentPier sends
  SIGTERM, then SIGKILL after 3 s, and then starts. This happens, for example,
  after AgentPier died under systemd's `KillMode=process`, which is kept so that
  tmux sessions survive service restarts.
- **Anything else** (another identity, EPERM, or an old record without identity):
  `OWNERSHIP_CONFLICT`. Nothing is signalled.

An `owner.json` written by an earlier AgentPier version has no `startTime`, so a
live pid in it always ends in `OWNERSHIP_CONFLICT`. Resolve it by hand once: check
the pid from the file (`ps -p <pid> -o pid,command`). If it is a leftover
`openclaw-gateway` from this data directory, stop it (`kill <pid>`); if it is an
unrelated process, leave it running. Then delete `assistants/owner.json` and start
the service under Agents › Runtime › Agent service. The next start writes a
complete record.

Executable evidence reuses the release-cleanup process checks: `/proc/<pid>/exe`
on Linux, and on macOS `ps` or, for a titled process, its mapped image via `lsof`.

A stop gives the Gateway a drain window of up to 60 s (`gatewayDrainMs` in
`runtime-supervisor.js`) after SIGTERM before SIGKILL: OpenClaw stops admitting work
and lets running turns and cron runs finish, and it exits by itself once drained.
The readiness budget of the next start counts from its spawn, so a drain never
shortens it. AgentPier's own shutdown keeps the 3 s grace, within the service
manager's stop timeout (`TimeoutStopSec=10`), and cuts a drain already in progress
short; the next start reclaims anything left. After that shutdown the supervisor
refuses every start (`RUNTIME_CLOSED`), and a maintenance restart that was draining
does not start the Gateway again, so no Gateway outlives AgentPier. A failed start, an attempt or member
recovery and a lost cron acknowledgement stop with the short grace as well.

A maintenance restart (provider changes, a [pending restart](#pending-restart), web
tools) enters maintenance first: admission closes and cron is switched off
(`cron.enabled: false`, confirmed through `cron.status`). Only then does it check for
busy work, and once more right before the stop, so a run the scheduler started just
as it was switched off is seen as well. A busy check refuses and leaving maintenance
restores cron.

If the connection is lost and five reconnects (1–16 s apart) fail, the still-running
process is restarted. Process exits and failed automatic starts retry at most five
times with exponential backoff. After that the service stays `failed` with
diagnostic `RESTART_LIMIT` until the owner starts or restarts it, which grants a
fresh retry budget.

`assistants/logs/gateway-console.log` is opened with mode 0600, and an existing
file is tightened to 0600. It is rotated at 10 MiB, keeping three files: the active
log plus `.1` and `.2`. Rotation is checked at start and every minute. OpenClaw's
own log runs at level `warn` and rotates at 10 MiB. Diagnostics flags, OTEL export
with content capture, and cache traces are switched off, so prompts are not
logged.

## Installation and update lifecycle

Installation and updates are managed product capabilities. The transactional update
workflow below is implemented for one Gateway instance (see
[runtime updates](assistant-runtime-updates.md)); independent Gateway instances are
not implemented.

The deployment unit is a Gateway instance. One instance initially serves multiple
agent profiles; adding a team member does not install another OpenClaw package.
If independent Gateways are added later, each needs a stable instance identity,
private configuration/state/workspaces/authentication, an owned process and port,
and its own active runtime selection. Verified runtime packages may be reused on
the same host; mutable state must not be shared between instances. Profiles on one
Gateway necessarily share its runtime version and update window.

The update workflow extends the current pinned installer:

1. Stage the AgentPier-qualified OpenClaw/Node combination separately from the active
   runtime. Verify package integrity and the dependency graph, platform support and
   required Gateway contracts. A failed download or validation must leave the active
   selection intact. Do not run an upstream self-updater against managed files.
2. Show current and target versions, affected assistants and blocking work under Agents › Runtime › OpenClaw updates. Activation is explicit; downloading a candidate must not
   implicitly migrate live state. Include enabled existing installations in the
   normal AgentPier update path, not a developer-only setup command.
3. Enter maintenance: gate new execution, coordinate Telegram/transcription/delivery
   workers, drain running work and stop the owned Gateway. Pending/uncertain effects
   must remain recorded; a timeout does not authorize cancellation or replay.
4. Take a consistent private backup of the affected Gateway state and corresponding
   AgentPier assistant/channel ledgers, including database journals and version/schema
   metadata. Preserve host-scoped credentials securely; never expose backup contents
   in diagnostic output. Define a restore boundary that excludes unrelated coding
   sessions and central account changes.
5. Activate the candidate, validate authenticated readiness, reconcile profiles,
   history and pending work, then resume admission. Persist each transition so an
   interrupted AgentPier process can recover deterministically.
6. On failure before resuming work, restore the previous compatible runtime and
   matching state snapshot when a tested restore path exists. If migrations cannot
   be safely reversed, remain stopped with a recovery explanation. Restoring only an
   old executable is insufficient. After work has resumed, downgrade is a separate
   recovery operation: restoring stale ledgers could replay real external effects.

Acceptance tests must cover fresh installs, enabled-installation upgrades, interrupted
staging/activation, rejected migrations, occupied ports, insufficient disk space,
concurrent update requests and restoration of the previous runtime/state pair.
Qualify supported macOS/Linux architectures on native hosts. Keep old runtime
packages and backups while referenced by an instance or a recovery operation;
cleanup must never delete assistant history as a side effect of uninstalling a
runtime. The product UI should expose progress, blockers and recovery actions.

The installer verifies pinned Node/npm/OpenClaw archives and a reviewed transitive
dependency lock, checks the installed package version/CLI, and preserves selection
on installation failure. Existing installations retain their selection until
explicit activation through the maintenance, snapshot and transactional update
flow. See [locked installation and transactional updates](assistant-runtime-updates.md)
for the implementation and remaining native platform/version qualification.

## Security boundaries

- **Only owner turns and a routine's own run write natively.** The write guard
  covers every native file tool (`write`, `edit`, `apply_patch`). It admits the
  owner's own turn, an owner-proven member task (or one an autonomous lead or a routine
  the owner marked **May write** started) and, as a deliberate widening of the
  owner-only rule, the run of a routine the owner configured for that agent
  (`TeamBridge.routineWrite`, see [workflows](assistant-workflows.md)). A turn that is
  forwarded, internal, made by a team member without owner proof, or a reminder or
  check-in run, cannot change files, and no turn but the owner's changes memory
  settings, reminders or routines. Forwarded Telegram text, voice or files are
  quoted data, never authority. Plain-language team requests follow the rule in
  [Visible teams](#visible-teams-operation-and-recovery).
- **Bootstrap and skills protection.** The files OpenClaw loads into every prompt
  (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`,
  `BOOTSTRAP.md`) cannot be rewritten by native tools; AgentPier owns `AGENTS.md` and
  the owner edits `USER.md` through the settings. The check folds case, Unicode
  normalization and OpenClaw's path repairs, so alternative spellings are caught.
  Skills are off unless the owner assigns them: `agents.defaults.skills` is `[]`
  (no skills for an agent without its own list), each eligible agent's
  `agents.entries.<id>.skills` holds only the bundled skills the owner switched on
  (see [Skills](#skills)), and autonomous skill review is off. `skills.allowBundled`
  is not a gate: OpenClaw reads the empty list AgentPier writes as "every bundled
  skill allowed".
- **`.agentpier/` is managed by AgentPier.** The folder holds the agent's granted
  secrets (`.agentpier/secrets.env`). No native file tool writes, edits, adds, moves
  or deletes anything below it in any turn, the owner's included; the refusal reads `Files in .agentpier are managed by AgentPier.` The
  check folds case like the bootstrap check and follows symbolic links and hard links
  into the folder (`team-plugin/managed-folder.js`). The agent may still `read` the
  file; OpenClaw 2026.10.7 masks the values as `***` in that result, so the agent loads
  them through the shell. AgentPier's own transfers keep away from the folder as well: an SFTP download
  never writes there, an SFTP upload or a browser upload never reads from it, and
  `agentpier_share_file` refuses its files. Shell commands are not covered: an agent
  with a shell can change or delete the file, and AgentPier writes it again before
  the agent's next turn. Proven on 2026.10.7 by
  `assistant-secrets-guard-contract.test.js`. A hook run without the hook's
  **Secrets** switch never reads the file: with a shell, coding or MCP it runs while
  the file is removed; otherwise `team-plugin/secrets-guard.js` refuses its file-tool
  reads below `.agentpier/` (every spelling, `file:` URLs and links included), and
  only its session's ([agent hooks](assistant-workflows.md#agent-hooks)).
- **Every file tool is guarded.** The guard's hook matches `write`, `edit` and
  `apply_patch`, every file-changing tool of OpenClaw's fs section. OpenClaw grants
  `apply_patch` wherever `write` is allowed, and hook matchers compare exact tool
  ids, so `apply_patch` must be named: until it was, a forwarded or otherwise
  unproven turn could add, change or delete workspace files and patch `AGENTS.md`
  (proven against 2026.9.9 by `assistant-write-guard-contract.test.js`, which also
  passes on 2026.10.3). A patch is
  checked on every path a hunk header names (`Add`, `Update`, `Delete`, `Move to`),
  and one refused path, or no recognizable hunk, refuses the whole patch.
  `tests/unit/assistant-write-guard-coverage.test.js` fails when AgentPier grants a
  tool that is neither read-only, guarded nor a shell tool.
- **Write guard handshake.** The bundled `agentpier-teams` plugin registers the tool
  guard inside the Gateway and reports it to AgentPier, bound to the runtime
  generation. The report is dropped on reconnect and repeated periodically (at the
  latest every 15 s). Until a current report exists, agents with memory access stay
  read-only and the status shows `WRITE_GUARD_PENDING`. Reports from a retired plugin
  registry are ignored. Every start compiles all agents without `write` and `edit`;
  once the guard is reported for the current generation and the Gateway is ready
  (whichever comes last), AgentPier re-applies every active agent with memory access
  (`WriteGuardReapply`): a hot `config.patch` per agent, each admitted on its own so
  chat turns interleave, with no restart and no interrupted turn. Agents whose model
  connection is blocked are skipped. Scheduled routines fire inside the Gateway
  without an apply of their own, so without this pass only agents that had a chat
  turn, a settings save or a **Run once** since the start could write. The pass keeps
  its generation open until every agent applied: a reconnect that drops the guard, a
  failed apply or a refused admission stops it, and the next guard report or
  readiness resumes with the remaining agents (one attempt per agent each time; a
  failure is warned once per generation). Once complete, periodic reports of the
  same generation apply nothing. A routine that fires in the seconds between
  readiness and the pass still runs read-only; overdue jobs are deferred 120 s after
  a start (see [routine qualification](assistant-routine-qualification.md)) and are
  not affected.
- **Project folders go through AgentPier, not native file tools.** Native `read`,
  `write` and `edit` keep `tools.fs.workspaceOnly`; with it off, OpenClaw would also
  read any host file for outgoing media. Granted project folders are served by
  `agentpier_workspace` file actions over the team bridge, resolved inside the folder
  on every call (`project-paths.js`: real path, no links out, no `..`, `.git` and
  AgentPier's data dir locked, case-folded), changed only with the proven guard and
  audited with path and size ([folder access](assistant-workflows.md#direct-folder-access)).
  A routine run reads them and changes them only when the owner marked that routine
  **May write**. A browser upload from them goes through a copy AgentPier stages for
  that agent's browser alone ([browser uploads](#browser-uploads)).
- **The hook endpoint is a machine path.** `POST /hooks/<hookId>`
  ([agent hooks](assistant-workflows.md#agent-hooks)) is served on AgentPier's own
  port, mounted after the MCP machine path and before `authorizeRequest`, with its
  own transport check (`authorizeHookTransport` in `server/http/hook-endpoint.js`).
  It accepts three host branches: loopback on the local host without proxy markers,
  the Tailscale Serve host (no Tailscale identity required, tagged nodes send none)
  and, only while network mode is on, a network-mode host without `Tailscale-*`
  headers. It refuses (403) any `Tailscale-Funnel-Request`, `Origin` or
  `Sec-Fetch-Site` header, so neither Funnel nor a browser page reaches it, and any
  `token` query parameter. The sender authenticates with
  `Authorization: Bearer <secret>` (scheme in any case); AgentPier stores only the secret's SHA-256 and
  compares digests in constant time. Ten failed attempts in ten minutes answer
  `429 HOOK_RATE_LIMITED` with `Retry-After` until the window ends. The source is
  `local`, the first `X-Forwarded-For` entry on the Tailscale branch, or the socket
  address in network mode; every Tailscale-branch failure also counts against one
  shared tailnet window, because a local process can forge `X-Forwarded-For`. A
  wrong or missing secret (401) counts only for that hook from that source, so a
  sender that still uses the old secret after **Regenerate secret** blocks no other
  hook and no other source; while that hook's window is full, its right secret from
  the same source answers 429 as well, because the window is checked before the
  secret. A 404 for a well-formed hook ID (a scan) counts for the whole source and
  blocks every hook from it. At most 1000 windows are kept, and the least recently
  failed one is evicted first (never a local or shared tailnet window). In front of
  every check, a request ceiling of 600 requests per minute per stored hook (and one
  shared window for unknown IDs and other `/hooks` paths) answers
  `429 HOOK_RATE_LIMITED` with `Retry-After` as well. Unknown,
  disabled and ineligible hooks answer the same
  `404 HOOK_NOT_FOUND`. Bodies are JSON or `text/plain` (else `415`), at most
  64 KiB (else `413`), and must arrive within 15 s; only the event-ID headers reach
  the delivery, and the audit records hook, outcome, branch, size and (once
  delivered) the event ID, never payload, headers or secret. A `503` (runtime not ready) carries
  `Retry-After: 30`.
- **Hook runs are qualified on OpenClaw 2026.10.7.** The native contract
  `tests/integration/assistant-hook-contract.test.js` (opt-in with
  `AGENTPIER_ASSISTANT_ROUTINE_RUNTIME`) delivers an event to the pinned Gateway: the
  disabled job is created and forced, the run's tool calls carry
  `agent:<agent>:cron:<job>:run:<id>` and resolve to the event through
  `AgentHooks.runOrigin`, the run is offered `toolsAllow` intersected with the agent's
  tools (OpenClaw adds `apply_patch` beside `write`; the write guard refuses it in a
  hook run) and never scheduling, hook or team tools, the completion arrives on
  `/hook-complete/<event>` with `deliveryStatus: "delivered"`, the reply appears once
  in the main chat's `chat.history`, the job is removed and `openclaw.json` holds no
  `hooks`. OpenClaw keeps the hook prompt out of the main chat's transcript (only the
  reply is committed), and AgentPier's chat view never shows the prompt or payload. A
  background command the run started exits after the event settled without
  starting a completion turn: the cron run session keeps no transcript, and the
  bridge would refuse any shell call of such a turn (`hookLockedTool`). A hook run
  without **Secrets**, shell, coding or MCP gets the secrets refusal for its `read` of
  `.agentpier/secrets.env` while the file stays in place; a hook with **Secrets**
  reads it (values masked).
- **Approvals are audited.** Every approval, decline and withdrawal of an action
  (memory change, coding start, member coding request) is recorded with its actor,
  source and outcome.
- Profiles on one native host are not an OS sandbox; see ADR 0002 section 8.

## Status model

| Layer           | Examples                                                   | Meaning                                                               |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Service         | starting, ready, reconnecting, stopped, failed             | Whether the managed runtime is reachable and usable                   |
| Reconciliation  | current, checking, uncertain                               | Whether displayed task data has been refreshed from the runtime       |
| Run             | queued, running, succeeded, failed, cancelled, interrupted | Outcome of a particular execution attempt                             |
| Action/delivery | pending, confirmed, failed, uncertain                      | Whether a requested external effect actually occurred                 |
| Agent activity  | idle, working, waiting, attention                          | Derived per agent for the sidebar dot, chat header and approval count |

Agent activity is derived on every `GET /api/assistants` from the latest request per
conversation, pending approvals and team state (`assistant-activity.js`); it is never
stored. First match wins: an agent the running Gateway refused
([degraded](#degraded-agents-agentpier-238)), an unreviewed `uncertain` or
`interrupted` attempt, or a member in `uncertain` / `provisioning_uncertain`, needs
**attention**; any pending
approval (own actions, team coding requests, team proposals) means **waiting**; an
unreviewed `pending` / `accepted` / `running` or unconfirmed attempt, a working or queued member, or an
active own team means **working**; everything else, including a `failed` last attempt,
is **idle**. `pendingApprovals` carries the count shown in the chat. Every `change`
event recomputes the list, so a runtime failure publishes `change` after marking
outstanding attempts uncertain; the browser receives the result as a diff (see
[Live agent list](#live-agent-list)).

**Queued owner message.** While a conversation has an unresolved attempt, the owner's
next message waits in `queued_messages` (one row per conversation,
`queued-messages.js`): `POST /api/assistant-conversations/:id/queued` starts or extends
it (text joined on a new line, at most 65,536 characters and five staged files, a new
delivery key per change; a repeated `appendId` changes nothing; a `failed` message or
an archived agent refuses with 409), the history payload carries it as `queued` for
every tab, and `DELETE …/queued` hands it back unless its dispatch began (409), with
its files' staging time restarted. Both routes, like `…/messages`, take JSON bodies up
to 256 KB, so a full-length message in any script fits. After every reconcile pass,
and on the 2-second poll while rows wait, `dispatchQueued` (`queued-dispatch.js`)
claims each waiting row of an idle conversation (no unreviewed pending, uncertain or
interrupted attempt, a ready service, an agent that is not archived) as `sending` and
delivers it through the normal owner send, whose ledger dedupes the delivery key. A
row whose key the ledger already knows counts as delivered and is dropped, also at
startup, so a later append never sends the old text again. A 409, 503 or other server
fault returns it to `waiting` with a per-conversation backoff from 2 to 30 seconds and
publishes no `change`; a backoff behind other turns ends when they do. After ten tries
or ten minutes of retries the row is marked `retrying` (one `change`), and the card
says so while retries continue every 30 seconds. A refusal of the message itself keeps
it as `failed` with the problem text (unexpected errors show only the generic internal
error). A row that has been deliverable for more than a day (`deliverable_since`; the
clock stops while another turn runs, a 409 refusal names one, or the agent is
archived; 5xx faults and an unready service keep it running, so a host that stays down
or is restored lets the message expire) turns `failed` instead of being sent late. Its staged files are
excluded from expiry, the staging cap and removal until the message claims them or is
taken back.

Keep session keys and run IDs separate. A session can be reused for several runs;
even the same run ID can appear when an interrupted request is retried in the tested
runtime. Record AgentPier attempt and action identities separately from runtime IDs.
Do not infer completion from text arriving, a wait timeout, or a diagnostic line.
Use terminal evidence and read back the session when events were missed.

A reconnect may safely reconcile a completed turn without executing it again.
A process crash may leave external effects uncertain. Before retrying, consult the
durable action record and the destination service; surface uncertainty when neither
can establish what happened. This does not change the agreed team autonomy default.

## Creating a permanent colleague

An assistant requests a scoped AgentPier tool operation containing the intended
role, task, lifetime and selected configuration. AgentPier checks authorization and
limits, allocates its durable identity, then calls the appropriate Gateway API.

- Existing profile, new persistent chat: delegate with `sessions_spawn` and
  `visible: true`, retaining parent/task mappings.
- New durable profile: call backend `agents.create`, apply selected settings and
  references, then start its conversation. Do not turn every transient task into a
  profile or grant the model unrestricted configuration-write credentials.

Default autonomous team creation asks first; standing permission is configurable
per assistant, and an explicit team instruction (also in plain words) authorizes
that assignment. Task-bound members can be promoted to permanent colleagues from their settings; a
tool that lets a model provision a brand-new permanent profile on its own is not
implemented.

## First implementation boundary

The build order was supervision, profile/conversation mapping, direct chat and
status reconciliation, then Telegram/Deepgram, teams, memory/reminders and
workflows. Service adapters need their own connection, delivery and recovery tests.
Sandbox design stays deferred as agreed. Remaining release checks are tracked in Plane.

## Implemented foundation

The foundation now provisions OpenClaw 2026.10.7 with Node 26.12.1 in private
application data, starts one owned foreground Gateway, and waits for authenticated
protocol readiness. It is optional: enabling it under Agents › Runtime provisions
the runtime; enabled installations provision the selected version at startup after
an AgentPier update. Installation failures preserve the previous runtime selection.
The current platform probes cover macOS arm64; the manifest also pins macOS x64
and Linux arm64/x64 packages, which still require native-host qualification.

**Agent roster shape.** OpenClaw 2026.10.3 refuses to start (exit code 78,
`INVALID_CONFIG`) with an `agents.list` array or a boolean `default` marker on an
agent entry; 2026.9.x only warned. A fresh configuration therefore writes
`agents.entries: { main: {} }`, and every compile converts a legacy list into keyed
`agents.entries` (`canonicalAgentRoster()` in `runtime-config.js`). A roster of two
or more agents gets `agents.ownership: "explicit"`, and `agents.defaults.systemAgent`
and `talk` point at the former default agent. 2026.9.8, 2026.9.9 and 2026.10.3 all
accept the converted shape.

AgentPier stores assistant definitions, configuration revisions, conversations,
request identities and execution attempts in its assistant database. OpenClaw owns
its profiles and transcripts. Direct sidebar chats and per-assistant settings use
these mappings. Central API-key connections (OpenRouter, Ollama, llama.cpp, generic and Azure
OpenAI-compatible endpoints; see [model connections](assistant-model-connections.md))
and native ChatGPT OAuth profiles are selectable. Revoked keys are checked
before dispatch. Provider credentials exist only in backend private runtime files,
not public assistant definitions.

The chat/settings UI now follows the approved visual structure: shared assistant
header, direct Conversation/Settings navigation, message cards and a runtime summary
beside individual settings. A sidebar assistant without an existing chat opens its
conversation directly. Delayed chat opening cannot override a newer navigation;
drafts survive view changes. Desktop and mobile browser coverage includes the
composer remaining inside the viewport.

Normal stop/restart rejects outstanding work. Unknown-outcome recovery is a
separate deliberate chat action: review the history, acknowledge uncertainty, stop
the owned process, record that review, then restart. This does not declare the
original request successful or undo previous effects. The record retains its
unknown outcome and can accept later terminal evidence. No recovery path resends
the request automatically; a manually repeated message gets a new delivery ID.

A restricted user reviews her own turns of unknown outcome in her app; the owner
cannot see her chat. So that a turn she never reviews cannot block the owner for good,
a Gateway stop or restart, a runtime update, a provider change, an account logout and
a team member recovery first settle every user's turn of unknown outcome: its run is
aborted in her session and the attempt is marked reviewed (`settleUserTurns`,
`attempt-recovery.js`). The owner's own unknown turns still need his review.

**Unconfirmed sends.** A busy Gateway may run a turn whose `sessions.send`
acknowledgement times out (the client's default 10 s, so the admission lock is never
held longer). Such an attempt becomes `uncertain` but stays _unconfirmed_ (evidence
`unconfirmed: "send"` with the supervisor's per-launch `generationId`,
`run-confirmation.js`); a send the closed connection refused at once does not.
Without proof it gets no AgentPier tools and no native writes. Any Gateway event of
its run (run ID = attempt ID), an `agentpier_workspace` or `agentpier_share_file`
call of that run (the plugin names the run of its tool call; `TeamBridge.prepare`
confirms before it binds the call) or its own user message in the transcript
(delivery key `<attempt ID>:user`) moves it to `running` on that same Gateway launch,
so the turn's
tools work, team member and lead request phases return to `running`, and it
completes normally. A Gateway restart, a review, or uncertainty from any other cause
is never confirmed this way, and an AgentPier start turns leftover unconfirmed
attempts into plain `uncertain` ones. Agent activity counts an unconfirmed turn as
working ("Awaiting confirmation"). The chat shows the same calm note and offers the
restart-and-acknowledge action only once the run has been quiet for two minutes,
counted on the browser's clock from when the chat first saw the turn waiting or from
its latest output.

**Refused sends.** Only a definite answer that the Gateway ran nothing ends a turn
at once: an agent it has not admitted (`admissionRefusal` in the answer, see below),
`UNAVAILABLE` with an explicit `retryable: false`, or `INVALID_REQUEST`. The attempt
becomes `failed` with `failure` `degraded`, `starting` or `refused`
(`sendRefusal`, `conversation-turns.js`), and the chat says that the message was not
delivered. A timeout, a lost connection or any other answer stays `uncertain`. The
attempt evidence records the error code in both cases, and a refusal is logged with
its code only, never the message text.

### Degraded agents (AGENTPIER-238)

After an unclean stop (a stale database lease), OpenClaw 2026.10.7 inspects and
prepares some agent databases in the background once the Gateway answers.
Meanwhile `agents.list` reports such an agent `status: "degraded"` with an
`admissionRefusal` coded `agent-database-inspection-pending`. A runtime configuration
change during that preparation (`config.patch`, `agents.create`, `agents.update`)
supersedes it, and OpenClaw never retries it: the agent stays refused
(`agent-database-inspection-failed`) for the Gateway's lifetime, and its
`sessions.send`, `sessions.messages.subscribe` and history calls answer
`UNAVAILABLE`.

AgentPier therefore never writes the configuration while an agent is pending
(`agent-admission.js`). Every writer (`patchConfig` and `configWrite` in
`live-patch.js`, which `AssistantConfig.apply` uses for `agents.create` and
`agents.update` too) first waits, once per Gateway connection, until `agents.list`
lists no pending agent. A roster read the Gateway cannot answer yet (`UNAVAILABLE`, a
timeout) is asked again; a closed connection or a Gateway without this roster lets
the write through (a closed connection fails it there). The wait ends after 120 s without progress: each agent admitted meanwhile
starts the 120 s again, so a slow host with many agents is never cut short. Writes
that arrive meanwhile share the wait, and the writes of one connection always run
one after the other, so writers that waited together never race one base hash. Once
the background admission is done, a write can no longer supersede it, so no further
debounce is needed. A turn of a healthy agent that needs a configuration write after
a start waits with it; in the native contract two agents took about 5 s, and the time
grows with the number and size of the agent databases.

The roster stays watched after the wait (for at most 30 minutes per connection), so
an agent refused later is found too. When the background admission ends, the list is
refreshed and every chat subscribes again at once, so a healthy agent's chat that
was refused while it was still being admitted does not show
`SESSION_UNAVAILABLE` until the next retry.

An agent still refused afterwards, or one whose call reported the refusal, is
degraded until the Gateway restarts: the agent list marks it `degraded`, its activity
needs **attention** with **Couldn't start**, and its chats show **This agent couldn't
start in the agent service. Restart the agent service to bring it back.**
(`AGENT_DEGRADED`, ahead of `SESSION_UNAVAILABLE`) with **Restart agent service**
(the usual `POST /api/assistant-runtime/restart`, refused while turns are open). A new
turn to it is refused with `503` (`agentDegraded`) before anything reaches the Gateway.
Only a refusal with an admission code (`agent-database-…`) counts; a disconnect
forgets the degraded agents until the next roster says so again. A Telegram message
to a degraded agent stays queued, as during any agent-service outage, and is
delivered after the restart; its bot sends no notice meanwhile, and the owner sees
the agent's state in AgentPier.
AgentPier does not restart the Gateway on its own: the owner decides when to
interrupt the other agents. A clean restart admits the agent again; the
[native contract](../tests/integration/assistant-agent-admission-contract.test.js)
checks both paths on the pinned runtime.

Agents receive `session_status` plus the managed AgentPier tools their settings
enable (team, memory, reminder, routine and coding tools; see the sections below).
Gmail, Microsoft 365, Google Calendar and Apple service tools remain deferred.
This tool boundary is not an OS sandbox.

### Qualification and diagnostics

Run `node scripts/verify-assistant-runtime.mjs --data-dir /absolute/empty-directory`
from the source checkout. Use a new disposable directory: the wrapper rejects
existing application data and marks its own directories for repeated probes. The
probe downloads the pinned runtime when missing, uses a local deterministic model,
checks profile application, tool execution, durable history and crash recovery,
and shuts down its child. It needs no model credentials. Standard `npm test` skips
this opt-in probe.

The service panel separates availability from synchronization and shows a sanitized
technical diagnostic code. Logs are private under `assistants/logs`. Authentication
or startup failure terminates an owned child; invalid configuration does not enter
a restart loop. Foreign live ownership is reported without killing that process.
Unexpected exits retry at most five times with exponential backoff.

A real OpenRouter Gemini Flash request passed streaming, a `session_status` tool
loop and terminal reply verification on macOS arm64. Temporary credential copies
were removed after the test. The pinned OpenAI login uses the native device-code flow: the pinned
runtime's SIWC request differs from current OpenAI host-registration requirements;
a second native device-code attempt completed after user authorization. A real
`openai/gpt-6-astra` response and `session_status` tool call passed through that
OAuth profile. The same profile now passes a complete request through the new AgentPier account,
configuration and service adapters, with a completed durable execution record.

### ChatGPT assistant accounts

**Connections › Model access** contains a separate **ChatGPT for agents** entry. Start the assistant
service first, connect using the displayed OpenAI device code, and select the
connection plus a model ID in an assistant's settings. The qualified model is
`gpt-6-astra`; availability and subscription access are determined by OpenAI.
Existing Codex CLI credentials are not implicitly imported.

OpenClaw owns OAuth state. AgentPier's private cache stores only profile references,
labels and status; public IDs are opaque hashes. Model references pin the exact
selected native profile. A missing profile fails instead of trying another
identity. The native qualification test also asserts that a missing profile cannot
fall back to an otherwise working provider key.

The device login uses the supported Gateway wizard and remains tied to its
originating connection. Only the official OpenAI URL and current device code reach
the browser. Cancellation, disconnect and expiry terminate or invalidate the
attempt; navigating away preserves its non-secret ID for resuming the display.
Sign-in is not a generic proxy for arbitrary native wizard prompts.

OpenClaw offers only the provider logins of plugins that a restrictive
`plugins.allow` lists, so the team-mode compile always allows the bundled `openai`
plugin; without it `models.authLogin` answers `INVALID_REQUEST` ("That provider login
is no longer available"). `assistant-chatgpt-login-contract.test.js` starts the
device-code sign-in on a team-mode Gateway and cancels it at the first wizard step.
A failed attempt reports one diagnostic to the browser (`LOGIN_UNAVAILABLE`,
`UNSUPPORTED_LOGIN_STEP`, `LOGIN_EXPIRED`, `CONNECTION_LOST` or `LOGIN_FAILED`),
which the Connections page explains. The server log line adds the Gateway error code,
the wizard status and the Gateway's reason with device codes, bearer values and
token-like strings redacted.

The agent editor offers the ChatGPT model catalog of the native `main` agent. One
Gateway `models.list` read (`agentId: "main"`, `provider: "openai"`, `view: "all"`)
serves every ChatGPT account, because the accounts share that agent. Both the listed
models (live discovery) and each row's `available` flag come from the profile the
Gateway selects for the agent, not from each account: all accounts see the same
list. A profile's own `providerOutcomes` entry still withholds the list from an
account the Gateway rejected. With more than one account, an account without an
outcome is marked as checked against another account, and the editor says so.
Rows of other providers, IDs that are not bare model IDs and rows not marked
available (other than by a cooldown) are dropped; an empty list, a rejected account
and a `refreshFailed` answer whose `openai` outcome is `unavailable` count as a failed
read (`refreshFailed` alone covers every provider and is ignored). `authProfileId`
is not used: OpenClaw scopes it to personal accounts of an authenticated Gateway
user and refuses the agent's own OAuth profiles with `FORBIDDEN`.

The list is cached in memory for ten minutes; a failed or stale read is retried
after one minute, and the retry after a stale `openai` discovery is forced. Loading
the agents page or the account list starts a background read when the cache is
stale; agent runs, checks and logouts never read models. A completed sign-in and
**Refresh models** force a rediscovery: when an unforced read is already running,
the forced one runs right after it. The refresh route shares one owner budget of
twelve requests a minute. When the list cannot be loaded the editor keeps the model
ID field and says so; a custom model ID is always possible.
`assistant-chatgpt-models-contract.test.js` pins the request and row shape against
the pinned Gateway with synthetic credentials. Its discovery goes through a local
proxy that answers 401, so it never contacts chatgpt.com; a signed-in list cannot be
observed offline.

**Check connection** runs the native credential probe. **Disconnect** removes the
selected profile through OpenClaw; pending or unresolved work using that account
blocks removal. Admission is serialized with assistant creation, configuration,
dispatch and service controls so account removal cannot cross a starting request.
Stopped services show cached accounts as unavailable.

Native device-code presentation/cancellation, live credential checking, explicitly
selected OAuth inference and missing-profile rejection were qualified on macOS
arm64. Actual token expiry/renewal and provider-side revocation remain unqualified;
a successful status refresh is not evidence of token renewal. Expired credentials
get a native probe and must return to a usable state before dispatch. If they do
not, reconnect the account. No custom OAuth token refresh implementation is included.

## Telegram text and Deepgram voice

Each saved assistant can own one dedicated Telegram bot and one paired private
chat. Separately, a personal agent without shell can get its own bot for other
people, which OpenClaw runs natively for an allowlist of Telegram user ids; see the
[Telegram senders qualification](assistant-telegram-senders-qualification.md). A
bot serves only one of the two purposes.

The owner's bot has its Telegram section below the assistant settings. Enter the bot token,
open the one-time pairing link and send its `/start` message from your private
chat. Pairing expires after ten minutes. Group chats and other users do not enter
the assistant. The bot must not have another webhook or polling owner; AgentPier
does not delete existing webhooks. Re-pairing is blocked until pending work has
been resolved, both when issuing and redeeming the link. Resuming or changing
credentials invalidates outstanding links. Pause preserves queued work; disconnect
removes the local bot token. Each input retains its source chat/user; delivery
refuses a changed destination. Message deduplication includes the source chat because
Telegram message IDs are chat-local. Older records without source evidence remain
reviewable but cannot be sent by guessing a destination.

The paired conversation shares the assistant's AgentPier history. Only requests
originating in Telegram produce Telegram replies; ordinary AgentPier messages do
not send to Telegram. Input is persisted before polling acknowledgement. Stable
request identities survive duplicate updates and restart. Telegram retains unread
updates for at most 24 hours; that provider limit still applies while disconnected.

Configure Deepgram under **Connections › Services for agents › Speech recognition**. The key stays in a
private backend store; model and language are shared by all assistant voice inputs.
The adapter uses direct HTTP, smart formatting and model-specific proper-name hints,
following the existing pattern in the user-owned Mimisbrunnr project. Voice notes
use Ogg, with a 10 MiB / ten-minute cap. Downloaded bytes are bounded during reading,
kept transiently in memory and cleared after use; no audio files are retained.
There are at most four active processing workers and eight long polls per process.

### Telegram files

Photos, documents, videos, animations and video messages from the paired chat become
chat attachments (`telegram-media.js`). The ledger records each file's Telegram id,
stated size and name at intake; a caption becomes the input's text, with its quote,
code and link formatting kept out of owner proofs like a text message's. Content that
is never a file (stickers, audio, contacts, polls and the like) and a stated size above
the limit (20 MB, Telegram's `getFile` download limit, for videos; 10 MB for any
other file) are refused before any download. An album (items sharing a
`media_group_id`) is one input: its first item opens it, and later items join it while
it is queued and its files were not all fetched yet (`dispatchedAt`, set when its
notice is due), since long polling
may split an album across responses. It goes out once no item came for 2.5 seconds
and a poll that began after its newest item has returned its updates or is still
open after a second (Telegram answers at once while updates are pending); a failed
poll counts as neither. Poll times live in memory, so
after a restart the album waits for the new process's first poll, which brings the
items Telegram still holds; an album whose polls keep failing goes out 60
seconds after its newest item. Each later item keeps a ledger row in the `merged` state, so a repeated update
is still recognised; the activity list shows only the album's input. A later item of
an album that was already fetched is an input of its own, with its own notice.

The files are fetched at dispatch, when the input reaches the head of the queue, and
staged through the same pipeline as a browser upload (`AgentAttachments.stage`, or
`VideoUploads` for a video), under the admission lock: byte sniffing decides the type,
the stamped copy goes to the agent's `attachments/` folder within its quota, and the
request claims the staged files exactly like an AgentPier message, so images reach
vision models inline and videos only as files. Only paths below Telegram's own file
folders are fetched; the bot token is part of the `getFile` and file URLs only, and
errors carry a code, never Telegram's answer or the URL. A download stops at the
part's own limit (10 MB, or 20 MB for a video) while streaming. Each file's outcome is
recorded on the input as it is decided, so a restart or an agent that is busy never
downloads a decided file again; a staged copy that expired meanwhile is fetched anew.
A transient failure of `getFile` or the file URL (network, timeout, 5xx, 429) counts a
try on that part and holds the input (`retryAt`) for 5 s, then 20 s, or Telegram's
`retry_after` when longer; the third failure refuses the part. Before each download
the input waits, without a try, while the assistant service is in maintenance,
recovery or shutdown, or when a video would find no free upload slot; video chunks
check maintenance like the web upload route. At most five files are passed on. One
notice per input names every part that was not passed on and why; an input with
neither text nor a staged file fails with `MEDIA_REFUSED`. An input that finally
fails (`MODEL_REQUEST_FAILED`, a changed destination) gives up its staged copies at
once. Forwarded files carry the forwarded prefix and never authorize; `/team` counts
only in a text message. A restricted user's channel refuses videos, as her web chat
cannot upload them. Bots for other people are OpenClaw's native Telegram accounts and
do not use this path; reading the bundled OpenClaw 2026.10.3, its Telegram plugin
downloads their photos, videos, documents, audio and stickers into its own
`media/inbound` store
(`mediaMaxMb`, default 100 MB, within Telegram's 20 MB) and passes them to the turn.
No contract test covers that.

### Live dictation in the chats

The same Deepgram connection powers the microphone in both chat composers: the agent
chat and the chat view of a coding session (Claude Code, Codex, OpenCode). Tap the
microphone, speak, and the words appear live in AgentPier's message field, where
interim results are replaced by final ones; tap again to stop. The text stays in the
field for editing; **Send dictated messages right away** in the speech settings sends
it once the dictation ends (off by default). The session chat fills AgentPier's
composer, never the CLI's own input line.

The browser records with an audio worklet and streams 16 kHz mono PCM, so Chrome,
Safari and Firefox send the same format. It goes over `/api/dictation/stream`, a
WebSocket behind the login and the origin check like the chat stream. Restricted users
dictate through the owner's connection too; `GET /api/me/dictation` tells them only
whether dictation is available. AgentPier opens
Deepgram's live endpoint with the stored key in the `Authorization` header (the
key never reaches the browser and is held only for the handshake, so the speech
settings stay editable) and relays interim and final transcripts. Model and language
come from the speech settings; **Detect automatically** streams as Nova-3's
`multi`, because live streaming cannot detect the language. Audio is forwarded, never
stored; each forwarded buffer is zeroed once sent. That zeroing is best effort: the
WebSocket library masks a copy of each frame, which the runtime frees later. A Deepgram
socket that stops draining (about 30 seconds of audio queued) ends the dictation. Neither audio nor text reaches logs or the
audit, which records `speech.completed` with the dictation's length in seconds and,
for a user's dictation, her id.

Limits: five minutes per dictation and eight seconds without audio. The owner has one
dictation per login session (a newer one replaces it), at most four at once, and 20
starts per login session in ten minutes. Each user has one dictation across all her
sessions (a newer one replaces it) and 20 starts in ten minutes, and users together
hold at most two at once. Users' dictations never count toward the owner's four, so
they cannot lock him out. Hiding the page (a locked phone, another app) stops it. Without
a key, with agents turned off, or over plain HTTP from another device (microphone
access needs HTTPS or localhost, for example through Tailscale Serve) the microphone
stays visible but explains why it is unavailable. An opt-in contract test runs against
the real endpoint only with a key of its own in `AGENTPIER_DEEPGRAM_TEST_KEY`.

### Telegram feedback

Newly accepted inputs receive one best-effort 👀 reaction. During transcription and
response processing, a separate worker refreshes Telegram's typing indicator every
four seconds. Feedback is limited to the paired source chat/user. Typing refreshes stop for blocked
or completed work; Telegram expires the last indicator after at most five seconds.
Feedback workers are aborted/joined on pause, disconnect and shutdown. Its HTTP
calls have a three-second deadline and respect provider rate-limit delays; failures
do not block the model or alter reply-delivery evidence. Reaction attempts are
recorded before HTTP and are not replayed after uncertainty or restart. These are
application acknowledgements, not control over Telegram's own read-check display.

Telegram activity shows transcription, model execution and outgoing delivery
separately, including the recognized text. Blocked inputs remain directly accessible
above recent activity even when newer messages fill the history window.
Transcription errors can be retried
explicitly. Completed model replies are selected by the exact native run identity;
other history cannot be forwarded accidentally. OpenClaw's history pages cut every
message at its default of 8,000 characters and mark the cut. AgentPier reads each
message a page cut again on its own (`chat.history` with `messageId` and `maxChars`
65,536): at most eight per page, newest first and four at a time; concurrent pages
share a running read, and the cache keeps each result, so later pages within the
cached newest messages need no new reads. The cache holds a conversation's newest 300
messages (three full pages: the newest page that the chat's live feed and server-side
readers use, plus room to scroll back while the Gateway is unavailable) and at most
about 4 MB of text; beyond the newest page, which always stays whole, the oldest
messages leave it first. A history read that changes nothing writes nothing. The AgentPier chat therefore shows long messages whole, the owner's own turns
included, and never shows OpenClaw's marker. A message is served in one of three
states: whole; `cut: true` when its own read confirmed it is still incomplete (over
65,536 characters, or OpenClaw's "message too large" placeholder), with a short note
that the rest is too long to show; or `partial: true` while its own read is still
due (beyond the eight of a page, a failed or unanswered read, or a page served from
the cache while the Gateway is unavailable), with a note that the rest loads
shortly. A failed or unanswered read is never taken as a confirmed cut; it is retried
after 5 seconds, doubling up to 5 minutes, and a message waiting for its retry
leaves room for older ones on the page. Each owner turn with a delivery key is
served with the `requestId` of its request, so the chat replaces the turn it shows
while a run is active by request, not by comparing texts; turns without a key still
match by text. Before a reply goes to Telegram, a partial one is read again on its
own; Telegram gets what is available of an incomplete reply and a closing note
that the reply was shortened and the rest could not be sent; lead relays do the
same. A reply is sent in at most 40
messages; beyond that bound the same note follows. Placeholders and cut markers
are never sent. Replies are split into parts of at most 4,000 UTF-16 code units (see
formatting below), preserving surrogate pairs. Each confirmed
remote message ID is recorded before proceeding to the next part. Known rate limits
wait for the provider's retry deadline.

If a send loses its acknowledgement, its outcome remains unknown across restart.
Check Telegram, then acknowledge without resending to unblock subsequent work.
This action does not resend the uncertain part or declare it delivered. An unknown
model outcome must first be reviewed in the assistant chat using its runtime
recovery flow. There is no automatic replay of uncertain model execution or output.

The automated qualification covers duplicate/foreign updates, credential redaction,
pairing, bounded voice intake, transcription failure, reply identity, Unicode
splitting, rate limits and lost delivery acknowledgement. The pinned native Gateway
contract additionally runs text and voice through the actual assistant service and
model loop with simulated Telegram/Deepgram HTTP responses. On 2026-10-07 the user's
explicitly paired private Telegram chat also passed a live text and voice round trip:
Deepgram produced a nonempty transcript, ChatGPT answered both inputs, and Telegram
acknowledged one outgoing message for each. This establishes the first live path,
not recognition accuracy across languages or long-term reliability. Credentials were
supplied through a private local file; none were imported from Mimisbrunnr.

In that trial, opening the bot manually did not complete pairing. Sending the exact
`/start <code>` command from the pairing screen completed it without the deep link.
Inputs received before pairing are discarded and must be sent again after pairing.

### Notices, language and formatting

Ingress uses long polling (`getUpdates`); there is no webhook. Inputs that cannot be
processed are answered instead of dropped silently: a message from an unpaired
person gets a short refusal (and never reaches the agent), unsupported media or
media with a caption get a notice, and a voice message longer than the limit (ten
minutes by default) is refused with the allowed duration. Inputs held for review
(unknown model outcome, uncertain delivery) sit in a separate review lane above
recent activity and are released through explicit acknowledgement.

Each channel stores two settings besides the token: `appUrl`, the address under which
the owner reaches AgentPier, and `language` (German or English). Notices that
AgentPier writes itself (approvals, decisions, work started, results) use the
channel's language and, when `appUrl` is set, end with a deep link to the team or
chat. Only the origin of `appUrl` is kept. Changing the language or address affects
notices created afterwards; an existing notice is reused unchanged, so a change never
duplicates or rewrites one. Link targets longer than 1,024 escaped characters are
sent as plain text.

Agent replies are Markdown. AgentPier renders a small subset (bold, italic,
strikethrough, code, links) as Telegram HTML and escapes all other
text. If Telegram rejects the formatted message, the same text is sent as plain text;
a send whose outcome is unknown is never retried in another format.

A long message (a reply, a routine result, a reminder, a check-in, a relayed lead
request or a notice) goes out as several messages, in order. Each part holds at most
4,000 UTF-16 code units of HTML, which keeps its visible text below Telegram's 4,096
characters, and ends at the best break that leaves it at least half full: a blank
line, a line break, a sentence end, then a space. Breaks outside any formatting are
preferred; a part never ends inside a link or inline code, and a code block only
between its lines. The whitespace at the break is dropped (in a code block only the
line break, so indentation stays). Formatting still open at a
break (bold text, a code block) is closed and reopened in the next part. Only text
without any such break, such as a single overlong word or URL, is cut at the limit,
never inside a tag, entity or surrogate pair. Parts are not numbered.

API references: [Telegram polling](https://core.telegram.org/bots/api#getupdates),
[Telegram messages](https://core.telegram.org/bots/api#sendmessage),
[Telegram files](https://core.telegram.org/bots/api#getfile),
[Telegram photos](https://core.telegram.org/bots/api#sendphoto) and
[documents](https://core.telegram.org/bots/api#senddocument) (files agents share,
see [Files agents share](#files-agents-share-2026-10-17)),
[Deepgram transcription](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded).

## Visible teams: operation and recovery

The assigning assistant offers a team proposal by default. Approve or decline it
in the parent chat or through its paired private Telegram chat. A `/team <task>`
text command or the one-message team switch behind the composer’s "+" options
button authorizes one proposal for that request; while it is on, a "Team allowed"
chip next to the button shows it and turns it off again when tapped. An explicit
owner request in ordinary words ("build a team that …") authorizes that one team as
well: the team proposal tool carries
`ownerRequestedTeam` and a verbatim `ownerRequestQuote` (at most 300 characters),
and AgentPier admits the team without confirmation only when the quote has at
least three words, contains "team" (also inside compounds such as "Rechercheteam")
and appears as whole words in the owner's own prose of the stored user text of the
same request after whitespace and case normalization, by the same rules as a lead's
task quote (below): not in code, block quotes, links or other text the owner quoted
or pasted (also Telegram quote, code and link formatting), not after a quotation
mark, and not in a message with a negation anywhere ("do not build a team …",
"kein Team …"); such a request needs the owner's approval. The turn context comes from AgentPier's own records, never from the
model. The owner's own web and Telegram messages qualify, including transcribed
Telegram voice and captions; forwarded content (text, voice or files), scheduled turns and internal
member/result turns never authorize, and one request authorizes at most one team.
The authorization records its source (`command`, `checkbox` or `ownerRequest`).
Parent settings can enable standing team permission; a plain-language request never
changes it.

Known limits: AgentPier cannot tell third-party text pasted into the web composer
from the owner's own words (only Telegram forwards are detected), and an owner
message that mentions a team in another sense ("my team meets at three") can still
be quoted by the model. The mitigation is visibility: the team card (in the proposal
and under the lead's agent settings → **Team › Teams**) and the Telegram start notice show "Started because you wrote: “…”" with the quote, and the owner
can stop the team at any time.

Default limits are four members, eight concurrent members per host and ten minutes
per member. Team size is configurable from one to eight, deadlines from one to sixty
minutes, and host capacity from four to thirty-two (never below a configured team
size). All members may run concurrently. One active team per parent, one automatic
turn per member and no nested delegation keep accepted work bounded. Cancellation
of a parent response does not cancel its team. Stop member and Stop team are separate
operations. A deadline requests cancellation; it does not prove completion or free
an uncertain slot.

Each member has its own profile, chat, instructions and model reference copied at
creation. Service and project grants start empty. Completion retains the member and
its history. Settings support explicit permanent promotion and archive/restore;
active or uncertain work blocks lifecycle and configuration changes. Promoted
members reuse the same identity and history and remain unable to create subteams
in this stage.

Provisioning persists identities before RPC. A lost profile/session acknowledgement
can only adopt a unique matching profile or labelled session. Missing or ambiguous
evidence remains blocked. Unknown setup can be explicitly acknowledged in member
settings after other requests finish. Sidebar and parent-team member buttons open
those settings when no conversation exists yet: the owned Gateway is stopped/restarted and
the member is marked failed without creating a replacement. Unknown execution uses
the existing chat recovery action. Neither recovery route replays work.

The bundled `agentpier-teams` plugin is staged privately and verified on fresh
installation and every existing-runtime provisioning path. Compatibility is pinned
to OpenClaw 2026.10.7 and its qualified rollback predecessors 2026.10.3, 2026.9.9 and 2026.9.8. Eligible parents receive the eleven managed team tools (propose, status,
stop, grant ([team member grants](#team-member-grants-2026-10-17)) and the [member tools](#lead-questions-and-tasks-for-members)) and
`session_status`; members receive `session_status` and their own four
[member tools](#member-questions-tasks-and-reports) (`agentpier_team_peers`,
`_peer_ask`, `_peer_delegate`, `_report`). Direct native spawning
and alternative session mutation tools are not offered; `exec` and `process` only
under [agent shell access](#agent-shell-access-2026-10-12), which temporary members
get only through their lead's [explicit setting](#team-member-grants-2026-10-17). The private loopback
bridge binds 30-second prepare/commit tickets to the exact active attempt and
runtime generation. Credentials are never part of public team projections.

Results form one durable batch and one parent synthesis request per team. A busy
parent delays synthesis. Unknown synthesis is not resent. A terminal member without an exact-run textual
report still completes its batch with `reportAvailable: false`; unavailable or
paginated history does not turn terminal work back into running work. The member
chat retains any later history. A member's report is its run's last assistant
message with text (as OpenClaw's own channel reply; text written before a tool call
is commentary), read on its own when the history page cut it and kept whole up to
65,536 characters. Beyond that, or when OpenClaw serves it only as "message too
large", the batch entry is cut by code point and marked `cut`, and the team card
says "Shortened" with a link to the member's chat. The team record keeps only the
first 2,000 code points of each report (`truncated` when longer); the whole report
lives in its own `text` row of the team store, so the team list, the scheduler pass
and the Telegram scan stay small. The card loads the whole report from
`GET /api/assistant-teams/:id/reports/:memberId` when it is opened, and the lead's
`agentpier_team_status` tool returns the excerpts marked `shortened: true` with a
note that the whole report is in the member's chat. The synthesis request stays
below 60,000 characters (the request limit is 65,536), JSON escaping included:
when the reports do not fit, the longest are shortened first to one common length,
then the members' coding runs (tasks shortened, then only counted); every shortened
or cut entry carries `shortened: true` with the instruction that the whole report
is in that member's chat. A failed send is retried like any other admission
failure. Only a synthesis text that send's own validation rejects ends without a
retry: the team shows "The results could not be passed to the agent"
(`resultState: unsent`, `RESULT_UNSENDABLE`), the lead's chat gets a note after the
team's end, the server logs it, and a Telegram origin receives the individual
reports instead. A completed synthesis without available text sends
an explicit fallback with attributed individual reports. A Telegram team result
is read whole like a direct reply; one that stays incomplete, or a fallback over
65,536 characters, ends with "Reply shortened – the rest could not be sent." Telegram approvals and
late results use a separate durable outbox tied to the original channel/chat/user.
Telegram approval includes the full objective, names, roles and assignments. Long
proposals use ordered chunks, with buttons attached only to the last chunk after all
earlier chunks were acknowledged. Buttons expire after 24 hours and authorize only
the stored proposal revision.
UI decisions invalidate stale buttons. Pause retains notifications; unresolved
notifications block re-pairing/disconnect and remain visible in Telegram activity.
Changed destinations are rejected. Unknown delivery requires acknowledgement without
resending; ordinary replies and notifications share the same intent-before-send
and confirmed-message-ID logic.

### Lead questions and tasks for members

A lead reaches its own members without the owner relaying anything
(`lead-requests.js`, `lead-request-store.js`):

- **Tools.** `agentpier_team_members` lists the lead's members that are not
  archived with their latest questions and tasks; `agentpier_team_ask` asks one of
  them (temporary or permanent, running or finished); `agentpier_team_delegate`
  hands a task to a permanent member (one open task per member);
  `agentpier_team_cancel` cancels an open one; `agentpier_team_archive` archives the
  lead's finished temporary members without asking; `agentpier_team_member_update`
  edits a temporary or permanent member, `agentpier_team_models` lists the models it
  can give its members (see below), `agentpier_team_promote` keeps one as a permanent
  agent and `agentpier_team_member_routine` sets up routines on permanent members
  that report back (see below). `agentpier_team_templates` searches the Agency catalog
  (ids, names, categories; `team-templates.js`), and a proposed member may name one
  as `template`: `TeamService.propose` fetches it at the catalog's current revision,
  scans it (`skill-scan.js`), refuses a blocked one (`TEMPLATE_BLOCKED`) and stores
  the template record and its instructions with the draft; the member's instructions
  are the template's instead of the lead's, and a warned template forces the owner's
  approval. A proposed member may also name a `model` (`{ connectionId, modelId }`,
  from `agentpier_team_models`): `TeamService.propose` checks each with
  `validateMemberModel` before anything is stored, so one model the owner cannot
  run refuses the whole proposal. The draft keeps the ids (part of the proposal's
  fingerprint) and the owner's names for it (`modelLabel`, shown on the approval
  card); the member is created on it with `leadModel` on its team record, a
  temporary member as its own model (`ownModel`; a permanent member always keeps
  its own model and gets no flag). A temporary member without one follows the
  lead's model.
  `agentpier_team_models` (`member-models.js`, `{ query?, limit? }`, limit 50 by
  default, at most 200; not available to routines) lists the models of the owner's
  usable sources: ChatGPT accounts, OpenRouter connections with a key (rows from the
  provider catalog) and endpoint connections with their model lists. A ChatGPT
  account's name can be its e-mail address, so the lead reads it as `ChatGPT`, with
  the first six characters of its hashed connection id when there are several. Each
  model comes with
  `connectionId`, `modelId`, context and output tokens, `reasoning`, `imageInput`
  and `pricing` (`inputPerMTok`/`outputPerMTok`, USD per million tokens; known for
  OpenRouter only, otherwise `null`; `null` also marks any unknown value). It also
  returns `total` and `current`, the model the lead and each of its members run on
  now. The tool prompt tells the lead to state known costs to the owner.
  `agentpier_team_member_summarise` (`member-summaries.js`, `{ memberId, when:
"now" | "after_task" }`, not available to routines) summarises one of the lead's own
  non-archived members' task chat (below). Members never get these tools,
  and the bridge refuses them to member turns; members have their own, one-level
  [member tools](#member-questions-tasks-and-reports) instead.
- **Long member chats.** After a member's task chat (`member.conversationId`, not the
  further chats the owner opened) reached a terminal attempt, `MemberLongChats`
  (`member-long-chats.js`, table `assistant_member_long_chats`, private in backups) reads
  its `sessionInfo`. When the chat is long (`longContext`: 60 % of the window, else
  100,000 tokens) it sends the lead one compact message `member-long-chat` in its main
  chat (retried with backoff while the lead's chat is busy). It tells again only at
  the growth rule of the owner's hint (half again or 50,000 tokens) or after the size
  fell below the marker (a summary), and never while a pending after-task summary exists
  or the chat is being summarised. The message names `agentpier_team_member_summarise`.
  The tool refuses a member that is not the caller's own or archived (409 member
  ended); `now` answers `busy` while the member's chat or task is active, `already`
  while it is summarised, `nothing`, or `summarising` once the work starts (the memory
  step answers at once); `after_task` on an idle member behaves like `now`, otherwise
  it stores `summaryAfterTask` on the member's team record (survives restarts, cleared
  on archive) and `TeamService.reconcile` starts it once the member is idle, before the
  next lead request or delegated task reaches the chat (the send meets the summary and
  waits). Both chats get a note. While the owner talks in that chat himself
  (`ownerTalking`: a person's own turn, `directOrigin`, runs there or was accepted
  within `ownerChatQuietMs` = 60 minutes, or a queued message of his waits for it; a
  work-goal continuation is recorded as `kind: "owner"` and counts too) the
  tool answers `owner` for both choices, which tells the lead to leave the chat to the
  owner and his **Summarise now**; a pending after-task summary is dropped at its next
  run, and `MemberLongChats.check` sends no hint (AGENTPIER-248).
- **Authorisation.** The server resolves the lead from the attempt and checks every
  target: own member, not archived, `lifetime: "permanent"` for tasks, finished and
  temporary for archive (checked again inside the archiving transaction). By the
  owner's decision questions and tasks never wait for an approval; they run as soon
  as the member is free. A member therefore acts on the lead's text with its own
  capabilities: a member with full shell access or bound MCP servers uses them for
  a lead's request without asking. A member whose shell is set to approval still
  asks the owner before every command of such a turn (exec approvals do not depend
  on who started the turn), and an agent with its own Telegram bot for other people
  should only lead members whose shell and servers the owner accepts for that.
- **Files.** Questions never write. A task may use `write`/`edit`/`apply_patch` in the member's
  own workspace only when the owner explicitly asked for it in this very turn
  (AgentPier chat or Telegram, not forwarded). The tool's quote must be a
  whole-word, verbatim excerpt of the owner's own prose in that message, which is
  read as for mentions (below): never code, block quotes, struck-through text,
  links, images, footnotes or HTML, nor a Telegram message's quote, code, pre,
  link or strikethrough formatting, and nothing of a message over 20000 characters
  or nested more than 24 levels. The quote must:
  - name the member: its whole display name as whole words (not when a longer name
    of another member is meant, "Max Ops" for "Max"), or a word of it of three
    letters or more that no other member carries and that is no everyday word;
  - say to ask or delegate in a verb form (`ask`, `delegate`, `assign`, `frag`,
    `fragt`, "frage den/die …", `delegier…`, `beauftrag…`, `übergib`, "gib … an",
    "lass … machen", "let … do", "hand … over"; `lead-request-proof.js`);
  - stand in a message without any negation or limit to reading, anywhere in it,
    as for mentions (owner decision; `nicht`, `kein…`, `nie`, `niemals`, "don't",
    "do not", `not`, `never`, `no`, "read only", …); the owner can send such an
    instruction on its own;
  - not follow a quotation mark, so pasted or quoted text is never the owner's
    instruction.

  An @mention is a second way (AGENTPIER-68, owner decision): when the owner's own
  message of the turn mentions a member with `@<display name>`, a task to that
  member in that turn may write without any quote or ask verb. AgentPier finds the
  mention itself, and the lead's quote never counts one. The message is parsed as
  the chat renders it (`treeMentions` in `member-mentions.js`, shared by the proof
  and the chat's chips), so a mention counts only where the owner sees a chip:
  - never in code, block quotes, struck-through text, links, URLs, images,
    footnotes or HTML, nor in a Telegram message's blockquote, code, pre,
    text_link or strikethrough entities (kept by the channel inbox as `hidden`
    ranges of the turn context), never from a character reference (`&#64;`) or an escape
    (`\@`), and never right after a letter, digit or path or markup character;
  - names match case-insensitively by a simple per-character fold, without
    normalisation, so look-alike or invisible characters mention nobody; a name two
    members share proves nothing;
  - any negation or limit to reading anywhere in the message (`nicht`, `nichts`,
    `kein…`, `ohne`, "nur lesen", "Finger weg", "in Ruhe", "don't", "isn't",
    "read-only", "just read", "hands off", "leave … alone", …) means no mention
    proves anything; the owner can send such an instruction on its own;
  - no quotation mark may come before the mention;
  - messages over 20000 characters, nested more than 24 levels or that fail to parse
    have no mentions, and at most the first 20 are looked at.

  Each mention proves one task. One owner sentence proves one task per member across
  both ways, each quote is used once and a turn proves at most three; standing team permission does not count. The grant is
  stored with the request (`writeAllowed`, `ownerProof`) and holds only during the
  task's own running attempt (`TeamBridge.toolPolicy`, `LeadRequests.mayWrite`).
  `MEMORY.md` and `memory/` stay read-only in every spelling the write guard repairs
  and through links in the workspace (`lead-request-writes.js`), so a task cannot
  plant instructions for the owner's own chats. Every other task runs read-only. The lead's agent settings → **Team › Teams** mark each task "may write" or "read-only".

- **Team usage levels.** The lead's team policy carries `usage`
  (`onRequest`, `suggest`, `autonomous`; `team-policy.js`). Policies stored
  without it read as `suggest`, which is also the default for new agents. Before each
  turn `AssistantConfig` adds a "Your team" section to the lead's `AGENTS.md`
  (`team-guidance.js`, read by `LeadRequests.roster` while the team tools are
  offered): up to twelve members with name, role and lifetime, and the level's
  rules. Busy states stay out (`agentpier_team_members` reports them), and the
  section stays out of the configuration fingerprint, so a roster or level change
  only rewrites the file (`verifyBootstrap`). Under `suggest` and
  `autonomous` a third proof makes a task writable: the lead's quote of the owner's
  short yes (`ownerConsent` in `lead-request-proof.js`: the owner's own prose is at
  most twelve words, holds an agreeing word such as "yes", "ok", "go ahead", "ja",
  "mach das", has no negation or limit anywhere, the quote follows no quotation mark,
  and the message names no other member), once per turn, and only when the lead's
  last reply before the turn, read from the Gateway's history
  (`LeadRequests.lastReply`), names that member. Under `autonomous` a self-initiated task
  without proof in a turn of the owner's own message is writable as well, unless the
  message holds a negation or limit anywhere (`messageNegated`) or names the
  member (then only a valid proof makes it writable) (`autonomous: true`, accepted by `LeadRequests.mayWrite` with the same
  workspace and memory limits); forwarded, scheduled and member turns stay
  read-only (a lead's own `member-result` follow-up writes, see delivery below). Shell, SSH, project folders, GitHub and grants are untouched, and team
  proposals keep their rules. A request at that level whose owner message does not
  name the member is `selfInitiated` (shown as "self-initiated") and counts
  against `autonomousCaps`: 4 per turn and 20 per lead and hour, refused as
  `AUTONOMOUS_LIMIT` with a fixed reason beyond.
- **Limits.** At most 16 open requests per lead, 6 per lead and minute and 8 per
  owner turn (`RATE_LIMITED` beyond), so a member answer that keeps the lead asking
  ends quickly.
- **Delivery.** A request waits until the member is free (no running turn, no
  active team assignment) and then runs as an ordinary turn in the member's chat,
  shown there as the lead's bare text with "from <lead>". The member sees only the
  question or task, never the lead's conversation. The ask tool holds the lead's
  call for at most 110 seconds counted from the moment the bridge received it:
  OpenClaw's embedded harness gives plugin tools no own timeout, and its
  stuck-session diagnostics flag a call only after two minutes. Outside pull
  requests the team plugin contract holds an ask for 115 seconds against the
  pinned Gateway. An answer that misses the wait, or whose response could not be
  written to the caller, a task result or a failure reaches the lead as a hidden
  follow-up turn (at most 60,000 characters) once its chat is idle, and from there
  the paired Telegram chat when the request came from Telegram. Follow-ups that
  keep failing end as `FOLLOW_UP_FAILED`, shown on the request. The follow-up turn
  (`member-result`) acts like the lead's own work whatever the request was allowed
  (`member-result-writes.js resultTurn`: exactly the ledger request
  `lead-request-result:<id>` in the lead's chat, the lead still active): native
  writes in the lead's workspace and memory, each audited as `kind: "native-write"`
  with `via: "member-result"` and `leadRequestId`, and `agentpier_workspace` on the
  lead's own `projectFiles` and projects only (never shares; folder changes audited
  the same way). Its `coding_start` always waits for the owner (`via:
"member-result"` on the action). The member's text never proves anything: SSH stays
  refused (`SSH_ORIGIN_REFUSED`), and so do grants and owner-only switches. A refused
  SSH command makes `LeadRequests.refusedChange` mark the request
  `resultWriteRefused`, the chat history marks that follow-up `goAhead`
  (`conversations.js goAheadMarks`), and the web chat offers **Go ahead** below the
  lead's reply while nothing newer was sent: it sends "Yes, go ahead" as a real owner
  message. A background command's completion run continues its owner turn in the
  same way, under stricter proof (see **Command completions** below).
- **Answers.** The member's answer or result is its run's last reply, kept whole
  up to 65,536 characters; the request record keeps its first 2,000 code points
  (`answerTruncated`) and the whole answer has its own `text` row, pruned with the
  request. A longer one is cut by code point and stored with `answerCut`, also when
  OpenClaw serves it only as "message too large" (no `NO_TEXT` then); the ask tool result and the follow-up then carry `shortened: true`
  and tell the lead that the whole text is in the member's chat, as does a
  follow-up shortened to fit its own limit. The request in **Team › Teams** shows
  "Shortened" with a link to that chat.
- **Tool calls and scheduled runs.** Plugin tools receive the session key but no
  run id (OpenClaw 2026.9.8 and 2026.9.9 tool context), so the bridge binds a call to the
  session's single active AgentPier attempt. Native runs never reach these tools,
  and only routine runs reach `write`/`edit`: they run in their own `cron:<job>`
  session, which has no attempt; check-ins run with `toolsAllow: ["memory_search", "memory_get"]`,
  reminders with no tools, and routines with `routineTools`, which leaves out the
  plugin's tools apart from SSH, shared files, the lead's `members`, `ask` and
  `delegate` and a member's own `peers`, `peer_ask`, `peer_delegate` and `report`
  (pinned by the native heartbeat, reminder and routine tests). A
  routine run's `write`/`edit` pass the guard as their own origin
  (`TeamBridge.routineWrite`, see [workflows](assistant-workflows.md)).
- **Routine origin.** A lead's routine run reaches `members`, `ask` and
  `delegate` without an attempt: `TeamBridge.prepare` binds the call to the run
  session of a bound, enabled routine of a personal, non-archived agent with routines
  on (`routineRun`) and re-checks it on every step. `LeadRequestStore.caller`
  resolves the lead from the routine's chat (members and archived agents never lead),
  and the request is stored with `origin: { kind: "routine", bindingId, name }` and
  `routineRun` (the run session) in place of `parentRequestId`. A routine is not
  owner text: no quote, mention or yes is read, so its tasks do not write
  (`writeAllowed: false`, no `ownerProof`, never `autonomous`) at every usage level,
  unless the owner switched on **May write** for that routine (`routineWrites` on
  its binding, set through the owner's
  `PATCH /api/assistants/:id/routines/:routineId` with `writes`, or by the agent's own
  `agentpier_routine` on the owner's direct request (below), audited as
  `kind: "routine-writes"`). Its tasks then
  count as the owner's standing instruction: the context records `writes: true`
  and the request `routineWrites: true` and `writeAllowed: true`, which
  `LeadRequests.mayWrite` accepts like an owner proof (`taskWritable`
  in `lead-request-store.js`); shared project folders write at their share's level in
  every task anyway. Questions run as usual. The same member checks apply as in chat (own member, not
  archived, tasks only to permanent members), the per-turn limit counts per run, and
  under `autonomous` a routine's requests are `selfInitiated` and count against
  `autonomousCaps`. An ask returns the answer inline within the wait; a later answer
  or a task's result reaches the lead as a follow-up turn in the routine's chat once no
  ask waits for it. **Team › Teams** marks such requests "Scheduled · <routine>".
- **Recovery.** Requests are durable records in the team store; settled ones are
  pruned after 30 days or beyond the newest 200 per lead (members' requests to each
  other and their reports count apart, with their own 200), and the scheduling pass
  reads only open or undelivered ones. A send whose outcome is unknown at a restart
  is adopted by its stable request id instead of sent again; an unknown member
  outcome ends `failed` once reviewed and is reported to the lead. Archiving a
  member fails its queued requests.

### Member questions, tasks and reports

Members of one lead reach each other and their lead without the lead relaying
anything (AGENTPIER-197; `peer-requests.js`, `peer-request-rules.js`,
`member-reports.js`, tools in `team-plugin/member-tools.js`):

- **Tools.** Every non-archived member's entry holds `agentpier_team_peers` (its
  siblings of the same lead with `memberId`, role, lifetime, busy state and
  `canDelegate`), `agentpier_team_peer_ask` (`{ memberId, question }`, waits like the
  lead's ask), `agentpier_team_peer_delegate` (`{ memberId, task, resultTo?: "me" |
"lead" }`, permanent siblings only) and `agentpier_team_report` (`{ kind: "result" |
"problem", text, files? }`, up to 10 project file paths, which AgentPier names but
  never reads). The bridge (`memberActions` in `team-bridge-actions.js`) refuses them
  to leads and personal agents, and refuses the lead's tools to members. A member's
  routine run reaches them too (permanent members only), bound to its run session.
- **Records.** Questions and tasks are `lead-request` records under the lead
  (`parentAssistantId`) with `fromMemberId`, `fromAssistantId`, `fromName`,
  `fromConversationId`, `resultTo` and `origin: { kind: "peer", fromMemberId }`, run by
  the lead's scheduler but never counted against its caps. `parentConversationId` is
  the lead's main chat at creation, or `null` without one. Reports are records of type
  `report` with `origin: { kind: "member-report", reportKind, routine? }`, stored
  completed and delivered once.
- **Turns.** A member may start one only in its own work (`peerTurn`): the owner's own
  message (not forwarded), its team assignment, its lead's request, or its routine.
  Every other turn is refused (`PEER_TURN`). While it handles a sibling's request or
  that request's result (`peer-result`), it may only report (`PEER_LOOP`), so there
  are no chains or ping-pong.
- **Limits** (`peerCaps`, `reportCaps`):

  | Bound                                        | Value | Refusal        |
  | -------------------------------------------- | ----- | -------------- |
  | Open requests per sender and receiver        | 1     | `PEER_OPEN`    |
  | Open tasks per receiver (also from the lead) | 1     | `PEER_OPEN`    |
  | Open requests per sending member             | 3     | `PEER_LIMIT`   |
  | Requests per sending member and rolling hour | 6     | `PEER_LIMIT`   |
  | Reports per member and rolling hour          | 6     | `REPORT_LIMIT` |

  Each refusal's reason tells the member to report to its lead instead. A target
  outside the sender's lead, archived, or without a chat is `notFound`; a task to a
  temporary sibling is `memberRequestNotPermanent`.

- **Writes.** Questions never write. A task is writable only when the sender's turn may
  write itself (`peerWriteOrigin`, stored as `peerWrites`): the owner's message in the
  sender's own task chat, the writable lead task this very attempt runs, or a routine
  marked **May write**. The receiver works with its own tools, never the sender's
  grants or task shares. A request whose sender's turn the lead started (a lead
  question or task, a `team-member` assignment, or a routine with `createdBy: "lead"`,
  also an autonomous one; `peerLeadScope`, stored as `leadScope`) reaches only the
  lead's standing shares on the receiver (`sharesOnly`), for reads and writes, as the
  lead's own request would. Only the owner's direct turn with the sender or an owner's
  routine keeps the receiver's own grants plus standing shares, read-only unless the
  task is writable. Memory stays
  read-only (`peer-request` memory note), and `coding_start` from a peer request always
  waits for the owner.
- **Delivery.** The receiver's chat shows the request with the sending member as
  sender. An answer that misses the wait, or a task's result, goes as a hidden
  `peer-result` turn to the sender's chat (`peer-request-result:<id>`), which cannot
  change files or ask other members; it may note things in its own memory. With `resultTo: "lead"`, or when the sender can
  no longer be reached (archived, chat gone, or a temporary member whose task ended),
  it reaches the lead's current main chat as a `member-result` turn instead. Reports
  go to the lead's current main chat as `member-result` turns, one at a time per
  member (`MemberReports.held`), and wait while the lead has no main chat.
- **Lead visibility.** `peer-notes.js` adds a quiet `peer-request` event line to the
  lead's current main chat when a request starts and when it ends (who and how it
  ended, never the text). A request created while the lead had no main chat shows its
  notes in the main chat the lead has later. Notes are no lead turn and are pruned with
  their request. **Team › Teams › Questions and tasks** lists exchanges as "<member> →
  <member> · question/task" and reports as "Result from <member>" / "Problem from
  <member>"; `agentpier_team_members` shows the lead each member's requests from
  colleagues. The lead's "Your team" section and tool descriptions say that members can
  agree among themselves and report back.

### Coding requests from team members

Members in a team turn can request coding runs on the parent's current project
grants; [agent workflows](assistant-workflows.md#coding-requests-from-team-members)
describes the full behaviour. For operation:

- **Owner approval:** every member request waits for the owner's exact approval,
  in the parent's chat, the team card or the bound Telegram chat. The parent's
  standing permission to start pipelines never applies.
- **`GRANT_REVOKED`:** access or the pipeline definition changed between request
  and start, so the action failed and nothing ran. Grant the project again and let
  the member ask again; AgentPier never replays it.
- **Withdrawal on stop:** stopping the team or the requesting member declines its
  pending requests with `TEAM_STOPPED` (audited); they can no longer be approved.
  Runs that already started keep running and can be cancelled from their pipeline.
- **Follow-ups:** requests still open when the team finishes appear as pending in
  the team result; the parent's chat receives each one's final outcome later.

## Managed native memory and reminders (2026-10-08)

Agent settings now expose independent memory and Telegram reminder capabilities.
Existing definitions default to both disabled. Task-scoped team members get what
their lead grants them: a read-only copy of its memory and reminders created on it (see
[Team member grants](#team-member-grants-2026-10-17)); promoted permanent
members can opt in with their own settings and channel.
OpenClaw owns memory files, indexing, schedules, execution and run history.
AgentPier owns capability configuration, UI, original destination bindings and the
existing durable channel delivery outbox. It has no second memory index or clock.

### Memory

Enable **Remember information** in the agent's settings, then ask it to remember a
fact in chat. The settings panel reads and edits native `MEMORY.md` and `USER.md`,
and searches all indexed memory in that agent's workspace. Saving carries the
native expected file hash (or expected-missing flag): concurrent agent edits cause
a conflict instead of being overwritten. Reload before reconciling such a conflict.
Saving an empty note clears that file; it does not purge chat history or other
workspace notes. Native file tools stay within the workspace.

The initial managed search uses OpenClaw's keyword provider `none`, requiring no
embedding account. Transcript indexing and cross-conversation recall stay off,
scheduled check-ins replace OpenClaw's own heartbeat (see
[Proactivity](#proactivity-check-ins-2026-10-12)), and dreaming runs only when the owner
switches it on ([Dreaming](#dreaming)).
`skills.workshop.autonomous.mode` is explicitly `off`, so
enabling cron does not also start OpenClaw's default weekly skill collection reviews.
Explicit repository memory access is now described in [agent workflows](assistant-workflows.md).
Semantic search and comprehensive deletion/re-ingestion remain follow-ups.

#### Persistence, compaction and visible failures (AGENTPIER-99)

An agent once said it had saved a plan without ever calling `write`; the conversation
was compacted and the plan was gone. Four rules close that gap:

- **Guidance.** `skipBootstrap` keeps OpenClaw's own workspace templates (and their
  "write it down" routine) out, so the managed `AGENTS.md` section
  (`assistant-bootstrap.js`) carries a short `## Memory` routine whenever memory is
  on: the conversation is compacted and is not memory; durable facts and plans go
  to `MEMORY.md`, day notes to `memory/YYYY-MM-DD.md`, written when the owner shares
  them; never claim "saved" without a successful write in the same turn; say plainly
  when a write is refused. Team members also learn that memory is read-only in
  turns their lead asks or delegates. When the agent's `write` and `edit` are
  withheld (no live guard), the section says memory is read-only right now. Turn
  admission rewrites `AGENTS.md`, so existing workspaces pick the text up on their
  next turn.
- **Pre-compaction flush.** OpenClaw 2026.10.3 and 2026.10.7 run the memory flush
  as a separate run (`trigger: "memory"`) in a detached internal session
  `agent:<id>:internal-session-effects:<runId>-<sha16>`, whose only file tool is an
  append-only `write` restricted to the day note (`memory/<date>.md`,
  "memory-triggered compaction runs expose only read and append-only write"). No
  AgentPier attempt is bound to that key, so the guard used to refuse it and the day
  note stayed empty. The source run reports the flush on its own session as the
  Gateway agent event `run_status` / `memory_flushing` (and leaves it with the next
  phase); `MemoryFlushes` follows those events. The team plugin forwards the hook's
  `runId`, and `flushWrite` (`memory-write-policy.js`) admits a write only when all
  of these hold: the tool is `write`; the key is the calling agent's flush key and
  names exactly the reported run id; the path is `memory/YYYY-MM-DD.md` for today or
  yesterday in the Gateway's user timezone (`agents.defaults.userTimezone`, else the
  host's); exactly one flush of the agent is reported, its session's single active
  attempt is the flushing run (attempt id or Gateway run id) and an owner or paired
  Telegram turn that is not forwarded, or the session is a routine run with routine
  writes; and the flush is still pinned to the first internal session that wrote for
  it. Every other key, path, tool, origin and ambiguity is refused and logged once
  per session; a flush report older than ten minutes is ignored.
  `assistant-memory-flush-contract.test.js` forces a compaction on the pinned
  runtime, checks that a forwarded run's flush writes nothing and that the owner
  run's flush appends to an existing day note.
  Residual risk: the hook sees only the tool name, path and content, not whether the
  `write` is OpenClaw's append-only flush writer, and the run-id match only ties the
  key to its own run: it does not tell a flush run from another internal
  `internal-session-effects` run. Within an owner run's flush window, another
  internal run of the same agent that wrote first could replace that day's note.
  The exposure is limited by the first-session pin (one internal session per
  flush) and the date bound (today's or yesterday's note only). Nothing in
  AgentPier starts other `internal-session-effects` runs today. A compaction the
  person asks for with **Summarise now** (`sessions.compact`, see
  [Live steps and stalled turns](#live-steps-and-stalled-turns)) runs no OpenClaw
  flush, so AgentPier runs its own memory step first (`memory-step.js`): a hidden turn
  of context kind `memory-step` in the chat itself, for an agent that may write memory
  (on a shared agent into its shared memory, see [Agents of restricted
  users](#agents-of-restricted-users)). `memoryStepWrite` admits only `write`/`edit` to
  the agent's own `MEMORY.md` or `memory/…` (never `memory/lead/`) and the toolPolicy
  and every bridge action refuse the session's other tools. In OpenClaw Code Mode the
  model sees only `exec` and `wait`; the step hook (`stepPolicy`, `memory-step-tools.js`)
  admits an `exec` only with the host-set hook `toolKind: "code_mode_exec"` (a shell
  `exec` carries none) and `wait`. `exec` is also one of OpenClaw's locked core tools,
  whose own hook (`lockedToolCall`) forwards the kind to `/tool-policy`; during a memory
  step `toolPolicy` admits the same Code Mode cell by the same rule (`codeModeControl`)
  and keeps refusing every other locked call, a shell `exec` included (an agent of
  restricted users runs no cell at all). Every tool call from the cell passes the step
  hook and the bridge's write guard on its own (OpenClaw wraps the cell's catalog tools
  in `before_tool_call`), so it reaches only the step's memory tools;
  `assistant-memory-step-code-mode-contract.test.js` saves a day note from a cell on the
  pinned runtime and sees a write outside the memory refused inside the cell.
  The cell's own JavaScript is no tool call: it runs in OpenClaw's executor, by default
  Node `node:vm` in a worker, which OpenClaw documents as no security boundary (its
  QuickJS executor isolates more), and its `store()`/`load()` meet no hook. `wait` is
  admitted by name because the bridge cannot see whether a cell is open; a resumed cell
  gains nothing a new one would not, an accepted residual risk. The step is bound by the
  chat's own attempt, never reaches Telegram and is aborted like **Stop** after five
  minutes.
  OpenClaw's own pre-run flush during the step (`flushWrite`) may write the day note
  like a direct turn's. The step counts as saved only when its run completed after the
  write guard admitted at least one of its memory writes (or its flush's write,
  `MemoryStepWrites`); a completed run whose writes were all refused, or that wrote
  nothing, reports `unwritten` and leaves `memoryNotSaved`. The chat offers no **Try again** on a failed or stalled step
  and keeps showing that memories are saved while the step's outcome is uncertain.
- **Summarising status.** A long conversation makes OpenClaw shorten its history
  before it answers, which can take minutes. The pinned runtime signals it on the
  source session with Gateway `agent` events: before a run (preflight,
  `runSessionCompactionIfNeeded`) `run_status` / `memory_flushing` for the flush,
  then `preparing_context` when the flush ends and the compaction model call
  follows, then `preparing_workspace` for the run itself; inside a run the
  `compaction` stream with phase `start` and `end` (`willRetry: true` keeps it
  going). OpenClaw has no own run status for the compaction call
  (`preflight_compacting` stays internal), and a preflight compaction without a
  memory flush is not signalled at all. `Compactions` (`compactions.js`) follows
  these events per session with the run id; `lifecycle` `end` or `error`, and any
  event of another run on the session (the end of a cancelled or dead run may be
  lost), ends it, a reconnect clears it and a status older than an hour expires on
  the next event or read. Only a start or end of a known conversation's compaction
  publishes `change`; the history carries `compacting: true` only while that run is
  the conversation's active attempt (its id or `runtimeRunId`), and the chat then
  shows "Summarising the conversation so far — this can take a few minutes for long
  chats." in the run
  line and "Summarising conversation" in the header. The finished compaction is a
  system message `__openclaw.kind: "compaction"` with `tokensBefore` and
  `tokensAfter` in `chat.history`; the chat history (and its cache) turns it into a
  note `compaction:<id>` at that place, which the chat shows as "Earlier messages
  were summarised (about N k → M k tokens)." Readers of replies (Telegram delivery,
  team results) take assistant turns only, and AgentPier never sets
  `agents.defaults.compaction.notifyUser`, so Telegram receives nothing.
  `assistant-compaction-contract.test.js` checks on the pinned runtime that the
  status covers the flush and the summary calls but not the answer, and that the
  marker carries both token counts. OpenClaw's compaction safeguard checks every
  summary for its required sections (decisions, open to-dos, constraints, pending
  asks, exact identifiers) and the latest ask. On 2026.10.7 a compaction that splits
  a turn makes two summary calls (the history and the split turn's prefix; 2026.10.3
  made one), and a summary that fails the check is retried once, which costs two more
  model calls, and is then saved in a reduced form instead of cancelling the
  compaction as 2026.10.3 did. The chat shows the summarising status throughout
  either way.
- **No silent read-only window.** After a start or reconnect the guard reports
  within one interval (15 s). An owner or paired Telegram turn of a memory agent
  waits for it, outside the admission lock, but only until 20 s after the Gateway
  became ready (`write-guard-wait.js`); turns of one conversation keep their order
  while they wait. A guard that never reports holds no later turn: it is logged once
  per readiness, and the turns run read-only. Whether a turn ran read-only is
  decided after its apply: its `AGENTS.md` then says memory is read-only, and the
  chat shows a note.
- **Command completions (AGENTPIER-185).** An owner turn may start a long
  background `exec` (a render, a build) and end before it exits. With
  `tools.exec.notifyOnExit` (OpenClaw's default) the Gateway then runs the same
  session once more. The pinned OpenClaw 2026.10.7 sends an ordinary event turn
  (`enqueueSessionEventForHost`, source `exec`), one per process, whose prompt is
  the bare line `Exec <status> (<id8>, <exit>) :: <output>` behind OpenClaw's usual
  timestamp envelope; its hooks see `ctx.trigger: "event"`, and its agent events
  carry no mark (`isHeartbeat: false`). The rollback targets 2026.10.3, 2026.9.9 and
  2026.9.8 wake the session through their heartbeat runner instead, with a hidden
  framed prompt `[OpenClaw exec completion]` that may list several processes, and
  agent events marked `isHeartbeat: true` (`heartbeat-runner-run`,
  `internal-turn-source`). Both write the completion's user entry with the input
  provenance `{ kind: "internal_system", sourceTool: "exec" }` and
  `senderIsOwner: false`. That run has no AgentPier attempt, so every `write` and
  `edit` used to be refused and the agent asked the owner to type "continue". `exec-continuation.js` lets such a run
  write, use project-folder file actions and share files with the rights of the turn
  that started the command, only when AgentPier proves all of this:
  - The session is a chat of the calling agent, which is not archived and no
    temporary task member.
  - The chat's latest ledger request (`latestRequest`, one row) is a completed turn
    that continues the owner's own work (`continuedTurn`): a direct turn
    (`directTurn`: the owner, his paired Telegram chat or a restricted user still on
    the agent, read live, never forwarded; a work-goal continuation is recorded as
    the owner's), or a lead's follow-up on its member's result (`member-result`,
    proven by `resultTurn` as for that turn's own writes, on the lead's own grants
    only; AGENTPIER-237). It started at most two hours ago
    (`continuationWindowMs`, four times OpenClaw's default exec timeout of 30
    minutes), and no newer request exists.
  - The call names its run: the write hook's `runId`, or for `agentpier_workspace`
    and `agentpier_share_file` the run of its tool call (looked up by session and tool call id). A call without
    a run continues nothing. The run is not that turn's own run, and
    `CompletionRuns` (cleared on every reconnect and at the run's `lifecycle` end)
    knows it as a completion run in this session in one of two ways:
    - **Heartbeat run** (rollback targets): the Gateway's `agent` events mark it
      heartbeat-driven (`isHeartbeat`). The run is hidden from the Control UI, so
      these events arrive only through the chat's `sessions.messages.subscribe`.
    - **Event turn** (2026.10.7): the plugin recorded the run's prompt under
      `ctx.trigger: "event"`, which only OpenClaw's own session events set (a typed
      message is `"user"`, and a user turn records nothing), and sends it marked
      `internal`. Because that trigger is not exec-specific, AgentPier then reads
      the session's transcript once per run (`sessions.get`, 200 entries, 5 s;
      concurrent calls of the run share the read). The run's first record (the
      assistant message holding its tool call, annotated with its run id) must be
      directly preceded by a user entry without another run's id whose provenance
      is exactly `{ kind: "internal_system", sourceTool: "exec" }` and whose
      process lines equal the plugin's. The entry carries no run id or other key
      that names the run, so this positional match is the link. A Gateway error, a
      missing, foreign or non-adjacent entry, other provenance or other lines
      refuse with `NOT_COMPLETION`; a run that ended during the read is not
      admitted. Only a verified run enters `CompletionRuns`, and the whole proof
      then runs again.
  - The run's completion names only processes that this turn started in the
    background. OpenClaw names a process by an adjective-noun slug that is unique
    only among live processes, numbered on a clash, and its completion prompt
    reports only the first eight characters (`Exec <status> (<id>, <exit>)`). Many
    processes can therefore share what the completion reports. The proof needs the
    session's every background process with its full id and starting run, and the
    transcript cannot give that for a long chat. The AgentPier plugin keeps the
    Gateway's own record instead (`team-plugin/exec-processes.js`, on
    `globalThis`, so a plugin reload keeps it). `after_tool_call` records each
    `exec` result with `status: "running"` (`details.sessionId`) and the run that
    started it. A Code Mode cell is named `exec` too but runs no command itself;
    only `before_tool_call` names its kind (`toolKind: "code_mode_exec"`), so the
    plugin recognises its result by the call and never records it (a cell that
    awaits a nested call reports `status: "waiting"`, which would otherwise leave
    the session uncertain). Each command a cell starts reports as a nested `exec`
    call of its own. `llm_input` records the completion run's prompt in one of two
    shapes: 2026.10.3's framing, where every line between OpenClaw's completion
    text and "Treat this completion" must be a process line; or 2026.10.7's bare
    shape, only under the `event` trigger, where after the optional timestamp
    envelope every non-empty line must be a process line or, once after one,
    OpenClaw's verbatim timeout guidance. The write hook and the workspace call send
    the record for the run. Every process whose first eight characters equal a
    reported id must belong to that turn's run, and at least one must; a shorter id
    must equal a whole id. A completion that batches an earlier turn's process
    with this turn's (OpenClaw can deliver one again when an owner message arrives
    during its run) is therefore refused.
  - The record is complete. It must exist before `gateway_start`; one that appears
    later may have missed processes. A result with a known end status (`completed`,
    also with a non-zero exit code, `failed`, `denied` and other refusals) left
    nothing running, although OpenClaw also reports it to the hook as an error.
    OpenClaw keeps its own "not started" mark private, so any other errored `exec`
    call counts as having started nothing only when its whole message is one
    OpenClaw raises before a command can start: argument validation
    (`Validation failed for tool "exec":`) or the exec host checks it marks not
    started (`exec host not allowed …`, the sandbox requirements). Any other error
    leaves the session uncertain, because OpenClaw can report an error after the
    command already went to the background (an abort after the yield).
    Each bound fails closed for one session only:
    - A process leaves the record only when its end is positively observed, never
      by its pid. OpenClaw's exec session and its completion last until the
      command's output closes, so a shell that exits while `cmd &` runs on is still
      live. An end is observed when a completion run lists a prefix that only one
      recorded process of the session carries, counting ended ones and those just
      removed. A completion can still be delivered after the process tool showed
      that end. The end is also observed when the process tool reports the process
      finished by its whole id (whatever shares its prefix), or when its own bound passed: the call's `timeoutSeconds` above
      zero plus ten minutes. A process leaves two hours after its end or at its
      bound. It then stays a candidate under its prefix, with the run that started
      it, for two more hours, so a late completion is judged against it. A process
      without a known end or bound stays: a silent success with no timeout that is
      never polled keeps refusing other runs' completions with its prefix in that
      session.
    - A session is uncertain for the Gateway's life after more than 4,096 live
      processes, after an `exec` result that is neither running nor a known end (an
      approval may still start a command), or after a run that ended with an `exec`
      call that never reported a result. It is also uncertain when more than 1,024
      `exec` calls are open across the Gateway and its call is forgotten.
    - A session with nothing left (no process, no candidate prefix, not
      uncertain) is removed. Past 4,096 sessions those go first, then the least
      recently used one without a recorded process, then the least recently used
      one; a forgotten one is remembered as described next.
    - Past 4,096 sessions the least recently used one is forgotten. Its key goes
      into a bit filter, so that session, and the rare one sharing its bits, stays
      uncertain; every other chat keeps working.
    - While an `exec` call is still open in the session it is not complete either.
      A call counts as open only once every other `before_tool_call` hook let it
      through (the plugin registers it last), and a blocked call's result
      (`status: "blocked"`) closes it.
    - Only completion runs' model input is kept, and only until the run ends.

  `llm_input` and `agent_end` are conversation hooks: the compiled config grants
  the plugin `plugins.entries.agentpier-teams.hooks.allowConversationAccess`
  (`runtime-config.js`). A foreground exec, the command of an earlier forwarded,
  routine or delegated turn, an approval's command (`Exec finished (gateway id=…)`),
  a completion without a readable process list (delivery off, only empty
  successes, a truncated list; OpenClaw's fixed timeout guidance after a process
  line is read verbatim), a heartbeat poll, a reminder and a completion after
  a newer request stay read-only. So does every completion of a lead-request,
  team-member, forwarded, routine, team-result, coding-result or memory-result
  turn, and of any other turn without the owner's own work behind it (a webhook or
  hook run, a reminder, a check-in). Only a 2026.10.7 event turn makes the proof read the transcript, once per
  run; the heartbeat path and owner writes never do. A refusal of a completion run
  (heartbeat-driven, or marked as an event turn) in that session is logged once per
  session, run and reason with a code such as `PROCESS` or `NOT_COMPLETION`, never
  a path or the command's output; an ordinary refused write elsewhere logs nothing. Each write keeps the
  turn's limits (a shared agent's memory note, `USER.md` and instruction files) and
  is audited as `kind: "native-write"` with `via: "exec-completion"` and
  `sourceAttemptId`. `agentpier_workspace` follows the same rule for project-folder
  file actions only. Folder changes are audited the same way. `agentpier_share_file`
  follows the same rule with the share's own file checks (workspace or granted
  folder, 25 MiB, link-safe open); its `assistant.sent` event adds
  `via: "exec-completion"` and `sourceAttemptId`. Coding requests,
  project memory, SSH, team tools, grants and routines are refused, and the
  command's output never proves an owner request.
  On 2026.10.7 `chat.history` also returns the completion's user entry, which
  2026.10.3 hid. The chat history (`conversations.js`) never serves a user entry
  whose provenance kind is `internal_system`, whatever its source tool (OpenClaw's
  task, plugin and session events use the same kind), so it never appears as the
  owner's words; the completion run's reply is shown as before.
  `tests/integration/assistant-exec-continuation-contract.test.js`
  (`AGENTPIER_SHELL_CONTRACT_RUNTIME`) pins this against the pinned runtime (it
  also passed on 2026.10.3):
  - the hooks report each background process with its run, the completion's
    prefixes and `gateway_start`;
  - on 2026.10.7, the completion's transcript entry directly precedes its run's
    first record and carries no run id;
  - the completion's write continues the owner turn, after an exec call of that
    turn failed argument validation;
  - a blocked exec call leaves nothing open, and the next completion is credited;
  - a backgrounded shell that exits at once while its child keeps the output is
    still credited when the child ends, although its pid is gone;
  - an exec error OpenClaw does not mark as before the start (a node host check)
    leaves the session uncertain, so its completion is refused;
  - the same completion stays refused after a newer forwarded request or past the
    window;
  - a forwarded turn's background command that completes after an owner turn's
    foreground exec is refused;
  - a completion run's workspace call names its run and is bound;
  - a completion run's `agentpier_share_file` call names its run, is bound and
    shares the file (AGENTPIER-237).

- **Visible refusals.** A refused write to `MEMORY.md` or `memory/` records one
  chat note per turn and reason (`memory-notes.js`, table `assistant_memory_notes`,
  newest 100 per conversation): forwarded content, a scheduled or automatic turn,
  a lead's task, another non-owner turn, a memory step's write outside its own
  memory, or a refused flush. A refused flush also logs one line per flush session
  with its time (ISO), code (`FLUSH_SHAPE`, `FLUSH_DATE`, `FLUSH_ORIGIN`,
  `FLUSH_UNREPORTED`, `FLUSH_SESSION`), path, session key and run id, never its
  content. A refused flush the
  Gateway did not report (for example after a runtime change renamed the event) is
  attributed to the agent's single active owner turn, so it never goes unnoticed.
  The chat renders them as quiet lines ("Memory not saved: …"). A run without an
  attempt (a command completion that does not continue its turn, see above) records
  no note; the agent receives the guard's refusal.
  A declined, expired or failed project knowledge write (`memory_write`) hands one
  attributed follow-up turn (`memory-result`) to the requesting agent's
  conversation, so the agent can correct an earlier claim
  ([agent workflows](assistant-workflows.md)).

### Reminders

Enable **Allow reminders and routines**; no Telegram chat is needed. Request a
reminder in chat or create a one-time/daily reminder under **Automation** in
its settings. One-time
form values use the browser's displayed local timezone; daily schedules carry an
explicit IANA timezone. Native OpenClaw handles scheduling and timezone calculation.
The UI lists native state, next execution, run history and, for a reminder that also
goes to Telegram, separate Telegram outbox delivery status, with pause/resume, remove
and **Also send to Telegram** controls.

Every reminder, routine and check-in delivers to the agent's main chat: the person's
main AgentPier conversation (`channel: "agentpier"`, `main: true`, the one
`openConversation` returns and creates on first use, `mainConversation` in
`server/features/assistants/routine-targets.js`); further chats get none of them. A
Telegram pairing writes into that same conversation, so a paired agent's main chat is
its Telegram conversation. Creating a reminder or routine opens the main chat when the
agent has none yet; the binding stores it as `target` (`conversationId`,
`sessionKey`). A reminder runs isolated and tool-less; its text is recorded for the
chat (`assistant_routine_results`, kind `reminder`), which shows it as a message
marked "Scheduled · <name>", and a failed run as a quiet line. Routine and check-in
results instead leave the transcript for the main chat's **Events** area (the
history's `events`, `server/features/assistants/agent-event-area.js`). Every recorded result also
sends an `agent-routine` push notice that names only the agent and the conversation
it opens (`/agents/<id>/chats/<conversationId>`); a replayed completion sends none.

Telegram is an optional extra per binding (`telegram`: the paired chat's
`channelId`, `chatId` and `userId`, or `null`). It is on by default only for one
asked for from Telegram (and for a task member's reminder when its lead has a paired
chat); the settings and `PATCH` with `{ telegram, revision }` switch it, and
switching it on needs a paired chat (`reminderChannelRequired`, 409). The agent's own
`agentpier_reminder` and `agentpier_routine` tools take an optional `telegram`
boolean on `create` and `update` (AGENTPIER-195): only in a direct turn of the person
whose binding it is (`turnAudience`: an owner, Telegram or user turn that was not
forwarded), from any of her chats; scheduled, forwarded and member turns are refused.
`true` binds that person's paired, enabled chat (`pairedChannel`, or the Telegram turn's
own chat), never one the agent names; without one the tool fails with
`TELEGRAM_NOT_CONNECTED` (`reminderChannelRequired`), or, for a user who cannot pair
one there (a shared agent, or below Extended on her own; `canPairTelegram`),
`TELEGRAM_UNAVAILABLE` (`reminderTelegramUnavailable`). A replayed create finds its
binding by creation key before resolving the chat. `false` switches it off; without
the parameter creation keeps the default above and an update keeps the setting. A task
member's reminder never takes `telegram`; it follows its lead's paired chat. The Telegram
outbox is used only while it is on and that chat is still paired and enabled;
switching it off also holds back queued Telegram output. Unpairing never pauses or
removes a reminder or routine. Bindings stored before chat delivery kept their chat in
`source` and keep delivering there (`telegramOf`).

`agentpier_routine` also takes an optional `writes` boolean on `create` and `update`
(AGENTPIER-199), the routine's **May write** (`routineWrites`). It follows the
`telegram` rules for the turn (`turnAudience`: scheduled, forwarded and member turns
are refused with 403) and, like the settings, is the owner's alone
(`NativeRoutines.mayWrite`): a user's turn, or a turn on a user's own agent, fails
with `ROUTINE_WRITES_OWNER_ONLY` (`routineWritesOwnerOnly`, 403), even for `false`.
On `create` it is stored with the binding, so a replayed create returns the existing
routine as it now is; on `update` it goes through `setWrites`. Both are audited as
`kind: "routine-writes"` with `actor: "assistant"` and `channel: "tool"`. Without
the parameter a new routine stays read-only and an update keeps the setting. A lead
never sets it on its members' routines (`agentpier_team_member_routine` has no
`writes`).

The `agentpier_reminder` tool is a thin authorized adapter to native
`cron.add/list/update/remove`; it does not implement scheduling. Chat mutations
require a current owner/Telegram turn, in the web chat as well as in Telegram. Creation keys bind the attempt and tool call;
the UI retains its creation key across retries of an unchanged form. Source bindings
store an agent, its target chat, an optional Telegram destination and operation
identity. Native jobs use a stable `declarationKey`; the pinned Gateway
returns declaration-based creation as `{ created, job, deliveryPreview }`.

Preparation failures can retry before submission. After uncertain submission,
recovery searches by the declaration key and never blindly creates another job.
Unresolved items remain visible for inspection/removal. Pausing and removing revoke delivery
before the native mutation, including lost acknowledgements, queued output and late
completion reconciliation. Only confirmed explicit resume restores paused delivery. Disabling reminders or archiving a permanent member/team
pauses its native jobs; restoring or re-enabling does not automatically resume them.
Runtime stop/restart refuses active native scheduled turns as well as chats. The
check reads every cron job of every agent (`cron.list` without an agent), so
check-ins, a lead's routines and jobs an agent created itself count too, not only the
reminders and routines AgentPier bound.

A private loopback receiver keeps its port and bearer token in
`assistants/reminder-webhook.json` across full application restarts; runtime updates
and rollbacks leave it in place. Host backups leave it out on purpose, because it holds a bearer secret bound to this host's port: a
restored data directory starts a new receiver, and reminders created before the
backup still name the old address, so delete and create them again after a host
restore. An occupied saved port
fails startup rather than silently changing job destinations. Incoming completions
must match the bound native job; job ID plus `runAtMs` deduplicates durable outbox
handoff. A changed Telegram pairing cannot redirect an existing reminder. The
browser receives no webhook credentials, native destinations or raw diagnostics.

Scheduled reminders have an empty tool allow-list and only return reminder text;
they do not initiate teams or service mutations. The model account and Gateway must
be available. Saved-prompt routines and manual/coding-completed events are now described in
[agent workflows](assistant-workflows.md). Service actions remain deferred. Native DST and extended downtime behavior are
covered by [schedule qualification](assistant-routine-qualification.md). Native webhook acknowledgement is
durable transfer into AgentPier, not Telegram delivery acknowledgement.

### Product qualification

The actual managed product configuration passed against pinned OpenClaw 2026.9.8
on macOS arm64 with a real ChatGPT account in disposable state:

- Agent-written synthetic memory, native read/edit/search and fresh-conversation
  recall after Gateway restart.
- Conversational native reminder creation, restart before its deadline, scheduled
  execution and exactly one acknowledged send through the existing Telegram
  adapter using a simulated transport.
- Native daily creation, pause and removal, plus full application restart with the
  same webhook endpoint, retained memory and no replay of completed delivery.

No synthetic personal Telegram messages were sent. Regression tests cover native
response shapes, stale note writes, repeated/lost acknowledgements, original source
binding, delivery deduplication, capability isolation and archival. Independent
review findings for late removal reconciliation, retryable preparation and archived
schedules were reproduced, fixed and rechecked without remaining blockers.

Historical product-stage validation: `npm run check` passed with 3,518 tests passed, 18 conditional skips and
zero failures. The relevant assistant suites passed 23/23 in Chromium and 23/23 in
WebKit; the new memory/reminder settings flow also passed on a 390-pixel viewport
in both engines after the final layout adjustment. All disposable qualification
state and copied credentials were removed after stopping the owned runtimes.

For the later merged branch, see the [release qualification](assistant-release-qualification.md).

## Web, browser and document capabilities (2026-10-11)

Agent settings group six more switches under **Web & documents**. All default to
off. Like memory and reminders, they are set only on permanent agents; archived
agents do not count. Task-scoped team members have no switches of their own and use
what their lead grants them (see [Team member grants](#team-member-grants-2026-10-17)).
The tools exist only in team mode (native teams), where AgentPier compiles them into
the Gateway's startup configuration.

| Switch             | Grants           | What it does                                                                                                                                                                                                            |
| ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search the web** | `web_search`     | Searches with the provider chosen under **Connections › Services for agents › Web search**                                                                                                                              |
| **Read web pages** | `web_fetch`      | Fetches a public address and reads its text; private, loopback and internal targets are refused                                                                                                                         |
| **Use a browser**  | `browser`        | Drives a separate, headless browser profile owned by AgentPier                                                                                                                                                          |
| **Read images**    | `view_image`     | Looks at images in the workspace, and with `image_view` in granted project folders; needs a model that accepts images                                                                                                   |
| **Read PDFs**      | `pdf`            | Reads workspace PDFs with the agent's own model, or the optional fallback under **Connections › Services for agents › PDF reading** when that model does not accept images (see [PDF reading](#pdf-reading-2026-10-19)) |
| **Create images**  | `image_generate` | Creates and edits images with `openai/gpt-image-2` through a signed-in ChatGPT account (see [Image generation](#image-generation-2026-10-18))                                                                           |

Web content is untrusted data. OpenClaw wraps fetched and browsed content as
external content, and the switches do not grant any other tool.

### PDF reading (2026-10-19)

**Read PDFs** (`readPdfs`, off by default, also grantable to task members within their
lead's own switch) offers OpenClaw's `pdf` tool. Since AGENTPIER-218 an agent reads
PDFs with its own model when that model accepts images. OpenClaw 2026.10.7 still takes
the model that reads a PDF only from the global `agents.defaults.pdfModel`: an agent
entry with its own `pdfModel` (or `imageModel`) is rejected as an unrecognized key, and
without an explicit model the tool picks the first image-capable provider it finds
among all configured ones (the agent's own model comes last), which need not be the
agent's own. AgentPier therefore never lets the tool choose:

- **The global model is always explicit.** A start that offers `pdf` writes
  `agents.defaults.pdfModel` as `{ primary, fallbacks: [] }`
  (`AssistantProviderSynchronization.preparePdf`): the owner's optional fallback model
  with its provider entry, or the placeholder `agentpier-unavailable/blocked`, which
  names no configured provider. An explicit model turns OpenClaw's own choice off; the
  placeholder fails with `Unknown model` and no other model is tried.
  `agents.defaults.pdfModel` is compiler-owned and locked for advanced settings.
- **The tool guard names each call's model.** The team plugin's `before_tool_call`
  hook (`pdfCall` in `team-plugin/tool-guard.js`) asks the bridge (`/pdf-policy`,
  `PdfPolicy` in `pdf-policy.js`) and sets `model` on every call: the agent's own
  model when it accepts images (`AssistantModels.imageInput`, the same facts its
  compiled provider declares), otherwise the fallback the running Gateway was started
  with, otherwise the agent's own text-only model. A `model` the agent passes is
  replaced. OpenClaw then reads with that model and no fallbacks, never with another
  provider. Without an answer (an agent that may not read PDFs, an unknown agent, an
  unusable model, the bridge away) the call is refused; an agent whose own model takes
  images but is unusable right now is refused too, not passed to the fallback. The reference is resolved like the agent's live
  apply, so it names the provider the Gateway runs; an agent's model change applies
  to its PDFs with the same live apply.
- **Fallback:** **Connections › Services for agents › PDF reading** optionally chooses a
  fallback model connection (OpenRouter, a custom endpoint or a ChatGPT account) and
  one of its models for agents whose own model does not accept images. Only ids are
  stored (`assistants/pdf-model.sqlite`); the key stays with the model connection.
  Choosing, changing or removing it while an agent reads PDFs needs a
  [pending restart](#pending-restart); until then the started fallback stays in use.
  Editing or deleting the fallback's connection counts as a change for every agent
  that reads PDFs.
- **Text only:** pages with little text reach a model that accepts images as rendered
  page images. A text-only model (an agent's own without a fallback, or a text-only
  fallback) gets the extracted text only (OpenClaw drops the images), so it cannot
  read scanned pages or pages without text, and a PDF without any extractable text
  fails. The PDF reading page says so for a text-only fallback.
- The switch is effective while the runtime bundles OpenClaw's `document-extract`
  plugin; it no longer needs a fallback. A start adds `pdf` to the global
  `tools.allow` and `document-extract` to `plugins.allow` (without it the tool refuses
  every PDF a non-native model reads). Like image creation, `pdf` waits for the proven
  tool guard, so switching it on for an agent applies live.
- The guard also refuses any reference with a scheme (`http(s)`, `file:`, `media:`):
  PDFs come from the agent's workspace (`tools.fs.workspaceOnly`), never from the web.
- The native contract `assistant-pdf-own-model-contract.test.js` pins this on the
  pinned runtime: the guard's model reads (page images for an image model, text only
  for a text-only one) while the agent names another, the placeholder reaches no
  configured model (an image-capable decoy provider included), a refused call reaches
  none either, and a started fallback reads for the text-only agent. Integration tests
  pin that the guard's reference equals the one the start compiled and that a provider
  change waiting for its restart names an unknown provider (the call fails).
- **ChatGPT accounts:** the reference names the account
  (`openai/<model>@<profile>`), but OpenClaw 2026.10.7 drops the profile when it
  resolves the pdf tool's model and reads through the `openai` provider without it.
  Like [image generation](#image-generation-2026-10-18), with several signed-in
  ChatGPT accounts any of them may read the PDF. The ChatGPT read path is not
  qualified natively (it needs real accounts).

### Image generation (2026-10-18)

**Create images** (`createImages`, also grantable to task members within their lead's
own switch) offers OpenClaw's `image_generate` while a ChatGPT account is signed in
(`AssistantModelAccounts.imageReady`: an `openai` OAuth profile with status ok or
expiring). Only then does the startup configuration add `image_generate` to the global
`tools.allow` and set `agents.defaults.mediaModels.image` to
`{ primary: "openai/gpt-image-2", timeoutMs: 180000 }` (compiler-owned: a stale image
model is removed). OpenClaw 2026.10.3 then routes the request through that OAuth
profile and the Codex Responses backend, not an API key. Like the web tools this is a
startup section, compiled with a ready account before any agent uses it: switching
it on applies live. An account signed in after the start takes effect at the next
restart, which an agent switching it on then leaves [pending](#pending-restart). Without a ready account (its last
known status, also while the service is away) the switch is disabled with a hint; the
agent's AGENTS.md mentions images only while it can create them.

With several ChatGPT accounts, OpenClaw picks the profile for an image request by its
own order for the `openai` provider (a stored order override, then `auth.order`, then
its default order), not by the account the agent chats with: the order is global, so
AgentPier cannot pin it per agent without changing it for every agent. Use one ChatGPT
account for image creation, or expect any signed-in one to be used.

Like the browser, `image_generate` is offered only while the plugin's tool guard is
proven, and every call passes its `before_tool_call` hook (`imageCall` in
`team-plugin/tool-guard.js`, `ImagePolicy` in `image-policy.js` through the bridge's
`/image-policy`):

- the calling agent must hold **Create images** now (its own switch, or its lead's
  grant for a task member);
- `model` may only name `openai/gpt-image-*`;
- a reference image with a scheme (`http(s):`, `file:`; inline `data:` stays local)
  needs **Read web pages** as well, since OpenClaw fetches web references itself and
  the tool would otherwise carry data out; local references come from the workspace
  and OpenClaw's shared media folder (`tools.fs.workspaceOnly`);
- there is no daily limit: each generation (status and list reads aside) writes an
  `assistant.executed` audit event with `kind: "image-generation"`, never the prompt.
  Databases from earlier versions keep their unused `assistant_image_usage` table.
  Refusals reach the model with a reason it can act on. An unavailable tool is to be
  reported plainly in the chat, never with "tell the owner": on an agent of users the
  person in the chat is a user. Its bootstrap likewise says the image goes to the
  person who asked for it, not to the owner.

`image_generate` runs in the background: its completion turn writes an assistant
message whose content carries `{ type: "image", artifactId:
"artifact_managed_image_<uuid>", alt, mimeType }`, and the image itself stays in
OpenClaw's managed media (`state/media/`). AgentPier copies every such image once into
the chat's share store (`GeneratedImages`, `generated-images.js`), after each finished
run of the conversation and on every history read: `artifacts.download` answers with
a short-lived ticketed path under `/api/chat/media/outgoing/`, which AgentPier reads
from the Gateway's own HTTPS origin with the pinned certificate
(`GatewayClient.download`, at most 25 MiB), keeping only bytes that prove to be an
image. The copy appears as an agent message at the time of the completion, can be
deleted by the owner and expires like any shared file. The completion's run id names
the background task, and so does the tool result of the turn that asked for it, so
the image follows that turn: to the lead's chat for a member, and to the paired
Telegram chat as a photo when the turn came from there. A routine's own run session
(`agent:<id>:cron:<job>:run:<run>`) copies into the chat its routine commits to and
to the Telegram chat it delivers to. Only images of an agent that may create images
are copied; each page read covers the newest 50 messages. A passing failure is
retried after 1, 2, 4 … minutes, at most an hour; an artifact the Gateway no longer
holds, one above 25 MiB or bytes that are no image end permanently: the chat shows the
image as no longer available. Each copy writes an `assistant.sent` audit event with
`kind: "generated-image"` (outcome `failure` for one that could not be kept).

The opt-in contract `tests/integration/assistant-image-contract.test.js`
(`AGENTPIER_IMAGE_CONTRACT_RUNTIME`) runs the pinned runtime with AgentPier's compiled
configuration and a local fake of the OpenAI Images API (OpenClaw's QA switch
`OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER` admits the loopback endpoint) and verifies the
tool, the completion message and the copy into the chat. It uses an API-key route: the
ChatGPT OAuth route through the Codex backend is not qualified without a real account.

### Managed agent browser

**Install browser** in an agent's **Agent browser** settings (shown while no separate
browser app is there) and the **Chrome for Testing** card on the dashboard install a
pinned [Chrome for Testing](https://github.com/GoogleChromeLabs/chrome-for-testing)
build without Homebrew or administrator rights (`server/features/tools/`
`chromium-installer.js`, `chromium-manifest.js`):

- The version and, per platform (`mac-arm64`, `mac-x64`, `linux64`, `linux-arm64`),
  the download URL, size and SHA-256 are pinned in `chromium-manifest.js`. Chrome for
  Testing publishes no checksums, so they were computed from the downloads when the
  version was pinned. Downloads come only from `storage.googleapis.com` over HTTPS,
  without redirects; size or hash mismatches fail before anything is unpacked.
- The archive is unpacked into `<data>/clis/.packages/chromium-<id>`, keeping file
  modes and the app bundle's relative links. `..` entry names, names that differ only
  in case, special files, absolute links and links leaving the browser folder are
  refused; no entry is written through a link unpacked before it; and once all are
  unpacked, every link must resolve (`realpath`) inside the browser folder, so a chain
  of links that leaves it together is refused as well. `<data>/clis/chromium` links to
  the active version and is switched atomically.
- macOS: AgentPier clears extended attributes (`xattr -cr`), so a quarantine flag
  never blocks the service. Chrome for Testing is only linker-signed (ad hoc, no sealed
  resources), so `codesign --verify` refuses even an untouched copy; the pinned
  SHA-256 is the integrity check.
- Every platform: `--version` must report the pinned version, and a short real start
  (`--headless=new --dump-dom about:blank` with a temporary profile, the sandbox on)
  must render a page. The sandbox is never switched off.
- Linux: `ldd` must resolve every shared library; missing ones are named in the
  error, for the owner to install with the package manager. Where the start fails and
  `kernel.apparmor_restrict_unprivileged_userns` is 1 (Ubuntu 23.10 and later), the
  error says the sandbox is blocked and points to [linux.md](linux.md).
- A full disk is reported as such. A server start sweeps an interrupted install's
  work folders and never-published version directories while no job runs; one
  process prunes at a time (the server runs one job, the installers hold the setup
  lock before the service starts).
- Detection compiles the versioned real path, so an install, update or removal
  changes the browser block. The agent settings then offer **Restart agent service**
  (`restartNeeded` in `GET /api/assistant-runtime`), with the usual confirmation; an
  agent switching its browser on meanwhile leaves a [pending restart](#pending-restart).
- The dashboard card shows the installed version, **Update browser** when the
  pinned version is newer and **Remove** (`DELETE /api/tools/chromium`). Removal is
  refused (409) while an agent browser runs or the running agent service was started
  with the managed browser; stop the agent service first. An update keeps the
  previous version until the next install, so a browser still running from it is not
  pulled away.

Update path: raising the pinned version in `chromium-manifest.js` ships with an
AgentPier release. At the next server start an installed managed browser is updated
in the background (`ToolInstaller.keepChromiumCurrent`), and the installers
(`--with-agent-browser`, or any installer run on a host that has it) bring it to
the pinned version as well (`chromium-provisioning.js`). Without a managed browser
nothing is downloaded.

### Browser isolation

On request AgentPier installs its own agent browser (see "Managed agent browser"
below). `detectBrowser()` prefers that managed build, then looks in the platform's
standard locations for a browser app of the agents' own (Brave, then Chromium, then
Chrome for Testing) before Chrome, Brave, Edge or Chromium in general; the compiled
`browser` block names that one executable for every agent profile, so a profile is
always opened by the same app. The block:

- uses only OpenClaw-managed profiles (`driver: "openclaw"`). OpenClaw's implicit
  `user` profile (which attaches to the signed-in system browser) and `chrome`
  profile (extension relay) are redefined as managed profiles on their own CDP
  ports, so no profile name reaches the owner's browser;
- gives every permanent agent with **Use a browser** a persistent profile of its own,
  `agent-<id>`, with its own CDP port from Gateway port + 20. Logins and cookies
  survive restarts. Temporary team members borrow one of three member slots
  (`member-1` to `member-3`, or `member-visible-1` to `-3` when their lead's
  window is visible); AgentPier discards a slot's data when the member ends, and a
  promoted member takes it along as its own `agent-<id>` profile. Slot data no member
  holds (for example after AgentPier restarted) is discarded too;
- keeps the profile data in the Gateway's state directory
  (`assistants/state/browser/<profile>/user-data`), never in the owner's browser
  profile;
- sets `allowSystemProfileImport: false`, so the agent cannot copy cookies from a
  system browser profile, and `evaluateEnabled: false`;
- runs every profile `headless` unless the owner switches on **Visible browser** for
  the agent (**agent settings › Capabilities › Agent browser**). A visible window needs
  the separate agent app and a display; with only the owner's Chrome, or on Linux
  without `DISPLAY`/`WAYLAND_DISPLAY`, the profile stays headless and the setting
  says why. AgentPier passes `DISPLAY`, `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` to
  the Gateway when they are set; it provisions no Xvfb;
- passes `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`
  and `--disable-background-timer-throttling` through the global `extraArgs`
  (`antiThrottlingArgs`, since AGENTPIER-240): a visible window the owner keeps
  behind others would otherwise count as occluded, its renderer would lose priority
  and its timers would be throttled, and every snapshot or click then outlasts
  OpenClaw's 20-second browser budget. Headless browsers are unaffected;
- passes `--use-mock-keychain` through the global `extraArgs`. OpenClaw otherwise
  uses the macOS keychain for a new profile it launches visibly, which can prompt the
  owner from the service context. The cookies of every profile are then encrypted with
  Chromium's fixed mock key, as they already were for OpenClaw's headless profiles,
  so the profile folders count as credentials (see backups below);
- sets no `ssrfPolicy`: OpenClaw's default already blocks loopback and private
  networks, while an explicit `dangerouslyAllowPrivateNetwork: false` would make every
  navigation fail. `browser.noSandbox` is never set.

The team plugin's `before_tool_call` guard asks AgentPier (`/browser-policy`, in
`agent-browsers.js`) before every browser call. The answer pins the call to the
calling agent's own profile on the Gateway host, whatever profile the model named,
and refuses `importprofile` in any spelling; without an answer the call is refused.
Like guarded writes, the `browser` tool is offered only once the Gateway's tool guard
has reported (`guardGatedTools`); a fresh start compiles it out and the guard's report
brings it back (`write-guard-reapply.js`), also after a reconnect that lost the guard.
Owner turns of a browser agent wait for the guard like those of a memory agent, and
the runtime status reports `WRITE_GUARD_PENDING` meanwhile. AgentPier also keeps the
limits:

- at most three visible agent browsers run at once. A fourth stops the least recently
  used one that is not busy; a browser is busy while it was used in the last five
  minutes, while its agent has a run in progress, or while the owner has one of its
  windows open (at most an hour after its last use, as for the idle stop). With all
  three busy the call is refused with a message the agent
  passes on. Only calls that can launch a browser count: `status`, `profiles`,
  `doctor` and `stop` never start one;
- AgentPier watches each browser it saw launched on its CDP port. A browser that
  ended (a stop elsewhere, a crash) no longer counts, and the next launching call
  watches the new one. A Gateway reconnect keeps the tracking; a failure or a new
  start drops it;
- a browser unused for 15 minutes is stopped (`browser.request` `POST /stop`), unless
  the owner has one of its windows open; then it stops after an hour at the latest;
- a visible browser starts parked, not minimized (since AGENTPIER-240). A small CDP
  client of AgentPier's on the profile's loopback port (`browser-window-keeper.js`)
  moves the windows a fresh launch opens to the bottom-right corner of the screen they
  are on, read from the page's `screen.avail*`, with 40 pixels left visible
  (`Browser.setWindowBounds`; without the screen's size far beyond every screen,
  where the window manager clamps it; a Wayland session ignores the position) and
  keeps focus emulation on every page. A minimized Chromium window marks its pages hidden and stops painting
  them: on a loaded Mac with OpenClaw 2026.10.7, every snapshot of a minimized agent
  window ran into the 20-second browser budget, and without focus emulation such a
  page reports `hidden` and paints no frames at all. A parked window stays normal and visible, and the
  anti-throttling flags keep it rendering at full rate while other windows cover it.
  The keeper records each window's bounds once placed (after a short settle): a
  parked one, a later one such as a login popup (left where it opened), and those of
  a browser that was already running. A window counts as the owner's (busy) only once
  it differs from that record (moved, resized, maximized or full screen); minimized
  it does not. OpenClaw's first launch of a new profile starts a bootstrap
  browser it ends at once; the keeper then waits once for the real browser on the
  same port. The CDP port is loopback-only and unauthenticated, like OpenClaw's own.

Switching the browser on or off for an agent, or switching its window on or off,
patches only that agent's profile into the running Gateway (`BrowserProfileSync`):
the agent keeps its CDP port, a new agent takes the lowest free one, and a running
browser whose profile changes is stopped first and starts again with the new mode on
its next use. The member slots are compiled whenever the browser is. **Reset browser profile** stops the agent's browser and
deletes its profile. An archived agent keeps its profile, since archiving can be
undone, and can still reset it. While an agent's browser runs, its chat header shows
**Browser running**.

Logged-in profiles widen what a misled agent can do: a page can try to make it act on
the accounts the owner signed in to. The browser stays an opt-in per agent; sign in
only where the agent needs it, and reset the profile to sign it out everywhere. The
guard covers the browser tool only: an agent with shell access runs as the owner and
can reach every agent's unauthenticated loopback CDP port and read the profile files,
whose cookies are encrypted only with Chromium's fixed mock key.

### Browser uploads

OpenClaw 2026.10.7's browser `upload` action (and the file chooser hook behind it)
accepts only files below its own uploads folder (`<openclaw tmp>/uploads`,
`resolveUploadPaths` in its browser `paths` module) or a direct child of its inbound
media folder. Its tmp root is `/tmp/openclaw` when that is a directory of the service
user that neither its group nor others may write, otherwise `openclaw-<uid>` below the
Gateway's `TMPDIR` (`assistants/tmp`); the uploads folder is fixed, with no
configuration key that could point it at a project. Project folders and the agent's
workspace are therefore refused by OpenClaw itself, and AgentPier stages files instead
([browser uploads from folders](assistant-workflows.md#browser-uploads-from-folders)):

- `agentpier_workspace` `browser_upload_stage` resolves and opens the file with the
  project read rules and copies its bytes from that opened descriptor into
  `<uploads>/agentpier-<hash of the data directory>/<agent id>/<random>/<file name>`
  (folders `0700`, the file `0600`; `browser-upload-staging.js`). Hard links are no
  option, since a project file with a second link is refused by every read, and a
  link or a copy by path could follow a folder swapped after the check. It is always
  a real copy: the uploads folder usually sits on another file system than the
  project (on Linux often a tmpfs, which holds the copy in memory).
- Disk use is bounded: one copy runs at a time per agent, at most 8 GiB per file,
  three files per agent (a fourth replaces the oldest once it is copied) and 16 GiB
  for all agents together. A copy must leave 1 GiB free on the uploads folder's file
  system, and on a tmpfs also 1 GiB of free memory; the bytes other agents are still
  copying count as used until their copy ends. A copy still waiting for the agent's
  earlier one or still running after 270 seconds (the agent's call waits 300) is
  cancelled, answers at once and leaves nothing (`UPLOAD_TIMEOUT`), also when its
  read hangs; other agents' copies never wait for it.
- The team plugin's browser guard sends an `upload` call's `paths` along with
  `/browser-policy`, and AgentPier lets the call through only when every path names
  a file the calling agent staged itself and that is still staged (also by its real
  path, a link to it or another spelling of the folder). Everything else is refused
  before OpenClaw sees it, with a reason that names `browser_upload_stage`: another
  agent's staged file, any other file of OpenClaw's shared uploads or inbound media
  folders, `media://` references and paths anywhere else. A chat attachment is
  uploaded by staging it from the agent's own `attachments/` folder (on a shared
  agent only one sent in that chat).
- The plugin reports each upload's outcome after the call (`after_tool_call`,
  `/browser-upload`); AgentPier then records it for the agent's staged files as
  `uploaded` or `failed`.
- Staged files go when AgentPier starts and when it stops cleanly (only below
  trusted folders of the service user), after six hours, and as soon as the agent is
  archived, removed or loses **Use a browser** (a temporary member that ended too):
  every change of the agents, and a check each minute, sweeps them. The browser reads
  the file while the website uploads it, so an upload still running when its file
  goes fails; stage it again.
- Pages on loopback or private addresses stay closed to uploads as to navigation
  (OpenClaw's SSRF policy covers the page an upload goes to).

An agent with the browser uploads what it may read without asking: a page it visits
could try to talk it into uploading a file from its folders, and the audit record is
the control for that. An agent with shell access runs as the owner and can bypass all
of this.

The `browser`, `mcp`, `secrets`, `env`, `plugins` and `tools` paths are locked
against configuration overrides; the compiler rewrites the browser block on each
start and removes any `mcp` block it did not write. `channels`, `bindings`,
`session`, `commands`, `approvals`, `accessGroups` and `models.providers.deepgram`
belong to the agents' own Telegram bots and are locked as well.

Owner overrides (layer 3, `openclaw-config/overrides.js`) reach only the paths on the
allow list in `openclaw-config/advanced-settings.js`, with a value their qualified
schema accepts; every other path, including any key a future OpenClaw adds, stays
AgentPier's. Each start first removes every allow-listed path from the existing
configuration and then writes the stored overrides, so a reset override never
survives in `openclaw.json`. Stored rows that are no longer allowed or valid are
skipped and logged by path. Overrides apply only to the runtime version the allow
list was qualified against (`advancedSettingsRuntime`, 2026.10.7); a rolled-back runtime
starts with OpenClaw's defaults. After the AgentPier update that moved the approval
from 2026.10.3 to 2026.10.7, stored overrides therefore stay inactive on 2026.10.3
until the owner activates 2026.10.7, and again after a rollback before commit
(`overridesFor`, `openclaw-config/overrides.js`).
The owner edits them under **Agents › Runtime › Advanced · for all agents** (the old `/settings/assistants-advanced` opens it)
(`GET`/`PUT /api/assistant-advanced-settings`, `advanced-config.js`). Labels and help
are AgentPier's own German and English texts. A `hot` or `none` setting is patched into
the running Gateway and stored only once OpenClaw accepted it; a `restart` setting
asks the owner to confirm a maintenance restart. While the Gateway is stopped, a
saved value applies at its next start. Each stored change is audited as
`setting.updated` (resourceType `setting`, the setting's `id` as resource id) with
`details.setting`, `from` and `to`; the audit schema keeps a value only as a scalar of
that setting's own type. A change undone because the confirmed restart failed is
audited as `setting.rolled-back` with outcome `failure`.

### Live view

The owner watches an agent's own browser at `/agents/<id>/browser` (**Open live view**
in the agent browser settings, or the live preview in the chat header while the
browser runs). It is view only for now; the transport carries owner commands, so a
later takeover can send input the same way.

- `browser-live-view.js` keeps one upstream screencast per agent, shared by every
  viewer. It asks the Gateway through `browser.request` for `GET /` (does the
  profile's browser run), `GET /tabs` and `POST /screencast` on the agent's own
  profile, and opens the ticket's `wsPath` on a second WebSocket pinned like the RPC
  connection (`GatewayClient.openStream`). The upstream closes when the last viewer
  leaves.
- The ticket is single-use and valid for 60 seconds; every connection mints a fresh
  one. Close code 4004 (tab closed) reconnects at once to the browser's selected tab,
  4003 (address blocked by the navigation policy) shows "This page may not be
  shown", other closes retry after two seconds.
- Without a pick the view follows the browser's selected tab and switches when the
  agent opens or closes one; the owner can pick a tab and **Follow the agent** again.
- A stopped browser shows **Start browser**, which launches the agent's profile
  within the visible-browser limit (`AgentBrowsers.ownerStart`, with a 30-second
  budget for a cold launch). A running one shows **Stop browser** (also while no
  picture arrives), which stops the profile the view shows through the same path as
  the idle stop (`AgentBrowsers.ownerStop`, `browser.request` `POST /stop`): its tabs
  close, its profile stays, a takeover ends, and the agent's next browser call starts
  it again. While a turn used the browser within the hold (`busy` in the view's
  state) or someone holds control, the view asks first (**Stop the browser?**). A
  stop the Gateway refuses is reported ("The browser could not be stopped. It keeps
  running.") and the browser stays tracked. Like **Start browser** it is a live-view command of a viewer who may
  drive, not an audited event; a view-only viewer gets neither. A watched browser
  stays tracked, so the window keeper keeps its focus emulation; an untracked running
  one (after an AgentPier restart) is tracked again within the visible limit. Only the full live view keeps a browser from the
  idle stop, for at most an hour; the chat header's preview never does, so an open
  chat cannot keep a browser running or block another agent's.
- At most eight viewers watch one agent's browser (close code 1013 beyond). An
  upstream socket that sends no first frame within ten seconds (one that does not
  open, or one that opens but shows nothing, as after the agent restarted its
  browser) is dropped and retried; tries without a picture back off from two seconds,
  doubling up to 30 seconds, and the first frame resets the wait. A new ticket is
  minted only once the old upstream socket closed (at most a second): OpenClaw shares
  one screencast per tab and restarts it, with a first frame, only after its last
  viewer left, so a static page would otherwise stay blank; a refresh asked
  for during another (a tab pick) runs right after it. The status line of a refused
  upgrade names its status (401 Unauthorized, 403 Forbidden). A login that ends
  closes the view with 1008, and the page then stops reconnecting. A view still
  admitted, but now only to watch or now to drive, closes with 4000 and the page
  reconnects at once.
- The web app connects to `/api/assistants/<id>/browser-stream` behind the login
  and the origin check of the chat stream. The server sends JSON state messages and
  forwards OpenClaw's binary frames unchanged (a four-byte header length, a JSON
  header, the JPEG); the chat header's preview asks for one frame a second
  (`?preview=1`). A viewer that cannot keep up loses frames instead of queuing them.
  Viewers send `select`, `follow`, `start` and `stop`; anything else, and any binary
  message, closes the socket.
- Frames are never stored on disk or logged. The server keeps each stream's newest
  frame in memory and sends it to a viewer who joins, because the screencast sends a
  frame only when the page repaints (and once when it starts); a dropped upstream
  forgets it. The browser keeps only the newest as an object URL while the view is
  open, so the app's Content-Security-Policy allows `blob:` images
  (`img-src 'self' data: blob:` in `server/http/security.js`); without it every
  browser refuses the picture. The artifact viewer's policy stays without `blob:`.

### Takeover

**Take over** in the live view (or **Take over** beside the chat header's preview,
which opens the live view taking control) lets the owner use the agent's browser to
sign in, solve a check or search, and **Hand back** returns it.

- One login session of the owner holds the lease per agent (`browser-takeover.js`).
  Other devices see "You are controlling this browser on another device" and can
  **Take over here**, which moves the lease; other tabs of the same session share it.
  A chat preview never takes over or sends input. Opened with `?takeover=1`, the
  live view takes over once the picture is live and then drops the parameter.
- While the owner holds it, the tool guard refuses the agent's browser calls with
  "The owner is using this browser right now … Wait until the owner hands it back"
  (`ownerControl`). While a user holds her own agent's browser the refusal says "Your
  user is using this browser right now" (`userControl`), and while a user who drives a
  shared agent holds it, "A user of this agent is using this browser right now"
  (`sharedUserControl`). A call that was already running finishes; it may overlap the
  first input.
- The lease ends on **Hand back**, after ten minutes without owner input (a warning
  a minute before), 30 seconds after the session's last full view closed, or when
  the browser stops. If the agent was refused during the lease, the end (except at a
  shutdown) queues a note in the agent's most recent chat, in English like the
  refusal: "The owner has handed the browser back to you. Continue the browser task
  where you left off." It is delivered once the agent is idle; a message the owner
  queued there already is kept and no note is added. A lease the agent never
  noticed wakes no chat. The takeover bar with **Hand back** stays visible whatever
  the picture's state.
- Input travels on the live-view socket as `pointer` (move/down/up with button,
  buttons and click count; a drag is down, moves with the button held, up),
  `wheel`, `key` (down/up with key, code and modifiers), `text` and `paste`
  (text from the owner's paste event; AgentPier never reads the clipboard). Pointer
  positions are fractions of the shown picture; `browser-input.js` maps them to the
  page with the latest frame's `cssWidth`/`cssHeight`, which are viewport
  coordinates as CDP's mouse events expect, so no scroll offset is added. Commands
  are validated, limited to 120 a second with bursts of 240 per socket, and sent in
  order as raw CDP `Input.*` events to the shown tab on the agent's own loopback
  CDP port (`CdpInput`). That channel connects only to
  `ws://127.0.0.1:<port>/devtools/browser/…` with time limits on the lookup and
  the socket, and once the lease ends (or moves) nothing queued is sent any more.
- Keys with text go as `keyDown` events: Chromium ignores the text of a
  `rawKeyDown`, so Enter (`"\r"`) submits a form and breaks a line only that way.
- A hidden text field takes the keyboard, so phones show their on-screen keyboard,
  IME composition arrives as finished text, and characters go in as inserted text;
  Enter, Backspace, Tab, Escape, Delete, arrows and page keys, and Ctrl/Cmd
  shortcuts, go as key events. A phone keyboard's Backspace and Enter arrive as
  `beforeinput` (Android reports key 229) and are sent as keys as well. A tap is a
  click and a one-finger drag scrolls (as wheel events); pinch zoom is off on the
  picture. Shift+Escape leaves the browser and focuses **Hand back**; every other key
  goes to the page.
- While the owner holds the browser, a tab it opens (an OAuth popup) is shown at once.
- Not in the picture: the browser's own windows (file pickers, HTTP sign-in dialogs,
  permission prompts) and open drop-down lists, which Chromium draws outside the
  page. A focused drop-down list follows the arrow keys and Enter. HTML drag and drop
  between elements is not supported; drags that follow the mouse (sliders) work.

### Search provider

**Connections › Services for agents › Web search** selects one provider for all agents:

- **DuckDuckGo** (default) needs no key.
- **Perplexity** uses an existing OpenRouter connection's key; searches are billed to
  that OpenRouter account.
- **Brave Search** takes its own API key, stored in `assistants/web-search.sqlite`.
  The browser only learns whether a key is stored.

The provider plugins are bundled with the managed runtime (see
[runtime updates](assistant-runtime-updates.md#bundled-search-plugins)). The key is
written only into the provider plugin's entry in the Gateway configuration, which
OpenClaw redacts on read; it is not passed as an environment variable.

<a id="restart-confirmation"></a>

### Pending restart

In team mode `plugins.allow` is restrictive, and OpenClaw does not take the browser
block or a search plugin live. Since AGENTPIER-202 a start therefore compiles every
web section the runtime can serve, whether an agent uses it yet or not: the global
tool allow list (an upper bound; each agent's entry names its own tools),
`tools.web`, the browser block with its member slots, the search plugin, PDF
extraction with the PDF fallback or its placeholder, and the image model. Switching web search, web
pages, the browser, its visible window, PDFs or images for one agent changes only
its entry and its own `browser.profiles.<agent>` entry, which apply live
(`BrowserProfileSync`, verified in the
[web tools qualification](assistant-web-tools-qualification.md#f-reload-kinds)).

A Gateway restart is still needed when something changes what an agent's capability
compiles, or what the Gateway holds. Additions and other changes leave a pending
restart:

- a used capability's global section: another search provider or key, another PDF
  fallback model while an agent reads PDFs, a browser installed or removed after the
  start;
- a model connection agents use: another endpoint, name or other non-key setting;
- an agent's own Telegram bot: connecting one, a person added, a first speech key.

Revocations keep the immediate restart: deleting a connection agents use, a new or
removed key on it, removing an agent's bot, replacing its token, and changing or
removing the speech key its bot uses. The owner confirms (`409
ASSISTANT_RESTART_REQUIRED`, then `confirmRestart: true`), the Gateway restarts at
once, and the save is refused while agents are busy, so a revoked credential never
stays in the running Gateway.

A pending change is stored at once and applied live as far as possible. The restart
is recorded in `assistants/pending-restart.json`, with the reasons and the agents it
interrupts; further changes join it. `PendingRestart` tries at once and then every
15 s. Each try first checks for busy work _outside_ maintenance (`busy()`: the
maintenance blockers, another restart, maintenance or an update), so a busy host never
closes admission, pauses Telegram or switches cron off just to find out; `waitingFor`
names what it waits for; a refusal by an update or other maintenance waits as
`active`. Only an idle host enters the usual maintenance restart, which
checks again inside (see [Process ownership and
supervision](#process-ownership-and-supervision)). A failed try is logged with its
code and shown as **The last restart attempt failed**; it is retried. A save made
while the Gateway starts counts as pending, since that start may have compiled
before it. Any Gateway start of a later generation ends it, because each start
compiles every saved change, also after an AgentPier restart, when the file is read
again; a try first notices such a start and then ends without restarting. A runtime
update is refused (`UPDATE_BUSY`) while a try runs.

The agent settings, the connection details, the web search, PDF reading and Telegram
settings and **Agents › Runtime › Agent service** show **Agent service
restart pending** with what it is for and what it waits for. **Restart now** asks
first and then restarts at once (`POST /api/assistant-runtime/pending-restart`,
exempt from the maintenance guard). It interrupts all running agent work and can take
about a minute or longer, but it still waits for an account sign-in in progress and
for a workflow that is executing. It never just joins an automatic try that may stop
at busy work: it runs after it unless that one restarted.

The global `tools.allow` lists every available web tool, so OpenClaw's own `main`
agent, which is no AgentPier agent, gets an explicit `tools.allow: ["session_status"]`.

A user's own switch on her agent still never restarts the Gateway: when it would
need one, it is refused (`USER_AGENT_RESTART_NEEDED`) and the owner decides. A native
account logout restarts at once and is refused while agents are busy. Advanced
OpenClaw settings that need a restart still ask for confirmation and are refused
while agents are busy. With the Gateway stopped, every save is stored and compiled
at the next start. Rotating the OpenRouter key that Perplexity uses takes effect at
the next Gateway start.

### Unavailable states

- **No browser found:** the **Use a browser** switch is disabled with a hint to install
  Chrome, Brave, Edge or Chromium. An agent that already has it switched on keeps
  the setting but is not granted `browser`.
- **Search not set up** (Perplexity without a usable OpenRouter connection, Brave
  without a key): the **Search the web** switch is disabled and the web search
  settings show **Not configured**. `web_search` is withheld; OpenClaw would
  otherwise offer it and fail every call.
- **Runtime without the bundled plugins** (an installation not yet updated, or a
  rollback target): web search is unavailable until the staged update is activated.
- **Documents:** OpenClaw offers `view_image` only for models that accept images.
  **Read images** grants `view_image` only; PDFs need **Read PDFs**, which reads with
  the agent's own model or the optional PDF fallback (see
  [PDF reading](#pdf-reading-2026-10-19) and the
  [web tools qualification](assistant-web-tools-qualification.md)). `view_image`
  stays in the agent's workspace (`tools.fs.workspaceOnly`); images in a granted
  project folder are shown through `agentpier_workspace` `image_view`, which needs
  **Read images** too and returns the image as an image block (see
  [direct folder access](assistant-workflows.md#direct-folder-access)).
- **New agents:** the web, browser and image switches are disabled while creating an
  agent ("Available after saving the agent"); the server stores them as off on
  create. Switch them on in the agent's settings after saving.

## Agent SSH access (2026-10-16)

`agentpier_ssh` (actions `hosts`, `execute`) is compiled into an agent's `tools.allow`
only while the agent holds an SSH grant, and it is part of `routineTools`. The bridge
admits `action: "ssh"` for owner and permanent-member turns like the other personal
tools, for a temporary member only while it was granted SSH on its lead's grants
([Team member grants](#team-member-grants-2026-10-17)), and, beside shared files and a lead's `members`, `ask` and `delegate`, for a routine's run session without an attempt
(`TeamBridge.routineRun`, a bound, enabled routine with routines on). The plugin's
call budget for `ssh` is 245 seconds: a 110-second approval hold plus a 120-second
command. Forwarded, member-result, reminder, check-in and unknown turns are refused
with `SSH_ORIGIN_REFUSED`; a routine may run only on `routines` hosts
(`SSH_ROUTINE_NOT_TRUSTED`). Late approvals return as an `ssh-result` follow-up turn
that keeps the original turn's origin class. Agents with SSH grants never own a bot
for other people.

What an SSH action row keeps (`assistant_actions`, read by the chat note and
**Actions and coding tasks**): an approval keeps the exact command (at most 16 KiB)
while it waits and runs, because the owner decides on that text and it runs as such;
once it settles (completed, failed, declined, expired, cancelled or unknown),
`redactedCommand` replaces recognisable secrets with `•••` and sets
`commandRedacted`, and the row keeps the SHA-256 of the original command
(`commandSha256`), so a retry of the same tool call still finds its card. The
approval's Telegram text in `channel_outbox` is rewritten the same way
(`ChannelOutbox.rewriteActions`); text Telegram already delivered stays in that chat.
Every update of an SSH row that holds a command runs with `secure_delete`
(`AssistantActionStore.patch`), so the space a revision frees keeps no copy of the
text, and the settling patch ends with a TRUNCATE checkpoint (best effort; a busy
reader leaves the log to the next checkpoint).
A trusted run is stored redacted at once, at most 8 KiB (`noteCommand`, `commandCut`
when cut), and only the newest 500 trusted rows per agent are kept
(`trustedSshRows`). Rows stored before redaction existed are redacted once, at the
first start of a version with `ssh-command-backfill.js` (before the first workflow
tick): every SSH row that is not awaiting approval, approved or executing gets the
original's `commandSha256` when it has none, its `command` with secrets replaced, a
`commandPreview` taken from that redacted command (only rows without a command
redact the preview itself), `commandRedacted` when that changed, and a new revision; the
Telegram texts about those rows are rewritten with `rewriteActions`. The rewrite runs
with `secure_delete`, then `VACUUM` rewrites `assistants.sqlite` and
`channels.sqlite` (earlier revisions of a row survive in freed space otherwise) and a
TRUNCATE checkpoint empties the write-ahead logs. The marker
`ssh-command-redaction` in `assistant_migrations` is set only when all of this
succeeded and the channel outbox was there, so a failure (a failed VACUUM or busy
checkpoint included, logged with its code only) retries at the next start; a rerun
leaves redacted rows unchanged. Until then, and for rows the backfill missed,
chat notes are redacted when read; a secret cut short at the end of an old trusted
run's 80-character preview may be missed. Backups taken before the backfill (sealed
history) and messages Telegram already delivered keep the old text; replace such
backups if that matters (docs/backups.md). Restoring one brings the plaintext back
until the next start redacts it again, since its database has no marker.

`server/lib/secret-redaction.js` keeps the flag, header or variable name and replaces
the value. It recognises:

- password, token, key and secret flags (`--password=…`, `--token …`,
  `--client-secret …`, also partly quoted values such as `--password=a"b c"`);
- `mysql -p…`, `sshpass -p …`, `redis-cli -a …`, `docker login -p …`,
  `curl -u user:…`, `smbclient -U user%…` and `openssl … -pass pass:…`, each within
  300 characters after the tool's name;
- `Authorization`, `Proxy-Authorization`, `X-Api-Key`, `X-Auth-Token` and similar
  headers, and JSON fields such as `"password": "…"` or
  `"Authorization": "Bearer …"`;
- `scheme://user:password@host` (up to the last `@` before the host);
- `NAME=value` where the name ends in PASSWORD, PASSWD, SECRET, TOKEN, API_KEY,
  APIKEY, ACCESS_KEY or PRIVATE_KEY, and `MYSQL_PWD=`;
- PEM private key bodies, JWTs and well-known key prefixes (`sk-`, `ghp_`,
  `github_pat_`, `xoxb-`, `AKIA…`).

Shell references (`$PW`, `${PW}`, `$(cat file)`) are not secrets and stay. Every rule
runs in linear time. Limits, best effort: secrets fed through stdin
(`echo pw | sudo -S`, `docker login --password-stdin`), here-documents such as a
`.netrc`, positional arguments, a bare `-p` of other tools and any form not listed
above stay as they are. The audit never holds the text, only the digest and length.

### Agent SFTP access

The SFTP actions of `agentpier_ssh` (`list`, `stat`, `download`, `upload`, `sync`,
`mkdir`, `rename`, `delete`, `job`, `cancel`; `hosts` lists each host's `type` and
`remoteRoot`) share the SSH grant, the origin classes and the bridge budget. `AgentSftp`
(`agent-sftp.js`) decides with `sftpPermits(mode, class, kind)`: reads and dry runs run,
writes run on `trusted` and `routines` hosts and otherwise open a card, deletes (also a
sync with `deleteExtra`) always open a card, and a routine never deletes
(`SFTP_ROUTINE_DELETE`). `execute` on an SFTP host and file actions on an SSH host fail
with `SSH_HOST_TYPE`. The local side is the agent's workspace or a granted project
folder; the workspace's guarded entries (prompt files, `skills/`, `.agents/`,
`attachments/`) are never transferred and a folder download or sync down needs a
subfolder (`SFTP_WORKSPACE_REFUSED`).

A card is an `assistant_actions` row with `action: "sftp"`, the path lists capped at
500 per kind, a plan digest and no credentials. At most 3 stay open (`SFTP_APPROVAL_LIMIT`).
`allow-always` is accepted only when the card has no deletes and the grant holder is the
card's own agent; it then switches the grant to `trusted`. An approval re-plans and
compares the digest before anything is written (`SFTP_PLAN_CHANGED`). Telegram approves
only plans with at most 20 paths per list and no hidden characters. A transfer that runs
longer than the hold continues as a job: `job` and `cancel` act on the action row's id,
and the result returns as an `sftp-result` follow-up turn that keeps the original origin
class. Rows hold counts only; completions are audited as `sftp.completed` and
`sftp.failed`. See [SFTP access](sftp-access.md).

## Lead promotions of team members (2026-10-17)

`agentpier_team_promote` (lead-only, `member-promotion.js`) keeps one of the lead's
own task members as a permanent agent, directly and through the same path as the
owner's **Keep as permanent agent** (`TeamStore.promoteByLead`, the model is frozen
and the instructions are flagged for the owner's review as there). The member must
be reachable (`reachableMember`) and between turns (`active` while a turn runs);
it need not have finished its task. The promotion runs under admission, so no
turn's apply mirrors the lead's memory meanwhile; the flip, the member's history
entry and the agent's new settings are written in one transaction, then its
servers are bound, a pending shell or SSH card for it is cancelled
(`MEMBER_PROMOTED`), and its profile and check-ins are applied. Unlike the owner's
promotion:

- What the member ran with becomes its own settings, independent of the lead from
  then on: its effective capabilities (web, images, memory, reminders) and skills,
  and its MCP servers (proposal and later grants) within the lead's bindings at that
  moment, recorded as granted so the team never adds to them again.
- Shell and SSH are never carried over: its shell level is Off and it holds no SSH
  grants; the owner sets them.
- It keeps only its own memory (memory on, read and write; what it saved as a
  member carries over as it is): the copy of the lead's
  memory is removed (owner's decision: a promoted agent is a specialist, steered by
  the lead and reachable by the owner directly, with its own knowledge).
- Name and instructions stay, including the lead's edits; it stays the lead's
  member in the sidebar.

It is visible like every lead change: an entry in the member's history, a note in
the member's and the lead's chats, an audit record (`kind: "member-promote"`) and a
notice in the lead's paired Telegram chat that links to the agent's settings. The
owner can archive the agent at any time.

## Lead edits of team members (2026-10-17)

`agentpier_team_member_update` (lead-only, `member-edits.js`) changes one of the
lead's own members: a temporary one that works on its task or is finished but still
reachable (with a chat; `reachableMember` in `member-reach.js`, the same rule as
later grants), or a permanent one that is not archived (`editableMember`). The
change shows in the lead's chat and history; for a permanent member also in the
history of its Identity tab:

- `name` (as for any agent, at most 100 characters), `role` (200) and `assignment`
  (8192) update the member's record, which the sidebar, the team card and the
  Telegram texts show. Role and assignment replace the composed `Role:` and
  `Assignment:` block in the member's current instructions: the whole block (a
  multi-line assignment too), only where it starts a line and ends a paragraph, and
  the last such block before the lead's own section, so matching text in the
  lead's snapshot stays. When the owner changed or removed that block, a fresh one
  is added before the lead's section instead of editing anything.
- `extraInstructions` (8192) puts the lead's own delimited section at the end of
  the instructions, replacing an earlier one; an empty value removes it. Restating a value whose text
  the owner removed from the instructions restores it.
- `instructions` (65536) replaces the member's whole instructions, whatever the
  owner wrote before (owner's decision: the lead may rewrite them completely, since
  earlier text could interfere). It cannot be combined with `extraInstructions`.
- `model` (`{ connectionId, modelId }`) moves the member to another model. It is
  checked like the runtime uses it (`validateMemberModel` in `member-models.js`
  resolves it and gives the lease back): a connection without its key, a
  signed-out ChatGPT account or an endpoint model outside its list is refused and
  nothing changes. The member's team record keeps it as the lead's (`leadModel`),
  so only later owner changes show as a model override; a temporary member keeps
  it as its own (`ownModel`) and no longer follows the lead's model, also when the
  lead names its own current model for a member that follows it. The same model
  again is `unchanged`. The lead and the member are checked before the model is
  resolved, so a member the lead cannot edit is refused (`teamGrantMemberEnded`)
  without any model lookup. The note and the log name both models; the audit adds
  their ids only (`details.models`). A model that stops working later (key removed,
  account signed out, model gone) is not replaced: the member's turns fail visibly
  with the usual model error and there is no fallback to the lead's model.

An edit of a permanent member applies from its next turn, also in the owner's chats
with it, and appears in the history of its Identity tab together with the replaced
instructions.

Owner edits never block the lead. Every result is recorded as the lead's
(`leadInstructions` on the member's team record), so the member's settings show an
instructions override only for owner edits made after it. Each change is visible:
an entry in the member's log (team card and **Access › Granted by the lead agent**), a note in the
member's and the lead's chats, and an audit record (`assistant.updated`, `kind:
"member-edit"`) that names the changed fields only. The member's new revision
applies from its next turn; a running member is re-applied at once. The member's
profile and its team record change in one transaction.

The instructions an edit replaced are for the owner only. They live in a text row of
their own beside the member's record (`team-texts.js`), never in team lists or in
what the lead's tools return; the log entry names the row (`replaced`), and the
history loads the text on opening from
`GET /api/assistant-team-members/:id/replaced/:entryId`. Only the last five edits
keep their replaced text; older entries keep the changed field names only.

## Team member grants (2026-10-17)

Task-bound (temporary) team members have no capability settings of their own. Their
lead agent decides per member what it gets, when it proposes the team and later
while the member works, and it can only grant what it holds itself. What a member
runs with is resolved on every read of the member (`AssistantStore.getAssistant`,
`memberInheritance` in `member-grants.js`): each grant within what the lead holds
right now. Nothing is copied into the member's record, so the owner's **Keep as
permanent agent** keeps none of its grants: only the MCP servers named in the proposal the
owner saw stay bound, never servers granted later. The copy of the lead's memory is
removed and memory is on for its own memory, and a pending shell or SSH card for it
is cancelled. A lead's own promotion keeps the
member's effective grants instead (see
[lead promotions](#lead-promotions-of-team-members-2026-10-17)).

| Grant (proposal `grants`, tool `agentpier_team_grant`)                      | How a temporary member uses it                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `webSearch`, `webFetch`, `browser`, `documents`, `readPdfs`, `createImages` | The lead's web, image and PDF tools (reading images and PDFs, creating images), with the same global network and browser safety |
| `skills` (`true` for all of the lead's, or names)                           | Those of the lead's skills                                                                                                      |
| `mcpServers` (names of servers bound to the lead)                           | Those servers, while the member works ([bindings](#bindings))                                                                   |
| `memory`                                                                    | A read-only copy of the lead's memory beside the member's own memory (see below)                                                |
| `reminders`                                                                 | Reminders created on the lead (see below)                                                                                       |
| `shell` (`approval` or `full`), `ssh`                                       | Only with the lead's **Team members may use shell and SSH**, at most at the lead's level and on its SSH grants                  |
| `github` (`read` or `write`)                                                | The lead's GitHub token profile, at most at the lead's level ([GitHub for agents](#github-for-agents))                          |

A member the lead grants nothing explicitly gets `memory`, `webSearch` and
`webFetch`, as far as the lead has them. Members reserved before grants existed
get the same default within the lead's ceiling, and the lead may grant them more. Team and delegation tools, routines and memory writes stay
with the lead.

- **Ceiling.** The proposal (`TeamStore.propose`) and every later grant refuse a
  grant the lead does not hold now (`TEAM_GRANT_NOT_HELD`): a capability or skill it
  lacks, a server not bound to it (`MCP_SERVER_NOT_BOUND`), a shell level above its
  own, or shell and SSH without the setting or without the lead's own shell or SSH
  grants. The grants belong to the proposal's fingerprint and are stored on the
  member's team record.
- **Live.** Every apply of a member compiles its grants within what the lead holds at
  that moment, and every member turn applies first. When the lead's entry changes (a
  capability, a skill, its shell level or its first or last SSH grant) or its team
  settings are saved, AgentPier also re-applies the lead's running members at once
  (`member-follow.js`). A capability the lead loses is gone for its members; one it
  regains comes back only where it was granted. Bridge calls (reminders, SSH) and
  exec approvals check the current state on every call.
- **Later grants.** `agentpier_team_grant` (lead-only) gives a task member of the
  lead's own team more within the same ceiling: one that works on its task, or a
  finished one the lead can still reach with questions and tasks (not archived, not
  kept as permanent, with a chat). Every turn the member runs applies its grants
  first, the turns of its lead's questions and tasks included. The lead takes grants back with
  `revoke: true` at any time (`member-grant-requests.js`). Capabilities, skills and
  MCP servers apply at once without the owner, but visibly (servers granted later
  are kept apart, `grantedMcpServerIds`, and end with the task): the member's record keeps
  a log (shown on the team card and in the member's **Access › Granted by the lead agent**), the member's and the lead's chats get a note, and the audit records
  `assistant.updated` with `kind: "member-grant"`, the changed kinds and a server
  count, never names or content. Shell and SSH granted later always become an owner
  approval (an action card in the lead's chat and its paired Telegram chat, the
  Overview tab's **Actions and coding tasks** list) and apply only once approved, after the ceiling is
  checked again; a card whose member ended or whose setting went off fails closed
  (`GRANT_REVOKED`). Revoking shell or SSH, the member ending, or the setting going
  off cancels such a pending card like other cancellations: a note in the lead's
  chat now and the result notice in Telegram at the next tick.
- **Memory (2026-10-17, AGENTPIER-119).** Every temporary member has its own
  native memory, always on: its `MEMORY.md` and `memory/` notes in its workspace,
  with `memory_search`, `memory_get`, `read`, `write` and `edit` (writes once the
  write guard reports). The bridge admits a member's write in any of its turns only
  when every spelling of the target, resolved on disk without following links,
  stays in its own workspace, in `MEMORY.md` or below `memory/`, and outside
  `memory/lead/` (`ownMemoryTarget` in `lead-request-writes.js`); anything else is
  refused. The lead's `memory` grant adds a read-only copy of the lead's memory in
  `memory/lead/` (`member-memory.js`): before each member turn AgentPier writes the
  lead's `MEMORY.md`, `USER.md` and `memory/` notes there flat (`note-a--b.md`; same
  name, count and size bounds as the memory panel, no links; each file goes to a
  fresh `O_EXCL` temporary name and is renamed over the target, a planted link is
  removed rather than followed, and a linked folder is never written through) and
  empties the folder once the grant goes. Memory search finds both, and the
  member's instructions say which is which. Copies from the earlier layout (the
  member's own root files identical to the lead's) are removed once. The owner
  reads a member's own memory in its **Capabilities › Own memory**.
- **Reminders.** A member granted reminders gets `agentpier_reminder` (never
  `agentpier_routine`) and may only create a reminder, in a turn its lead gave it
  (`team-member` or `lead-request`). The reminder is created on the lead: it is
  listed in the lead's settings, runs as the lead's job and is delivered to the
  lead's paired Telegram chat, so it never fires from an agent that has ended and
  the owner can pause or remove it there. The members of one team create at most
  five (`MEMBER_REMINDER_LIMIT`); each creation adds a note to the lead's chat and
  an audit record (`kind: "member-reminder"`), never the reminder's text.
- **Shell and SSH.** The lead's **Team › Team › Team members may use shell and SSH** is off by default. It is recorded with each team when it is proposed and
  also read live: a team proposed while it was off never gets shell or SSH.
  Switching it off latches (`TeamStore.latchShellSsh`): the lead's teams lose the
  setting for good, their members lose their shell and SSH grants (logged as the
  owner's change), pending cards are cancelled, and switching it on again restores
  nothing. A member granted shell runs at most at the lead's level; its own
  allowlist stays empty and its cards never offer **Always allow** (refused on the
  server too), so with approval every command asks and nothing outlives the task; a member granted SSH runs `agentpier_ssh` on the lead's grants as a
  delegated caller (`AssistantAccess.sshHolder`): the host's mode decides as for a
  permanent member's delegated turn, and approvals also ask in the lead's chat.
- **Approval card.** The proposal (web and Telegram) lists every member's grants and
  marks members with shell or SSH with a warning. A proposal that grants any member
  shell or SSH always waits for the owner's approval, even with a task or standing
  authorization; other teams approved automatically follow their grants.

**Security trade-offs.** Leads and members act unattended. Everything they read
from the web, documents, MCP servers or remote output is untrusted data that can try
to steer them. A prompt injection that reaches a lead can make it grant its members
more, and one that reaches a member can use every tool the member holds: web
requests (still under the private-network block), its granted MCP servers including
stdio ones, reminders to the owner's chat and, only with the setting on, shell and
SSH on the lead's grants. The mitigations are the ceiling (a lead never grants more
than it holds), visibility (notes in both chats, the team card, the member's
Capabilities tab and the audit) and the owner's approval for every shell or SSH
grant after the proposal. A member cannot change the lead's memory, start teams or
schedule routines. Keep the shell and SSH setting off unless the lead's work needs
it, and prefer `approval` modes for its shell level and SSH hosts.

## Lead shares with permanent members (2026-10-19, AGENTPIER-153)

A lead shares its own project folders (`read` or `write`, at most its level), coding
projects (requests on its project and pipelines), MCP servers bound to it and **Read
images** (`documents`) with its own permanent members, without the owner
(`lead-shares.js`, `lead-share-input.js`, `lead-capability-shares.js`):

- **Tools.** `agentpier_team_grant` with a permanent member's `memberId` takes only
  `grants.projects`, `grants.documents`, `coding` (project ids) and `mcpServers` and
  stores a standing share; anything else is `PERMANENT_ACCESS_ONLY`, and
  `revoke: true` takes a share back: its notes and result name only what it removed,
  and a revocation that removes nothing leaves no note (`nothing_to_revoke`).
  `grants.documents: true` needs the lead's own **Read images**
  (`TEAM_GRANT_NOT_HELD` otherwise) and is only ever standing.
  `agentpier_team_delegate` takes `access` with the projects, coding and server
  fields for that one task: checked against the lead before the request exists and in place before
  the member's turn starts. Shell and SSH are never shared.
- **Store.** `assistant_lead_shares`, one row per member, lead, resource and scope
  (`requestId` null for a standing share), with `grantedAt`, `grantedBy` and the
  granting attempt. The member's own `assistant_access` row is never touched.
- **Live cap.** Every use reads the lead's access now: a folder at most at the lead's
  level, coding only while the lead holds the project, a server only while the lead
  is bound to it (and never a stdio server for an agent with its own Telegram bot for
  other people). A share ends, and the team scheduler's tick prunes it with an audit
  record (`reason`), when the lead or member is archived or gone, the member is no
  longer the lead's permanent member, the task ended (`task-ended`) or the lead holds
  nothing of it any more (`lead-lost`).
- **Read images.** A `capability` row (`capability: "documents"`) is resolved into a
  permanent member's record on every read (`AssistantStore.resolved` →
  `leadCapabilities`, never persisted; `personalCapabilities` adds it to the
  member's own switches) while the member is the lead's unarchived permanent member
  and the lead has **Read images** on: the member's next apply compiles `view_image`
  and `image_view` admits it. When the lead's profile is re-applied
  (`followLead`), its members with such a share are re-applied too, after a prune
  that removes a share the lead no longer backs (`lead-lost`); whichever prune
  removes such a share (the owner's list, the scheduler's tick) re-applies the member
  as well. Switching the lead's **Read images** on again does not bring it back. The member's own switch in its
  settings stays as the owner set it.
- **Where it works.** `AssistantWorkflows.context` admits a `lead-request` turn while
  its task runs in exactly that turn (`workspace-calls.js`): file actions use the
  member's own `projectFiles`, capped at `read` unless `taskWritable`
  (`leadRequest.writable`), and the lead's shares for that scope (standing and the
  task's own), the higher level per folder (`AgentProjectFiles.levels`, also for
  `image_view` and the SFTP local side). A `write` share is the
  lead's own authorization: with the proven guard it writes in every task of that
  lead, whatever `taskWritable` says, capped live at the lead's level (a `read` share
  or a lowered lead gets `PROJECT_READ_ONLY`), and each change is audited with
  `leadAssistantId`, `leadRequestId` and `via: "lead-share"`; a change the share does
  not carry is on the member's own grant (`via: "own-grant"`). `taskWritable` (owner
  proof, autonomous lead or a write-enabled routine) also governs the member's native
  writes in its own workspace (`LeadRequests.mayWrite`). Coding requests use the
  member's own grant first and the lead's share otherwise (`authorizeCall`), and every
  coding request in a lead's task waits for the owner; project memory and other
  actions stay out. A sibling's request the lead started (`sharesOnly`) still reaches
  only the lead's standing shares. In the owner's
  own turns with the member the shares add to its own levels and projects, and so do
  standing shares in the member's own routine runs (see routine folders below).
- **Routine folders.** A routine's own run session reaches `agentpier_workspace`
  (in `routineTools`; `TeamBridge` binds it to the routine like SSH and shared
  files, `routineContext` re-reads the binding on every step): the agent's own
  `projectFiles` and its lead's standing shares, never a task's share. Reads always;
  `file_write` and `file_edit` only with the owner's **May write** on that routine
  (`routineWrites`), else `ROUTINE_READ_ONLY`, and audited with
  `origin: "routine"` and `routineId`. Coding and project-knowledge requests from a
  run always wait for the owner in the agent's main chat (`routineId` on the action,
  never auto-approved); `coding_cancel` is refused.
- **Coding.** A coding request on a shared project is stored on the member with
  `inherited: { leadId, requestId, shareId }`, always waits for the owner (also with
  the lead's standing permission), and in a task carries `leadAssistantId`, so it
  shows in the lead's chat too. Approval and start authorize on the lead's grant
  (`LeadShares.authorize`: the share still gives coding, or a task's share ended only
  with its task; `AssistantAccess.authorize` on the lead with the request's
  `accessRevision`); the run uses the lead's grant for that one project under the
  member's client id, so only the member reaches its run. A task's share stays stored
  after its task ended while a coding request resting on it waits for the owner or
  runs (`LeadShares.restsOn`), so the scheduler's prune cannot revoke it before the
  owner decided; it gives nothing else meanwhile. Revoking the share fails a waiting
  request (`GRANT_REVOKED`).
- **MCP.** `readMcpInputs({ inherited })` merges `LeadShares.mcpBindings()` into the
  agent bindings before secrets are read, at every start and live apply
  (`McpChanges.inherited`), so placeholder servers compile a per-member entry. A
  share change marks the MCP state pending; the scheduler's tick applies it.
- **Owner.** `GET /api/assistant-lead-shares` (filters `memberId`, `leadId`,
  `projectId`, `serverId`) and `DELETE /api/assistant-lead-shares/:id`; the project's
  Agents view carries `shared`, the MCP server list `shared` per server. A shared
  **Read images** is listed as `kind: "capability"` with `live.on` and shown in the
  member's **Access › Shared by the lead agent**.
- **Audit.** `assistant.updated` with `kind: "lead-share"`, `change` (`grant` or
  `revoke`), `by` (`lead`, `owner` or `system`), `reason`, the lead
  (`leadAssistantId`), member (`memberId`), task (`requestId`), `projects` (ids with
  coding and folder levels), `mcpServerIds` and shared `capabilities`
  (`["documents"]`), all kept by the audit schema (`audit-team-details.js`); a folder change through a share adds
  `leadAssistantId` and `leadRequestId` (or `sharedBy`) to its `project-file` record.
  Both chats get the grant note.

## Lead routines on permanent members (2026-10-19, AGENTPIER-175)

`agentpier_team_member_routine` (lead-only, `lead-routines.js`) lets a lead plan
standing work for its own permanent members: `create`, `list`, `update` (name,
prompt, trigger and/or `enabled`, with the routine's `revision`) and `remove`.

- **Who and when.** Only the lead's own permanent members (team record and agent
  both `permanent`, neither archived, routines switched on for the member;
  temporary members get `ROUTINE_MEMBER_NOT_PERMANENT`, a member with routines off
  `ROUTINE_MEMBER_OFF`, anyone else `NOT_FOUND`). Every action runs only in a turn
  of the owner's own message (`owner` or `telegram`, not forwarded); routine runs,
  member-result follow-ups and other internal turns get `ROUTINE_OWNER_TURN`, and
  `routineActions` in `team-bridge.js` never admits the tool for a routine run.
- **Usage levels.** A routine is standing work, never a write by itself, so the
  levels decide the way they do for asks and tasks: under `onRequest` a `create`
  needs the owner's own message in this turn to name the member (`namesMember` on
  `ownerProse`, an `@` mention included), else `ROUTINE_NOT_REQUESTED`; under
  `suggest` the "Your team" section tells the lead to offer the routine and set it
  up after the owner's yes; under `autonomous` the lead may set one up on its own and
  tells the owner. The per-member cap below bounds all levels.
- **Validation and limits.** Name and prompt as for the agent's own routines (100
  and 8,192 characters) and the same `schedule()` checks (one time with an offset,
  or a cron with an IANA time zone); event triggers are refused. A cron must be a
  five-field expression whose minute and hour fields leave at least 15 minutes
  between two runs (`cron-gap.js`, also across midnight; anything it cannot read is
  refused), else `ROUTINE_TOO_FREQUENT`. At most 5 live lead routines per lead and
  member (`ROUTINE_MEMBER_LIMIT`); a replayed tool call adopts its routine.
- **Storage.** The routine is the member's own binding
  (`assistant_reminder_bindings`, `kind: "routine"`) with `createdBy: "lead"`,
  `leadId` and `leadMemberId`, created through `NativeRoutines.create`, so it runs
  as the member's native routine with the member's own capabilities and its lead's
  standing shares (never a task's share). Its payload tells the member that its lead
  set it up and that its reply is the report; it may answer `NO_REPLY` when its task
  says to report only findings. Edits go through `NativeRoutines.edit`
  (`routine-edits.js`): the definition and the native job (`name`, `schedule`,
  `payload`) together under the routine's revision; the owner's
  `PATCH /api/assistants/:id/routines/:routineId` accepts `name` and `prompt` too.
- **Writing.** `writes` is not part of the tool's input. A run of a lead routine
  writes (native writes in the member's workspace, project folders, writable tasks)
  only when the owner switched on **May write** for it (`routineWrites`) or the lead's
  team usage is `autonomous`, read live (`LeadRoutines.writeReason`,
  `NativeRoutines.writable`, used by `TeamBridge.routineWrite` and `routineContext`).
  The owner's own routines keep their rules.
- **Reporting.** `NativeReminders.complete` records the run in the member's chat as
  for every routine, and `LeadRoutines.report` turns it into a settled lead request
  of `type: "report"` (`lead-routine-reports.js`; origin `{ kind: "member-routine",
bindingId, name }`, the result kept like an answer, idempotent per run). The
  scheduler's next pass delivers it like any other result: a `member-result`
  follow-up in the lead's main chat, "Report from <member> · routine <name>",
  attributed data that the lead may act on like any follow-up. A silent run sends
  nothing; a failed run is reported once (`ROUTINE_FAILED`) and later failures stay
  quiet until a run succeeds again (`leadReportFailing` on the binding). Reports are
  listed in **Team › Teams › Questions and tasks** as "Routine report from
  <member>" with "Scheduled · <name>" and do not count against the lead's request
  caps.
- **Lifecycle.** A lead routine counts only while the relation holds
  (`LeadRoutines.ended`: lead and member active, the member still the lead's
  permanent member); `runOrigin` ignores it otherwise, so a run that still fires
  reaches no tools, writes nothing and reports nothing. The team scheduler's tick
  (`TeamService.reconcile`, at most every 30 seconds) then removes it for good: the
  binding is revoked at once and its native job removed once the Gateway is ready.
  Removing rather than pausing keeps no orphaned work that would report to nobody.
- **Audit.** Every create, update and removal is recorded as `assistant.updated`
  with `kind: "lead-routine"`, the member as resource, `leadAssistantId`,
  `routineId`, `change`, `by` (`lead` or `system`), the edited fields and, for an
  ended relation, the `reason` (`lead-archived`, `member-archived`, `member-left`,
  `lead-gone`, `member-gone`); never the routine's text.
- **Owner view.** The member's **Automation** tab shows "Created by
  <lead>" and a note that its results also go to the lead and that it only reads
  unless **May write** is on or the lead uses its team autonomously; the owner
  edits name and task, pauses, removes and switches **May write** like for any
  routine.

## MCP servers for agents (2026-10-11)

Agents can use tools from MCP servers that the owner manages in one central list
(AGENTPIER-29). The facts behind this section are recorded in the
[MCP qualification](assistant-mcp-qualification.md).

### Central list

**Connections › MCP servers** lists, adds, edits and removes servers. The list is
stored in `<data>/mcp-servers/servers.sqlite` (a private directory, mode 0700) and
is independent of the coding CLIs' own MCP configuration.

- **Name:** 1 to 30 letters, digits, `-` or `_`, starting with a letter, unique
  regardless of case. OpenClaw uses the name unchanged as the tool prefix, so an
  agent sees the server's tools as `<name>__<tool>`.
- **Responses** never contain header or environment values, only their names. An
  address is shown as origin and path; a query string or fragment, which can carry
  a token, stays in the store.
- **Removing** a server removes its bindings and stored values with it; the agents
  using it lose it at once.

### Transports

| Connection             | Stored                               | Compiled into `mcp.servers.<name>`                                  |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| HTTP (Streamable HTTP) | address, headers                     | `{ url, transport: "streamable-http", headers }`                    |
| SSE                    | address, headers                     | `{ url, transport: "sse", headers }`                                |
| HTTP or SSE with OAuth | address, optional scope              | `{ url, transport, auth: "oauth", oauth: { redirectUrl, scope? } }` |
| Local command (stdio)  | command, arguments, cwd, environment | `{ command, args, env, cwd? }`, `command` always an absolute path   |

`transport` is always written: without it OpenClaw falls back to SSE, which offers no
tools from a Streamable HTTP server.

### Local commands (stdio)

A stdio server runs its command with the owner's operating-system user rights and
without a sandbox. OpenClaw has no per-agent server scope: once a stdio server is
compiled, **it starts for every session of every agent**, including agents that
are not bound to it and are never offered its tools. The processes stay up until
the server is removed or the Gateway stops.

AgentPier therefore asks for explicit consent. Adding a stdio server, binding one to
an agent, and changing a stdio server's command, arguments, working directory or
environment are refused with `409 MCP_STDIO_CONFIRMATION_REQUIRED` until the owner
confirms the warning; nothing is stored before that.

**Command resolution.** On save, a bare command (`npx`, `uvx`) is resolved on the
AgentPier service's own `PATH`, not on an interactive login shell's, and the
absolute path is stored and shown as **Resolved path**. An absolute command must be
an existing executable file. The Gateway starts the process with its own
environment: its private `HOME` (`<data>/assistants/home`), no `TMPDIR`, and a
restricted `PATH`. A command found only on the owner's interactive `PATH` (nvm,
`~/.local/bin`) must be entered as an absolute path, and a server that expects the
owner's `HOME` or a `TMPDIR` does not find them.

### Bindings

- **Personal agents and permanent team members** are bound by the owner in the
  agent's settings (**MCP servers**). Archived agents get no servers.
- **Temporary team members** cannot be bound directly; the agent update refuses it.
  They get servers only through their lead's grants: optional `mcpServers` per
  member in the proposal, or later with `agentpier_team_grant` (names of servers
  bound to the lead, at most 16; any other name rejects the call with
  `MCP_SERVER_NOT_BOUND`). The approval (in the web UI and on Telegram) shows each
  member's servers by name with a stdio marker, never addresses, commands or values.
- A granted temporary member holds exactly its granted servers that its lead still
  holds, and only while it works: on its task, or on an open question or task of
  its lead after the task finished (bound when that request is dispatched, patched
  into the Gateway at the next scheduler tick). When it ends, is stopped, the
  request finishes, the lead revokes a server or loses it, the binding goes at the
  next scheduler tick; every Gateway
  start runs the same reconciliation first.
- A member approved as permanent receives its named servers once; the owner manages
  them afterwards.

**Owner decision: automatic teams.** A team that is approved automatically (by a
task authorization, `/team`, or a standing autonomous policy) passes the servers
its lead grants to the members, including stdio servers, without a per-server
approval, and so do later grants. The members can only receive servers the lead
already holds. By enabling
automatic teams the owner accepts this.

### Compilation and live changes

Only servers bound to at least one eligible agent are compiled, and only in team
mode with the native interfaces ready (the same gate as the web tools). A start
adds `bundle-mcp` to the global `tools.allow` and `<name>__*` to each bound agent's
own `tools.allow`; `plugins.allow` stays unchanged, because `bundle-mcp` is not a
plugin. A bound server that cannot be compiled (for example an unreadable stored
value) is skipped by name, with a warning, and never blocks the start.

OpenClaw reloads `mcp` and `tools.allow` hot, also under the team plugin's
restrictive `plugins.allow`. Every change (binding, unbinding, editing or removing a
server, and team members gaining or losing servers) is applied to a running Gateway
with `config.patch`, without a restart. A removed server is written as a `null`
merge with each of its arrays (`mcp.servers.<name>.args`) in `replacePaths`. Agents
whose globs change are re-applied afterwards. With the Gateway stopped, the next
start compiles the store.

### Secrets

Header and environment values are stored in the server store and reach only the
compiled `openclaw.json` (mode 0600). OpenClaw returns them redacted on
`config.get`; the contracts verify that no transcript, log or other state file
holds them. Rotated values remain in OpenClaw's configuration backups
(`openclaw.json.bak*`, `.last-good`) until those rotate out.

Runtime update backups and host backups seal every `headers` and `env` member of
`openclaw.json` (at any depth) with the backup's own key, like the other
credentials, and treat each copy beside it that parses as JSON (`.bak*`,
`.last-good`) the same way; a copy that does not parse (an unfinished atomic-write
temporary) is left out. A rollback or restore with the key restores the values;
after a credential revocation destroyed the key, they are withheld and the restore
reports `credentialsWithheld`, so the servers need their values entered again. A
host backup without credentials leaves the values out.

Host backups also capture the server store (`<data>/mcp-servers/servers.sqlite`,
AGENTPIER-42; for a packaged server this includes the package record and its lock,
but not the installed files, which **Reinstall** recreates) as a consistent SQLite
snapshot. The public archive member is a sanitized copy that keeps only the tables
and columns the store defines: server definitions and agent and CLI bindings stay. A
stdio server's command, arguments and working directory are definitions and stay
public, so put tokens into its environment, never into its arguments. Header and
environment values, the query string and fragment of each address, the OAuth login
state (`oauth_connected`, the registered login redirect) and pending or remembered
OAuth logouts are removed. So are the records of the native CLI entries AgentPier
wrote for a server with removed values or a removed address token, or for a deleted
server: an entry's hash covers its values and would let anyone test guesses of a
short one. The copy is vacuumed so no removed value survives in a free page.

A backup with credentials seals the values, the full addresses and those entry
records in its passphrase capsule (`mcp-server-secrets/servers.json`). The restore
checks them with the store's own rules, writes them back into the restored store
and never leaves that member in the new data directory; a sealed member the store
would refuse aborts the restore before anything is written, while an address it
would refuse is left out and reported. A restore without them lists each affected
server in `credentialsNeedingLogin`: `mcp:<name>` when its header or environment
values are missing, `mcp-address:<name>` when the token in its address is missing.
Enter them again under **Connections › MCP servers**.

The restored instance's next start reconciles the coding CLIs: it writes managed
entries a CLI lacks and leaves entries the owner changed as conflicts. A server
restored without its values or address token has no record of the native CLI
entries AgentPier wrote (its bindings stay): an entry still in a CLI's file shows
as a taken name that **Adopt** takes over with its values, and AgentPier never
rewrites or removes it. Runtime update snapshots do not include the server store:
it stays on the host. Builds before AGENTPIER-42 refuse a backup with the store
("Unexpected backup component"); older backups, which declared the store as left
out, restore without it.

### OAuth logins (AGENTPIER-37)

A remote server (HTTP or SSE) authenticates with one of two methods, chosen under
**Authentication** in its form:

- **Headers (token):** static header values, as above. Use this for providers
  without dynamic client registration, for example GitHub: create a token there and
  enter it as an `Authorization` header.
- **OAuth:** the owner logs in once from the list; OpenClaw stores the tokens and
  refreshes them unattended. An optional scope sits under **Advanced**. Switching a
  server with stored headers to OAuth deletes those headers after a confirmation.

OAuth needs a provider that supports dynamic client registration (RFC 7591):
OpenClaw registers itself as a public client for exactly AgentPier's redirect URL.
There is no field for a client ID or secret. A provider without registration fails
the login (`no-dynamic-registration`) with a message that it needs a pre-registered
client or a client metadata document, which AgentPier cannot set up yet, and that an
MCP package of the server (for example with an API key) is the alternative. Header
tokens remain an option only where the provider accepts them; the hosted ElevenLabs
MCP, for example, accepts OAuth bearer tokens only.

A provider whose protected resource metadata (RFC 9728) names a `resource` outside the
configured server URL, for example on another host, fails the login
(`resource-mismatch`); the message names that resource so the owner can enter it as
the server address.

**Redirect rule.** OAuth servers compile with
`oauth.redirectUrl = <origin>/api/mcp-servers/oauth/callback`, where the origin is
the configured HTTPS remote origin (Tailscale Serve, see
[remote access](remote-access.md)) when there is one, and otherwise AgentPier's own
loopback listener `http://127.0.0.1:<port>`. A login must start from a browser that
can reach that address: from the HTTPS origin, or on the AgentPier host itself.
AgentPier refuses the start beforehand (`409`) on a plain-HTTP network address
(`plain-http-remote`: plain-HTTP network mode cannot log in) and on a remote browser
when only the loopback redirect exists (`loopback-redirect`). Changing the origin
changes the redirect, which needs a new client registration; the next login logs out
first so OpenClaw registers again.

**Login.** **Log in** runs `openclaw mcp login <name>` with the Gateway's private
environment. Because AgentPier's listener holds the redirect port, the CLI prints the
authorization URL and exits; the browser opens it. The provider redirects to the
callback, which accepts only the unguessable, single-use `state` of a login the owner
started in the last 10 minutes, runs `openclaw mcp login <name> --code <code>`, and
returns to **Connections › MCP servers** with the result. Codes and tokens are never logged or
returned. After a successful login AgentPier makes one hot `mcp` change
(`mcp.sessionIdleTtlMs` toggles between unset and `0`, which mean the same): a turn
that tried the server without credentials backs it off for up to 10 minutes, and
only such a change lifts that backoff. It restarts the MCP runtimes of every session
once (stdio servers too), without a Gateway restart.

**Failure reasons.** AgentPier classifies a failed `openclaw mcp` command by its
`[openclaw] Reason:` line. OpenClaw 2026.10.3 prints that line only with
`OPENCLAW_DEBUG`, so AgentPier runs the CLI with `OPENCLAW_DEBUG=1`. OpenClaw reads
it only when it formats a failure; the stack trace it then adds on stderr is
ignored.

**Status** (from `openclaw mcp status --json`, cached for 10 seconds and refreshed
after a login or logout):

| Status            | Meaning                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connected         | OpenClaw holds a valid login; the expiry is shown when known. Agents bound to the server get its tools.                                          |
| Login in progress | A login started in AgentPier awaits the provider's redirect.                                                                                     |
| Login required    | The server was logged in before, or the provider revoked or refused the tokens; or an old login under this name and URL still awaits its logout. |
| Not connected     | Never logged in, or logged out.                                                                                                                  |
| Status unknown    | OpenClaw could not be asked.                                                                                                                     |

A bound server without a valid login is left out of the agent's tools; the turn
runs on without them.

**Logout, rename and delete.** **Log out** runs `openclaw mcp logout <name>`.
OpenClaw keys a login by server name and URL, so a rename, a URL change, a switch to
headers and a delete first log out under the old name and URL; the edit is saved
afterwards. Such a logout never blocks the edit: when it fails, AgentPier records
it, answers with the warning `oauth-logout-deferred`, keeps any server with the old
name and URL uncompiled ("Login required", logout pending), and retries in the
background and before every Gateway start compiles.

**Backups.** Logins live in OpenClaw's `state/openclaw.sqlite` (`mcp_oauth_stores`,
`mcp_oauth_pending_authorizations`). Host backups leave them out, with or without
credentials, and the server store's backup copy keeps no login state; a restored
host starts "Not connected" and needs a new login. Runtime
update snapshots stay on the host and keep them sealed with the other credentials,
so a rollback keeps logins; every login logged out since the snapshot is logged out
again after the rollback, before the Gateway starts (see
[runtime updates](assistant-runtime-updates.md)). The facts behind this section are
recorded in the [MCP OAuth qualification](mcp-oauth-qualification.md).

## GitHub for agents

An agent works on GitHub with one of the owner's token profiles from **Connections › GitHub connections** (AGENTPIER-129). The Access tab's **GitHub** page chooses the level
(**No access**, **Read**, **Read and write**) and the profile; the host's **Default
for agents** is preselected. The access is stored with the agent's access record
(`github: { credentialId, level }`), audited as `assistant.updated` with
`kind: "github-access"`, the profile id and both levels (never the token or the
profile's name), and named in the agent's instructions (profile, host, level and its
tool prefix). Temporary members cannot hold one of their own (409; they get it from
their lead's `github` grant); an agent with its own Telegram bot
for other people is refused it (409), and an agent with GitHub
access counts like one with a stdio server, so no such bot is compiled for it.

### MCP server

The official [GitHub MCP server](https://github.com/github/github-mcp-server) is
compiled beside the central list's servers, one stdio server per profile and level,
named `github_ro_<hash>` or `github_rw_<hash>` (the hash comes from the profile id).
An agent sees its tools as `<name>__<tool>`.

| Level   | Arguments (toolsets `repos,issues,pull_requests,actions` for both) |
| ------- | ------------------------------------------------------------------ |
| `read`  | `stdio --toolsets … --read-only`                                   |
| `write` | `stdio --toolsets …`                                               |

`write` gets every tool of these toolsets, with no exclusions: issue and pull request
writes and repository contents, including merging pull requests
(`merge_pull_request`), pushing (`push_files`) and deleting files (`delete_file`);
it triggers, re-runs and cancels workflows (`actions_run_trigger`) and creates, forks
and deletes repositories (`create_repository`, `fork_repository`,
`delete_repository`). The tool names were checked against the pinned 2.0.2 release.
The server itself hides tools whose classic scopes the token lacks (for example
`delete_repo` for deleting a repository), and 2.0.2 offers `delete_repository` only
when a request-state key (`GITHUB_MCP_SERVER_MRTR_STATE_KEY`) protects its
confirmation round trip, which AgentPier does not configure: an agent with shell
access can still delete a repository with `gh repo delete` when the token allows it. The token reaches the server only through its environment
(`GITHUB_PERSONAL_ACCESS_TOKEN`; `GITHUB_HOST` for a GitHub Enterprise host) in the
compiled `openclaw.json`, like every stdio server's values: never in its arguments,
the agent's instructions, a response or AgentPier's own state. Because OpenClaw
starts every compiled stdio server for every session (see
[stdio servers](#local-commands-stdio)), agents that share a profile and level share
one server. Each distinct profile and level still costs one server process per OpenClaw
session, about 45 MB of memory each; read and write stay separate servers because the
server-side `--read-only` is the stronger limit. A store server with the same name
wins.

A rotated token, a deleted profile and every access change are patched into a running
Gateway at once (the compiled signature includes the env values) and the affected
agents are re-applied; a deleted profile removes the server. A lead's grant change
converges at the next scheduler tick. Members get the lead's server at the lower of
both levels.

**Installation.** The server is a managed tool below `<data>/clis`: a pinned release
(`server/features/tools/github-mcp-manifest.js`, version and per-platform SHA-256 and
size for macOS and Linux on x64 and arm64), unpacked to `clis/.packages/github-mcp-*`
and activated through the `clis/github-mcp-server` link after its `--version`
matches. AgentPier installs it in the background when an agent first gets GitHub
access; the Access tab shows the state and **Try again** after a failure. An AgentPier
update that pins a newer version updates an installed server at the next server start
and through the installer (`setup.sh`, `release-install.mjs`); the previous version
stays until the next update, so running servers keep their files. Without the server
the agent has no GitHub tools, and its instructions say so.

**Token scopes.** When a profile's token check records its classic scopes, the page
warns if `repo` is missing. Fine-grained tokens report no scopes and are not checked;
their permissions set the limit.

### Shell

An agent with shell and GitHub access gets its own folder
`<data>/github-sessions/agent-<id>/`, laid out like a session's (`config.yml`,
`hosts.yml` with the token, `selection.json`), plus `shell-env.sh` and `bin/`
(empty, except for the read-only push helper described below). `bin/` comes first in the agent's `tools.exec.pathPrepend`. OpenClaw starts
the shell without those entries on `PATH`: it passes them as `OPENCLAW_PREPEND_PATH`
and exports them inside the command string. The exec wrapper (`exec-shell.js`)
therefore looks in `OPENCLAW_PREPEND_PATH` first and then in `PATH`, and sources
`shell-env.sh` from the first such entry. It sets
`GH_CONFIG_DIR` to the folder, unsets `GH_TOKEN`, `GITHUB_TOKEN` and the other
override variables, and routes git's HTTPS authentication for that host through
AgentPier's helper alone (`credential.https://<host>.helper` and
`gist.<host>`, owner helpers cleared, the quit helper after it; the shared
`gitCredentialConfig()` with the stable helper location of sessions, started with
`--session <folder>` like an owner shell's), plus the profile's commit identity and, for a GitHub
Enterprise profile, `GH_HOST`. The same directories (the marker and the managed
`gh`) also feed the approval analysis, so **Always allow** resolves `gh` as it runs. `shell-env.sh` holds no
token, so `env` in the agent's shell shows none; `gh` and the helper read it from
`hosts.yml`. Token rotation and deletion update `hosts.yml` with the sessions' sync. An
agent without shell or without GitHub access has no folder on its `PATH`, and the
folder is removed at the next refresh or Gateway start. The token never appears in the
agent's instructions or files, but with shell access the agent runs as the owner and
can read it like the owner can. Like sessions, this separates
configurations, not operating-system users: a command with shell runs as the owner.

At the **Read** level, `git push` from the agent's shell to the profile's host
fails with a clear message, while fetch, clone and pull keep working.
`shell-env.sh` then also sets
`url.agentpier-read-only://<host>/.pushInsteadOf` for `https://<host>/`,
`git@<host>:` and `ssh://git@<host>/` (and `gist.<host>` over HTTPS), and `bin/`
holds the remote helper `git-remote-agentpier-read-only`. git therefore pushes to
the `agentpier-read-only://` URL, and the helper prints "AgentPier: this agent has
Read access to GitHub; pushing is not allowed. Ask the owner for Read and write." and
exits with status 1. **Read and write** sets neither. The folder is written again
whenever the agent is re-applied, so a level change in **Access › GitHub** reaches the
next command (`github-credentials.js` `prepareAgent`). This is best effort, not a
sandbox: the agent runs as the owner, and a remote with an explicit `pushurl`, other
git configuration or another URL form for the same host (an SSH host alias, for
example) bypass it. The shell's `gh` is not limited: it uses the profile's token with
everything that token allows (`gh pr merge`, `gh api -X POST`). The agent's
instructions state its level and, for **Read** with shell, that pushes are refused
and that it must not change anything with `gh`; only a token without write permissions enforces
**Read** on GitHub itself.

## Agents of restricted users

The owner creates agents for restricted users with `POST /api/user-agents`. The body is
the agent create body plus `userAccess`. He changes whom they serve with
`PUT /api/user-agents/:id/access {userAccess, revision}`. `userAccess` is
`{ mode: "own" | "shared", members: [{ userId, level }], released }`: an own agent has
exactly one member, a shared agent one or more. A level is `chat`, `personalize` or
`extended`. `released` lists the web capabilities an Extended user may switch on
herself. The Gateway compiles a released capability like a switched-on one (its web
sections and her browser profile, `native-capabilities.js` `releasedCapabilities`), so
her own switch applies live. A release applies live as well, unless the running
Gateway started without what it needs (a browser installed later): then it is saved
and the restart is left [pending](#pending-restart). A new user agent starts without
the releases the running Gateway would need a restart for. The owner's existing agents never become user
agents: assigning one answers 409 `USER_AGENT_REQUIRED`. An own agent stays with its user: changing its member or turning
it into a shared agent answers 409 `USER_AGENT_OWN_FIXED`, because its memory, files and
browser profile are hers and would reach the owner or another user without her opt-in.
Only her level and `released` change. A shared agent may become an own agent; the
owner's chat on it then stays readable to him but takes no new turns, and his
reminders, routines and Telegram bot on it end, since they would run over her memory,
`USER.md` and browser profile and deliver to him. Both routes are
owner routes, so a user gets the unknown-route 404 for them.

Every agent with `userAccess` runs under a hard lock, whatever its stored settings say:

- **Compiled tools.** `agentEntry` applies `lockedEntry`
  (`server/features/users/user-agent-lock.js`) last, on a Gateway start and on every
  live apply. The entry's `tools.allow` loses `exec`, `process`, `agentpier_ssh`,
  every team tool and every OpenClaw session tool, its `tools.deny` names all of them,
  and it has no `tools.exec` override. `AgentGithub` compiles no GitHub MCP server
  for it and describes no GitHub access, even when its stored access names one. This
  holds for a forged shell level or GitHub access in the database as well. Its browser
  profile is always compiled headless, even when its stored `browserVisible` is true.
  On the pinned Gateway the deny wins over the allow list on its own, and
  `tools.effective` for the agent's sessions lists none of the locked tools while
  its web and workspace file tools stay
  (`tests/integration/assistant-user-agent-lock-contract.test.js`). A live apply for
  an agent that is no user agent any more (an own agent kept as the owner's) removes
  the deny again (`tools.deny: null` with its path in `replacePaths`).
- **Run time.** The team plugin's `before_tool_call` hook asks the bridge
  (`/tool-policy`) before every call of `exec`, `process` and the session tools
  (`lockedCoreTools`), for every agent; for a user agent the bridge answers
  `allow: false` and the call is blocked, as it is when the bridge cannot be reached.
  Team and SSH bridge calls of a user agent answer 403.
- **Settings APIs.** Every write that would switch one of them on answers 409
  `USER_AGENT_LOCKED`: a shell level or the visible browser window, SSH accesses,
  pipelines, GitHub access, coding grants, project memory rights, a team policy or
  proposal, and a Telegram bot for other people. The Gateway compile never builds a
  Telegram account or binding for a user agent either, even from a stored bot, and its
  bot status stays inactive.
- **Allowed.** Registered MCP servers the owner binds (stdio servers with the usual
  confirmation), the web capabilities, memory, reminders and routines.
- **Project folders.** A user agent holds folder levels (`projectFiles`) without the
  coding grant (`projectIds` stays empty). Through `agentpier_workspace` it lists,
  reads and, with write access, changes files there, in the owner's turn and in the
  user's own turn (trusted origin `{ kind: "user", userId }` of one of its users).
  Writes into configuration that the owner's tools run (`.claude/`, `.codex/`,
  `.gemini/`, `.opencode/`, `.agents/`, `opencode.json(c)`, `.cursor/`, `.vscode/`,
  `.idea/`, `.devcontainer/`, `.husky/`, `.githooks/`, `.mcp.json`, `.envrc`,
  `.pre-commit-config.yaml`, every lefthook file name, mise's `mise.toml` and its
  variants) and into the instruction files
  his coding CLIs load from the working tree (`CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`; the list is `toolConfigNames` in
  `project-paths.js`), at any depth and in any case and also through links, answer 403
  `PROJECT_TOOL_CONFIG_LOCKED`; reading them stays allowed. So do the places the
  repository itself names, read at every such write (`project-config-lock.js`), for
  the folder's repository, each of its linked worktrees (a relative hooks path counts
  per worktree) and every nested repository: `core.hooksPath`, the Git config files
  its config includes (`[include]`/`[includeIf]` `path`) when they lie in the folder,
  lefthook's script folders (`.lefthook/`, `.lefthook-local/` and its
  `source_dir`/`source_dir_local`), the files that instruction files anywhere in the
  folder import with `@path` (followed five hops deep) and the paths and globs in
  OpenCode's `instructions`. A folder with more than 10,000 subfolders (dependencies
  and Git internals not counted) cannot be searched completely, so every write there
  is locked. Other files the owner runs
  later (scripts, `package.json`, Makefiles) stay writable
  ([security notes](agents.md#security-notes)).
  Coding, project memory and run actions answer `USER_AGENT_LOCKED`. A project rebind
  or merge drops these levels like an owner agent's grants, with the same
  `project-rebind` audit record; they never come back with the old project id.
- **Memory.** A user's own turn (trusted origin `{ kind: "user", userId }`) writes
  memory like the owner's own turn. Forwarded content does not. A shared agent has one
  memory for all its users. A saved write to its `MEMORY.md` or `memory/` leaves a
  "shared-write" note in the chat of the turn that wrote it, and only there. `USER.md`
  stays the owner's. The pre-compaction flush and the memory step before **Summarise
  now** write a shared agent's memory like a saved write, from a user's or the owner's
  own chat or a routine's run, with the same "shared-write" note in the writing chat
  only (a routine's: its chat); a forwarded turn's flush, or one of a user who left the
  agent, is still refused. The shared-agent notice says that what is written in a chat,
  also word for word, can be carried into the shared memory that all its users and the
  owner read; [dreaming](#dreaming), when on, does the same over all its chats.

### Private chats of restricted users

Each person has her own main chat with an agent, and so her own native session: the
owner's conversation has no `userId` and the Gateway label `AgentPier <agent id>`, a
user's carries her `userId` and the label `AgentPier <agent id> <user id>`
(`server/features/assistants/conversation-open.js`). Two users of a shared agent never
share a transcript; the memory stays one. The owner has his own chat with a shared
agent, but none with a user's own agent (404).

A user reaches her agents only through `/api/me` (`server/http/routes/me-*.js`), and
every handler resolves its target through `UserScope` (`server/features/users/user-scope.js`)
first: her conversation (hers, on an agent she still belongs to; an archived one stays
readable), her agent, her attempt, her chat file. Anything else, also a deleted chat,
answers the unknown-route 404.

- `GET /me/agents`, `POST /me/agents/:id/conversation` (her main chat), her chat list
  (`GET|POST /me/agents/:id/chats`; rename, archive, restore and delete under
  `/me/conversations/:id`, see [Several chats per agent](#several-chats-per-agent));
  messages, the queued message,
  cancel, attachments and shared files under `/me/conversations/:id/…`,
  `/me/attempts/:id/cancel` and `/me/attachments/:file`. A user's turn and her queued
  message run with the trusted origin `{ kind: "user", userId }`; she never starts team
  work. Every turn in a user's chat (web, her Telegram bot, queued) reaches the Gateway
  as plain text: `sessions.send` would run a leading `/restart`, `/update` or `/model`
  as an owner's OpenClaw command and inline `/model …` as a directive, so a word joiner
  (U+2060) goes before each `/` or `!` that starts a word
  (`server/features/assistants/plain-turn-text.js`); the chat history drops it again. The chat WebSocket admits her own conversation and closes (1008) once she is
  unassigned. An uncertain or interrupted turn in her chat blocks it like the owner's;
  she reviews it herself (`POST /me/attempts/:id/recover`, body
  `{acknowledgeUnknownOutcome: true}`): unlike the owner's recovery it never restarts
  the Gateway every agent shares, but aborts her run in her own session first, since a
  send that timed out may still run there, and only then marks it reviewed (409 while
  the Gateway does not take the abort, 503 while it is away). The owner never reviews
  her turns (404). A turn nobody can review any more (its user deleted, disabled or
  removed from the agent, or the owner's on what became a user's own agent) is settled
  by reconciliation the same way, so it never blocks runtime updates or the agent's
  settings.
- `GET|PATCH /me/agents/:id/settings` within her level
  (`server/features/users/user-agent-settings.js`): nothing at **Chat only** and on
  shared agents; name, picture (`avatar`, one emoji) and instructions at
  **Personalize** on her own agent; at **Extended** also the capabilities the owner
  released. A field beyond her level answers 403 `USER_LEVEL`, a locked one 400. Changes
  are audited with her id and the field names, never the values. Released capabilities
  are compiled in advance, so her switch needs no Gateway restart; a Gateway started
  before the release still needs one, which stays the owner's decision: her change
  answers 409 `USER_AGENT_RESTART_NEEDED` and is not saved.
- `GET /me/agents/:id/memory` and `/memory/:name` read the notes (the list pages like
  the owner's `/memory/files`, see [Dreaming](#dreaming)); deleting a note
  (`DELETE /me/agents/:id/memory/:name`) needs **Personalize** on her own agent.
- Reminders and routines (`/me/agents/:id/reminders|routines`) belong to the person
  whose chat created them (`server/features/assistants/reminder-audience.js`): a
  binding carries `userId`, delivers into her main chat and to her devices, and only
  she sees and changes it, from **Personalize** on. A routine's **May write** stays
  the owner's switch; her routes ignore `writes`, and her agent's routine tool
  refuses it (`ROUTINE_WRITES_OWNER_ONLY`). The agent's reminder and routine
  tools take the person from the chat of the calling turn, so concurrent turns of two
  users never mix them. The owner's settings of a shared agent list only his own;
  check-ins are off on shared agents and go to the user of her own agent.
- Approvals go to the person in whose chat they arose
  (`server/features/users/approval-audience.js`): `GET /me/approvals`,
  `POST /me/approvals/:id/decision`, audited with her id and `actor: "user"`, as is a
  decision from the buttons of her own bot (`channel: "telegram"`). The owner's inbox,
  push notices, action lists and decision route never show or decide them (404). A
  user agent's chat shows only its own approvals.
- The browser follows the turn that drives it (`BrowserLiveView.driver`): the tool
  guard reports the calling session, and a user watches and takes over her own agent's
  browser, or a shared agent's only while her turn drives it. The owner watches a shared
  agent's browser only while no user's turn drives it. A routine run drives it for the
  person whose routine it is; any other run of a user's own agent for her. A user's hold
  ends ten minutes (the hand-back lease) after her turn's last browser call, or once a
  takeover then in progress ends, and the browser is the owner's again. Open views
  close when it changes hands; the hand-back note goes into the chat whose turn drove the
  browser, or the driver's main chat once that chat is archived or deleted. Under her
  opt-in the owner watches her own agent's browser, view-only (`VIEW_ONLY`, also for
  `select` and `follow`: he never moves the tab she sees and types into); a view he
  opened to drive a shared agent closes with 4000 once it becomes her own, and the page
  reconnects at once, view-only. His views close (1008) once she turns the opt-in off.
- Push devices belong to one person (`subscriptions.user_id`, data schema 2):
  `/me/notifications…` mirrors the owner's routes for her own devices. A notice with
  `audience: { kind: "user", userId }` reaches only her devices; system notices only the
  owner's. Presence, its report rate limit and quiet hours count per person.
- `GET /me/events` streams `agents` (her list or one of her main chats changed; an
  agent works while any of her chats with it does), `chats` (`agentId`: her chat list
  with that agent changed, never another person's), `telegram` (`agentId`: her own
  agent's bot changed, for example its pairing finished in Telegram) and `approvals`
  (`count`) frames, with a heartbeat every 15 seconds. The count holds the
  approvals `GET /me/approvals` lists, so one in a chat she left no longer counts. A
  stream opened while agents are off ends once they start (and when they stop), so
  her app reconnects to one that follows them.
- At **Extended** she connects her own agent's Telegram bot to her main chat
  (`/me/agents/:id/telegram`, `PUT {token}`, `POST …/pair`, `DELETE`) in her agent's
  settings, under **Telegram**. The token is never returned; `connected` says whether
  one is stored, and `paired` that the bot is paired and delivering (a paused bot shows
  unpaired, so her app offers pairing again). After `DELETE`, a `PUT` with the same
  bot's token connects it again with its pairing and turns it back on; another bot's
  token replaces the disconnected one, unpaired, but only once the new bot is known to
  be free: a bot another channel or a bot for other people uses answers 409 and leaves
  her old bot and its pairing in place. Shared agents
  and lower levels answer 403 `USER_LEVEL`; Telegram for other
  people stays unavailable on user agents. When the owner lowers her below **Extended**,
  her bot is removed with its token and texts. Her bot's approval buttons decide her
  approvals. The owner's `GET /api/assistant-channels` shows her bot's Telegram chat and
  texts only under her opt-in, from its `since`. The owner's own bot on a shared agent
  delivers into his own chat there; he pairs, changes and removes it like any of his
  bots.

The owner's privacy guard (`server/http/owner-content-guard.js`,
`server/features/users/owner-privacy.js`) resolves every content route of
`owner-content-routes.js` to its conversation or agent. Without the user's opt-in
**Owner may read chats** (`PUT /api/users/:id/owner-may-read {enabled}`, audited) her
chats, and the memory, attachments and browser of her own agent, answer 404, and his
agent list and event stream leave her conversations out. With the opt-in her own
agent's memory, files and browser become readable in full, older entries included,
and he reads her chats from its `since` on, never earlier, in history, feed snapshots, the chat stream, her
queued message and chat file downloads; older history pages stay reachable until a
page reaches back past `since`. Only what lies after `since` counts: a chat, turn,
message or file stamped in the same millisecond may predate the switch and stays hers.
A message she queued, or one her Telegram bot held in
its inbox, counts from when she wrote it (the request's `writtenAt`), even once it goes
out after the opt-in; the reply its run writes stays hers too, in the history and as
streamed reply text. He never writes into her chat, decides her
approvals or re-pairs her bot, and her pending approvals never count in his agent
activity. The guard matches paths like Express does (trailing slashes, any letter case).
His agent list marks a user's own agent with `ownerReads`: without it his settings show
a notice instead of its notes and browser, with it they show read-only (notes, live
view); its reminders and routines stay hers to manage in her app.
Turning it off closes his open chat streams (1008); turning it on again after it was off
starts a new `since`, while switching it on while on keeps the first. The user
sees the state in `GET /api/me`; her event stream sends `account` when it changes, so
her open chats, her account page and her agent's browser view say so at once.

Deleting a user (`DELETE /api/users/:id {agents: "archive" | "keep"}`, 400
`USER_AGENTS_CHOICE` without a choice while she owns agents; 409
`USER_AGENTS_KEEP_PRIVATE` for `keep` without her opt-in, since a kept agent hands her
memory, `USER.md`, files and logged-in browser to the owner; 503 `USER_AGENTS_OFF` while
agents are switched off but their store exists, since only the running agents can
release her data) archives her own agents or
keeps them as the owner's (`userAccess: null`, settings unchanged), removes her from
shared agents, ends her reminders and routines, deletes her devices and sessions, and
archives her chats with their native sessions, cached messages, files, message
texts and the delivered results of her reminders and routines, clears what she wrote
into her ended reminders and routines (`definition`), and removes her own Telegram bot with its token and texts. Under her opt-in the
chats stay, marked `deletedUser`, readable from its `since`. No new turn enters an
archived or deleted user's chat, nor the chat of a user who left the agent. When the
owner moves a shared agent to other users (`PUT /api/user-agents/:id/access`), whoever
left it loses her reminders, routines and bot on it. Her reminders, routines and
check-ins are revoked at once and their native jobs removed; while the Gateway is away,
the next Gateway start removes them, so no job keeps running turns in her old chat.
One she created while her deletion ran is ended the same way once she is released. Her
chats' native sessions are deleted the same way: a chat whose session the Gateway could
not delete keeps `nativeDeletePending`, and the next Gateway start deletes it. Her
released chats are marked `userReleased`: reconciliation and history reads never read
their native session back into AgentPier, a runtime update's validation does not look
for it, and a successful native delete forgets her
cached messages, texts and files once more.
Disabling a user (`PATCH /api/users/:id {disabled: true}`) ends her sessions and,
like her deletion, her reminders, routines, check-ins and bots (disabled while agents
are off, they end when agents start, before any of them runs); her agents and chats
stay, and her chats take no new turns while she is disabled; her own agent schedules
no check-ins again for a disabled or deleted user. Enabling her again
restores her sign-in only.

### Several chats per agent

The web UI (`web/features/assistants/chats/`) shows them in a **Chats** sheet from the
chat's title, for the owner and in a user's app alike: New chat, the main chat first,
archived chats apart, Rename, Archive, Restore and Delete; an archived chat opens
read-only, a deleted chat's link leads to the main chat ([Chats](agents.md#chats)).

Every agent, the owner's and users' alike, holds several chats per person
(AGENTPIER-181; `server/features/assistants/agent-chats.js`). A chat is one AgentPier
conversation with its own native session from `sessions.create`, labelled
`AgentPier <agent id> chat <conversation id>` so labels stay unique. New chat never
uses OpenClaw's `/new` or `sessions.reset`: both keep the session key and start a fresh
history window (`tests/integration/assistant-multi-chat-contract.test.js`). Memory stays
one per agent.

- The person's **main chat** (`main: true`) is the first one, the one
  `POST …/conversation` opens. Reminders, routines, check-ins, Telegram pairing and lead
  routine reports deliver only there (`mainConversation`,
  `server/features/assistants/routine-targets.js`), and push notices of those results
  open it. A chat stored before several chats existed becomes its person's main chat on
  first read, without a new native session. The main chat cannot be archived or
  deleted (409 `CHAT_MAIN`).
- Lists: the owner's `GET /api/assistants/:id/chats` (`?archived=1` for the archived
  ones) and a user's `GET /api/me/agents/:id/chats` return `{id, title, main,
archivedAt, lastActivityAt, busy}` (the owner's also `userId`), the main chat first,
  then the most recently active. `POST` on the same path starts a chat (201); every
  level may start chats. A user lists only her own chats. The owner lists his own and,
  under a user's opt-in, her chats that were active since its `since`; a chat she
  started before it shows without its title. Activity is every turn and every run's
  end, also a reminder, routine or check-in delivered natively; a chat stored before
  AgentPier recorded activity counts as possibly active and shows. The agent list (`GET /api/assistants`
  and its event feed) holds her chats by the same rule (`OwnerPrivacy.view`).
- Titles: the first written turn (web or Telegram) names the chat, also a chat stored
  before titles existed, which takes its first message, not the turn just written, whitespace collapsed
  and cut at a word to 60 characters (`server/features/assistants/chat-titles.js`).
  AgentPier's browser hand-back note, queued as the person's turn, never names a chat.
  `PATCH /api/assistant-conversations/:id` and `PATCH /api/me/conversations/:id` with
  `{title}` set 1 to 80 characters without control or format characters (bidi
  overrides, zero-width spaces; emoji joiners stay), the ones an automatic title drops; `""` brings the
  automatic title back. Titles never reach the audit log. Typed into a chat, `/new`
  opens a new chat (201 `{created}`; a retry with the same `clientRequestId` returns the
  same chat, also while the first is still opening it and after a restart: the chat
  stores the request as `openedBy`) and `/name <title>` renames it (200 `{chat}`); nothing reaches the Gateway.
  `/reset` and `/new` with text answer 400 `CHAT_COMMAND`. Queued while the agent works,
  `/new` and `/name` answer 400 `CHAT_COMMAND_QUEUED`, `/reset` and `/new` with text 400
  `CHAT_COMMAND`, and queued text is always sent as
  a turn, never run as a command. A rename made while a first message is being admitted
  keeps its set title. Telegram turns are passed on as before.
- Generated titles (`server/features/assistants/generated-titles.js`): once the attempt
  of a chat's first written turn (owner, user or Telegram, not a forwarded message)
  completes with a reply, AgentPier asks the agent's own model for a title of 3 to 6
  words in the message's language from the message and the reply's start, each cut to
  2,000 characters. Routine, reminder, check-in and team turns never ask; neither does
  a first turn that failed or ended without a reply. The request is the product
  plugin's admin-only Gateway method `agentpier.chatTitle`
  (`server/features/assistants/team-plugin/chat-title.js`): OpenClaw's
  `api.runtime.llm.complete` in `isolated-agent-runtime` mode with the agent's id, so
  the agent's own model and login run one system and one user message with no tools,
  no session, transcript, memory or workspace, 30 seconds at most, thinking off where
  the model allows it. It is no turn: nothing reaches the ledger, the chat, its run
  steps, its native session, the write guard or the team logic. The compiler sets
  `plugins.entries.agentpier-teams.llm.allowAgentIdOverride`, which OpenClaw requires
  for a completion on another than its default agent; without the product plugin the
  method is missing and the chat keeps its first-message title. The answer is
  untrusted: its first line after any lead-in ("Here is a title:") without reasoning, markdown, a "Title:" label, quotes,
  trailing punctuation and the characters a set title refuses, and is dropped when
  nothing readable is left or it exceeds 80 characters or 12 words. It is stored as
  `titleSource: "generated"` (and `generatedTitle`) only while the chat still carries
  the automatic title it had when AgentPier asked; a rename in the meantime wins. A
  failure, timeout or unusable answer keeps the first-message title and logs only the
  chat id and an error code (OpenClaw's own, such as `LLM_COMPLETION_TIMEOUT`, which
  the plugin answers as the whole message of an `UNAVAILABLE` error and
  `gateway-client.js` keeps as `remoteCode`). Each chat is decided once: when its first
  written turn's run completes, AgentPier records `titleTried`, whether it asked or the
  turn had no reply or was forwarded; a failure is not retried on later turns, and
  later turns read nothing more. Chats named before this feature keep their titles.
  `""` brings back the generated title, else the first-message one. The plugin drops
  `<think>` reasoning from the model's text before it cuts the answer to 400
  characters. The change reaches open lists as a `conversation` event; owner privacy hides a generated
  title exactly like any other.
- Archive and restore: `POST …/conversations/:id/archive|restore` (owner under
  `/api/assistant-conversations`, user under `/api/me/conversations`). An archived chat
  leaves the list, stays readable, and refuses turns, queued messages, uploads and
  renames with 409 `CHAT_ARCHIVED` until it is restored. Archive state lives in AgentPier
  only: every `sessions.create` session is an OpenClaw dashboard session, which
  OpenClaw's maintenance would archive after 7 idle days, and a natively archived
  session takes no turn and no routine, reminder or check-in commit, so the compiled
  configuration sets `session.maintenance.archiveDashboardAfter: false`.
- Native archiving (AGENTPIER-183, `server/features/assistants/native-chat-archive.js`):
  OpenClaw still archives a session idle for `pruneAfter` (30 days by default, reason
  `age-retention`) or beyond `maxEntries` (`active-session-cap`), main chats included,
  and SQLite recovery can archive one (`restart-recovery`). Neither switch can be
  limited to dashboard sessions, and turning `pruneAfter` off would also keep stale
  cron, hook and heartbeat rows. A pinned session is exempt from all automatic
  maintenance, so reconciliation pins every chat, AgentPier-archived ones included,
  once per Gateway connection (`sessions.describe`, then `sessions.patch {pinned:
true}`), and reopens one OpenClaw archived anyway in the same call (`{archived: false, pinned: true,
expectedSessionId}`): the session keeps its key, id and transcript. A keep that fails
  (a Gateway error, or a concurrent reset that changed the session id) is logged once
  per connection and tried again by the next pass. A turn the Gateway refuses with
  `INVALID_REQUEST` because its session is archived (web, Telegram, queued) reopens
  the session the same way and is sent once more with the same idempotency key, also
  when a reconcile pass reopened it meanwhile (the refusal reads `Session "<key>" is
archived.`); the refusal comes before any run starts, and other refusals are not
  sent again. A pinned session
  deletes like any other. AgentPier's own archive never archives natively: an
  AgentPier-archived chat stays read-only and unsubscribed, but its session is pinned
  (and reopened) so OpenClaw's entry cap and disk budget cannot archive or delete it
  and its transcript. Deleted chats and released users'
  chats are never reconciled, so they are not reopened
  (`tests/integration/assistant-multi-chat-contract.test.js`).
- Reconciliation reads no archived chat unless work still reports into them, so
  they cost only the one keep per connection. A full pass (at readiness, after maintenance, on a cancel)
  subscribes and reads every other chat; the 2-second poll and a run's end read only the chats that need it: with work
  underway, a live feed, a run that just ended there, a session failure due for its
  retry or no subscription yet on this connection (`chat-reconcile.js`), so a pass
  costs what is underway, not the number of chats.
- Delete: `DELETE …/conversations/:id {confirm: true}` (400 `CHAT_CONFIRM` without it)
  marks the chat deleted, so every route answers 404, closes its open views, forgets
  its cached messages, request texts, files, shared files, routine results, memory notes
  and queued message, and deletes its native session with `deleteTranscript: true` and
  what OpenClaw keeps of it (`server/features/assistants/chat-removal.js`): the
  `<session id>.jsonl.deleted.*` archive files in `state/agents/<agent>/sessions/`,
  the compressed archive copies in the agent's database (`session_transcript_archives`
  in `state/agents/<agent>/agent/openclaw-agent.sqlite`) and the session's Goal
  receipts there (`session_goal_operations`, which quote a Goal's text). OpenClaw
  2026.10.3 and 2026.10.7 remove archive rows only under their disk budget or an age
  rule and offer no call for one session, so AgentPier deletes exactly the rows of the
  chat's session key or session id beside the running Gateway (`transcript-archives.js`):
  one short write transaction with `secure_delete`, a 250 ms lock wait, no checkpoint of
  its own (`wal_autocheckpoint = 0`), and a connection that never creates a database.
  The archive table and its columns are checked first; a missing table or other columns
  fail the purge (`ARCHIVE_SCHEMA`) rather than report success. A failed purge (locked,
  unsafe or drifted database) is logged with its code and SQLite's error code only, and
  the chat keeps `nativeDeletePending`. A Gateway that is away, or a purge that failed,
  is retried at the next Gateway start. The session id that names the archive is
  recorded on the chat (`nativeSessionId`) before the delete, and the mark stays until
  the archives are gone, so a retry after a lost delete answer or a restart still
  removes them; a chat without a recorded id is purged by its session key, since
  2026.10.7 answers `sessions.delete` for a deleted session with `deleted: false` and
  `sessions.describe` with `session: null`. Chats deleted, and users' chats released,
  before this purge existed are marked `nativeDeletePending` once
  (`assistant_migrations` marker `transcript-archive-purge`), so the next start purges
  their archives too. `tests/integration/assistant-chat-deletion-contract.test.js`
  proves on 2026.10.7 that afterwards no file, row or decoded archive below
  `assistants/` names the chat's text, for short chats (also one reset with
  `sessions.reset`, which keeps the earlier window in the session and writes no
  reset archive), an empty chat and a chat deleted before the purge; chats with Goals
  and OpenClaw's cold storage (`session.maintenance.coldStorage`, off by default and
  not set by AgentPier) are not covered by it. Free pages of the agent's database and
  its WAL may still hold bytes of rows OpenClaw deleted, and old pages of the archive
  just removed, until SQLite overwrites them; backups made before the deletion keep
  what they held. Audited as `assistant.updated` with `details.kind:
"chat-deleted"`, never the title. The record keeps no title or last activity
  (cleared under `secure_delete`). A deleted user's chats go the same way. Whatever
  of a deleted chat a failed file removal left behind never serves to the owner. Its
  approvals stay its person's (`approval-audience.js`) and never list for the owner.
  Once the session and its archives are gone, dreaming's copies of the chat are
  forgotten with `openclaw memory forget` ([Dreaming](#dreaming)).
- Archive and delete answer 409 `CHAT_BUSY` while a turn runs, a message waits or an
  approval waits in the chat, while an action still owes it a follow-up turn (an
  allowed SSH command whose call already returned, a team member's coding run, an
  unsaved project-knowledge write), and while a team or lead request started from it
  still has to report into it (members working, a result not yet sent). A team member
  agent's chat belongs to its team and is never archived or deleted (400), like no
  further chat is created for it. Only the chat's own person changes it: another user and
  the owner, even under her opt-in, get 404 for a user's chat.
- Archiving or deleting a chat sends its live viewers `end` (the WebSocket closes with
  1001); an archived chat may be opened again read-only.

## Agent shell access (2026-10-12)

Agents can run command-line programs on the host through OpenClaw's `exec` and
`process` tools (AGENTPIER-25). The facts behind this section are recorded in the
[shell qualification](assistant-shell-qualification.md).

### Levels

Each personal agent and each permanent team member has a shell level in its
settings (**Shell access**). New agents start with **Off**.

| Level         | Compiled for the agent                                | Behavior                                                        |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Off           | no `exec` or `process` in the agent's `tools.allow`   | The agent is offered no shell tool at all.                      |
| With approval | `tools.exec: { mode: "ask", strictInlineEval: true }` | Every command not on the agent's allowlist waits for the owner. |
| Full access   | `tools.exec: { mode: "full" }`                        | Every command runs at once, without asking.                     |

Both shell levels also carry `pathPrepend` (see below). While any eligible agent
has shell, the global `tools.allow` includes `exec` and `process`; the global
`tools.exec.mode` stays `deny`, and an agent without shell keeps both tools out of
its own `tools.allow`, because a global `deny` alone still offers the tool.

- **Agents of restricted users never have a shell level.** See
  [Agents of restricted users](#agents-of-restricted-users). The compiler treats any
  stored level as Off, and the agent update refuses any other level with 409
  `USER_AGENT_LOCKED`.
- **Temporary (task-bound) team members have no shell level of their own.** The
  agent update refuses any level other than Off with 400, the compiler ignores a
  stored level, and the allowlist routes refuse them. They get at most their lead's
  level only when granted while the lead's **Team members may use shell and SSH** is on (see
  [Team member grants](#team-member-grants-2026-10-17)). Archived agents
  have none.
- **Confirmation.** Raising the level needs the owner's confirmation of the
  warning (`confirmShell`); raising it to Full access needs a second one
  (`confirmFull`). Without them the update (and the creation of an agent with
  shell) answers `409 ASSISTANT_SHELL_CONFIRMATION_REQUIRED` naming the missing
  confirmations, and nothing is stored. Lowering never asks.
- **Live changes.** Every level change applies to the running Gateway with
  `config.patch`, without a restart. Lowering applies even while a turn of the agent
  runs; a settings form that also sends its unchanged fields counts as a lowering
  only. Switching to Off first denies the agent's requests still awaiting the
  owner (their actions end with diagnostic `SHELL_OFF`; a deny the Gateway could
  not receive is sent again at the next ready), then aborts the agent's running
  turns, which ends a command running in the foreground. **A command moved to the
  background (`process`) keeps running:** OpenClaw 2026.9.8 offers no way to end
  background sessions from outside the agent's own `process` tool, and neither an
  abort nor a session reset stops them. A Gateway stop or restart (including stopping or
  updating AgentPier) ends them on Linux, where OpenClaw starts commands through
  its spawn broker, which terminates its children when the Gateway goes away; on
  macOS they keep running (see the
  [shell qualification](assistant-shell-qualification.md#h-aborting-turns-and-background-commands)).
  If a lowering cannot be
  applied, AgentPier tries once more, then aborts the agent's running turns and
  denies its pending requests, so nothing keeps running at the higher level; the
  level stays pending (shown in the settings) and is retried with backoff and at
  every ready. A stopped Gateway compiles the stored level at its next start.

**Warning shown before shell is turned on:** with shell access the agent works as
the owner's user account, with the owner's logins, files and keys, and it can read
AgentPier's own data. The team write guard does not cover shell commands. There is
no sandbox (see [ADR 0002](adr/0002-managed-openclaw-assistants.md)). With Off, the
settings explain that skills and tools needing command-line programs (gh, git, mail
programs) do not work.

### Environment of shell commands

Commands run as the owner: **with the owner's real `HOME` and login `PATH`, while
the Gateway itself keeps its private `HOME`, state and configuration.**

- OpenClaw has no exec environment setting and refuses a per-call `HOME`, so every
  Gateway start points its `SHELL` to a wrapper,
  `<data>/assistants/exec-shell/sh` (mode 0500 in a private folder), that exports
  the owner's `HOME` (shell-quoted) and hands over to `/bin/sh`. The wrapper is
  Gateway-wide; only agents with shell are offered `exec`.
- The owner's `HOME` comes from the user database (`os.userInfo().homedir`), not
  from `$HOME`. The `PATH` is computed without starting a login shell (which would
  run the owner's profile scripts): the AgentPier service's own `PATH` plus the
  package manager directories that exist (`/opt/homebrew/bin`, `/usr/local/bin`,
  `/home/linuxbrew/.linuxbrew/bin`). It reaches the agents with shell as
  `tools.exec.pathPrepend`, so the approval analysis resolves the same programs
  that run. A tool found only on the owner's interactive `PATH` (nvm,
  `~/.local/bin`) must be called by its absolute path or added to the service's
  `PATH`.
- Behind these directories OpenClaw adds the `PATH` of a system login shell
  (`/bin/sh -l` with the Gateway's private `HOME`, so `/etc/profile` and on macOS
  `path_helper`, never the owner's profile) and the Gateway's own `PATH`. Programs
  installed system-wide (`/usr/bin`, and the Homebrew directories) are therefore
  found even without the owner `PATH`.
- The Gateway process itself gets the same directories in its own `PATH`, behind
  the runtime's Node and ahead of `/usr/bin:/bin`. OpenClaw checks the programs a
  skill requires on the Gateway's `PATH`, so without them Homebrew tools such as
  `gh` or `himalaya` would count as missing and their skills would not load. This
  grants nothing beyond what exec already receives (the owner's directories come
  before `/usr/bin:/bin`, so a user-writable one such as `~/bin` can shadow system
  tools for the Gateway process as it already can for exec); the directories are computed
  at every Gateway start, so an AgentPier update applies it without manual steps.
- If the owner account cannot be resolved, the Gateway starts without the wrapper
  and logs a diagnostic; commands then run with the private `HOME`, and the
  Gateway's `PATH` is only the runtime's Node, `/usr/bin` and `/bin`.
- The Gateway token is only in `gateway.auth.token`; `OPENCLAW_GATEWAY_TOKEN` is
  not in the Gateway's environment, so no command sees it.

### Approvals in the web and on Telegram

Under With approval, each request (`exec.approval.requested`, received by the
supervisor's own client with the `exec-approvals` cap) becomes an agent action
awaiting the owner, attributed through the request's agent and session to the
agent and conversation. A request AgentPier cannot attribute (unknown agent or
session, or shell Off) is denied at once. The action shows the command, folder,
agent, expiry (30 minutes) and OpenClaw's notes, with **Allow once**, **Always
allow** and **Deny**.

- The card appears in the agent chat, a permanent team member's own chat included,
  and under the agent's **Overview › Actions and coding tasks**. When the member's turn was delegated by its
  lead (a lead's question or task, or a team assignment), the action also records
  `leadAssistantId`: the lead's chat lists the same action and counts it in its
  approval strip, so the owner can decide from either chat; the decision ends it in
  both. A direct chat with the member asks only there. The lead agent's own
  `actions` tool does not list it. A turn that came from Telegram also gets the
  three buttons in that private chat, for the owner only; the existing stale and
  private-chat rules apply. So does a member's turn for a lead's request or a team
  assignment whose lead turn the owner sent from Telegram (not forwarded): the
  member's turn context carries that chat (`telegram`, `ownerTelegram` in
  `team-coding.js`), and the approval is offered there and in the web (owner
  decision). Each decision goes to the Gateway exactly once and is
  audited (`assistant.answered`, with the allowlist outcome).
- A run AgentPier did not start has no turn context: OpenClaw's own follow-up run in
  a session (for example after a background command finished). Its request asks in
  the paired Telegram chat too when the conversation's latest request came from that
  chat (turn context `telegram`), and only while that chat is still the owner's
  paired, enabled chat writing into this conversation with the same ids
  (`follow-up-target.js`, the same target a hook's run uses). Otherwise it asks only
  in the web.
- The reply of such a run goes to that chat too (`telegram-follow-ups.js`). Its
  lifecycle end (a Gateway `agent` event of the chat's subscribed session) records
  the run once, durably by run id (`channel_follow_ups`), when no attempt has that
  run id and the same target applies. Before anything is sent, the session's
  transcript (`sessions.get`) must show the run as an exec completion: the entry right
  before its first record is a user entry with the exec provenance. Check-ins,
  routines and hooks (their own sessions and delivery), memory flushes and every
  AgentPier turn (an attempt, delivered as that turn's reply) never qualify. The
  run's last assistant text (read whole, waited for up to 60 seconds) becomes one
  outbox notice `follow-up-reply:<runId>`, formatted, split and retried like every
  notice and sent after the replies of Telegram inputs that were still under way
  when the run ended. Silent replies (`NO_REPLY`, `HEARTBEAT_OK`) and runs without
  text are dropped, as is a run whose chat was paired anew or switched off
  meanwhile. Only live end events count: nothing is read back from older history,
  and a run that ended while AgentPier was not connected stays in the web chat.
  `assistant-telegram-follow-ups-contract.test.js`
  (`AGENTPIER_SHELL_CONTRACT_RUNTIME`) pins these assumptions against the pinned
  runtime.
- Telegram delivery of the turn (`telegram-delivery.js`): an approval the run waited
  for (exec, and SSH or SFTP until their hold ends) does not replace the reply. Once
  the owner decided every such card and the run completed, its answer goes to
  Telegram after the cards, and the input records the cards' and the reply's message
  ids. Proposals the turn ends with (teams, coding runs and the like) and approvals
  still waiting when the run ended stay the turn's reply, as before. A run that
  completes without text after granted approvals waits the usual grace for it; then
  the cards stand in for the reply.
- While a turn waits for an approval, the chat header says **Awaiting approval**, as
  the sidebar does, instead of the turn's accepted or running state.
- Allow once runs the command once; Deny never runs it.
- Events missed while disconnected are reconciled at every ready against
  `exec.approval.list` and `approval.history`. A Gateway restart cancels pending
  requests; their actions end as cancelled, never stay waiting, and a late
  decision answers 409. The command does not run.

### Always allow

- **Offered by OpenClaw** (programs in system directories, such as `/usr/bin/git`):
  OpenClaw adds an entry bound to the exact arguments and folder, plus a command
  companion. The same command then runs without asking; other arguments ask again.
- **AgentPier's fallback (owner decision).** OpenClaw withholds Always allow for
  programs in folders the owner can write to (Homebrew, `~/.local/bin`, npm global
  bins). AgentPier still offers it: it resolves the request with allow-once and
  writes one program-path entry per program of the command, each allowing that
  program **with any arguments**; a pipeline gets one entry per program. The plan
  is computed when the request arrives, shown on the card before the owner
  confirms, and written unchanged. The card warns that programs whose arguments can
  run other commands (git hooks, aliases) are covered too, and names the
  owner-writable programs: if one is replaced, the new version runs without asking.
- **Never an entry** (the command is allowed once and asks again next time):
  interpreters, shells, launchers and wrappers, package managers and build drivers
  (a superset of OpenClaw's own lists, checked against the installed runtime by a
  contract); inline scripts; commands with substitutions, subshells, control
  structures, background jobs, environment assignments or variables; programs that
  cannot be resolved to a real path. OpenClaw itself always denies commands with
  redirections (`>` or `<`) for owner-writable programs, with or without an entry.
- **"Unresolved" is expected, not an error.** AgentPier computes the plan when the
  request arrives, from its own view of the file system: it resolves each program
  through the agent's `pathPrepend` and the system directories and compares the
  first one with OpenClaw's `resolvedPath`. When they differ (for example when a
  tool exists in two `PATH` folders and OpenClaw picks the other one), or a program
  cannot be found, the plan is `unresolved`: Always allow then allows the command
  once and asks again next time.

### Allowlist management

The agent settings list **Always allowed commands** (`GET
/api/assistants/:id/shell-allowlist`): the program or command, whether it allows any
arguments or only the approved ones, who added it (AgentPier, OpenClaw, elsewhere),
the command it was approved for where AgentPier knows it, and the last use.
OpenClaw's command companions are folded into their program entry. **Delete**
(`DELETE /api/assistants/:id/shell-allowlist/:entry`) removes the entry with its
companions through `exec.approvals.set` with the current base hash; the next
matching command asks again. Deletes are audited.

### Backups and stored levels

A host backup holds the agents' records, so restoring it brings back each agent's
stored shell level and its allowlist entries (OpenClaw's `exec_approvals_config`,
part of the database's configuration copy) **without a new confirmation**. That is
deliberate: the owner starts the restore
and returns to levels and entries they confirmed before. The same holds when an
archived permanent member is restored, and when a level is raised again over
entries that survived an earlier lowering (entries are only removed by deleting
them). Check the agent settings after a restore if in doubt.

## Skills

OpenClaw bundles skills: short instructions (`SKILL.md`) that teach an agent a tool,
mostly a command-line program such as `gh`, `himalaya` or `tmux`. In **Capabilities › Skills** the owner switches bundled skills on per agent. Only personal agents and
promoted permanent members have a selection of their own; temporary members use
their lead's current selection, archived agents have none, and a new agent starts
without any.

- **Compilation.** The selection is stored on the agent profile (`skills`, sorted
  names) and compiled into `agents.entries.<id>.skills`, which OpenClaw reads as the
  agent's final allow list. `agents.defaults.skills` stays `[]`, so every agent
  without its own list has no skills, and every Gateway start removes lists from
  entries AgentPier does not manage. `skills.allowBundled` is not a gate: OpenClaw reads the empty list
  as "every bundled skill allowed"; the agents' own lists are.
- **Live changes.** A save applies with `config.patch` (`reloadKind: "hot"`); a shorter
  or removed list names `agents.entries.<id>.skills` in `replacePaths`. OpenClaw
  refreshes the skill snapshot at the agent's next turn, without a Gateway restart.
  The save is audited as `assistant.updated` with the skill names. Like any other
  capability change, a save waits while the agent works on a turn (409 `active`),
  although skills only apply at its next turn.
- **Status.** `GET /api/assistants/:id/skills` reads `skills.status` for the agent
  from the running Gateway (503 while it is not ready). Each skill is **ready**,
  **missing** something (programs, any-of programs, environment variables or API
  keys, configuration, or the operating system), **unsupported** on this system,
  **disabled**, **unavailable** (an assigned name the runtime no longer bundles) or
  **shadowed**. The browser never receives file or base paths, install options or
  configuration checks, and host directories are cut out of every text. Upstream
  descriptions stay in their original language. Entering API keys is not offered;
  the page only names what is missing.
- **Only bundled skills.** A save is refused (409 `skillUnavailable`) for a name that
  the running Gateway does not report as an `openclaw-bundled` skill: ClawHub,
  managed, Custodian and workspace skills are never assignable. Names already
  assigned can always be kept or removed, also while the Gateway is down.
- **Shadowed skills are never compiled.** OpenClaw matches an agent's list by name
  across all sources, and a skill in the agent's workspace (`skills/`,
  `.agents/skills/`) or in the Gateway's managed or personal folders wins over the
  bundled one. Shell commands run as the owner and could plant such a folder, so the
  owner's switch for a bundled skill must not load it. Every compile (Gateway start
  and live apply) drops an assigned name that a skill in those folders carries (by
  folder or frontmatter name, a few levels deep, which over-approximates OpenClaw's
  discovery), and a live apply also drops any name `skills.status` resolves to
  another source. The owner's choice stays stored: the page shows the skill as
  **shadowed** and off for this agent, adding such a skill is refused, and it applies
  again once the other skill is gone. Owner turns apply the agent before they start,
  and the Gateway's `skills.changed` event re-applies every agent with skills.
- **Programs.** OpenClaw checks the programs a skill requires on the Gateway's
  `PATH`, which carries the owner's login `PATH` (see
  [Environment of shell commands](#environment-of-shell-commands)). Most skills run
  those programs through `exec`: the page marks them **needs shell access** while the
  agent's shell is off. An allow list is visibility, not an authorization boundary;
  shell remains the real gate.
- **Warnings.** Every bundled skill is listed. Skills that install foreign code
  (`clawhub`, `skill-creator`), steer the Gateway (`control-ui`, `node-connect`),
  change the host (`healthcheck`), duplicate an AgentPier feature (`coding-agent`,
  `visualize`, `mcporter`) or reach secrets (`1password`) show a warning before they
  are switched on.
- **`skills_read`.** OpenClaw 2026.10.3 also grants the read-only `skills_read` tool
  to every agent whose allow list contains `read`: all agents with memory, and
  routine runs. It returns only skills that are installed and eligible for that
  agent. The owner accepted this grant.
- **macOS privacy.** Programs such as `remindctl`, `memo` or `peekaboo` need Reminders,
  Notes or Screen Recording permission for the process that runs them. A background
  service cannot show the prompt; grant it in System Settings if a skill fails.

## Proactivity: check-ins (2026-10-12)

The **Acting on its own** group in an agent's settings (section **Proactivity**)
holds the check-in opt-in. It is off by default, and only personal agents and
promoted permanent members have it. Changes are audited as `assistant.updated` with
`kind: "proactivity"`, `fields: ["heartbeat"]` and the new on/off flag; never a
schedule, time zone or text. Clients that do not send the field keep the stored
value.

### Check-ins (heartbeat)

**Check in on its own** lets the agent look at its conversation at set times: every
hour, 2 hours, 4 hours or once a day, within active hours (start to before end, whole
hours, within one day) in the owner's time zone, which the browser supplies; the
settings offer to adopt the browser's zone when the saved one differs. The agent is
asked whether something needs the owner's attention and to answer exactly
`NO_REPLY` otherwise. The settings show the cost as model runs per day, each reading
the recent conversation.

Check-ins need **Remember information** (`heartbeatMemoryRequired`, 409): the
agent's notes are what it checks against. The settings disable the switch without
memory, and switching memory off switches check-ins off in the same save. A save
that sends check-ins switched on without memory is refused; a client that does not
send them (an older one) may still switch memory off, and the stored flag then has
no effect: the agent keeps no job. They need no Telegram chat (since AGENTPIER-141; an agent saved with check-ins on but
never paired starts checking in after that update); a new agent switches check-ins on
after saving.

It is not OpenClaw's native heartbeat, which stays at `agents.defaults.heartbeat.every:
"0m"`: that one delivers through OpenClaw channels, which AgentPier leaves empty. Each
opted-in agent instead gets one native cron job
(`server/features/assistants/native-heartbeats.js`) bound to the agent's main chat
(the session `openConversation` created, which a Telegram pairing also uses; the
sync opens it when the agent has none yet):

- `sessionTarget: "current"` with that conversation's `sessionKey`: a detached run
  that reads the conversation's recent tail and the agent's instructions
  (`lightContext: false`), then commits its visible result into that conversation.
  Each run reads the conversation as it is then, not as it was when the job was
  created, and after a `/reset` or `/new` sent from the owner's Telegram chat it
  reads and commits into the new session, so the job is never recreated for that.
  In the web chat AgentPier answers both itself: `/new` opens a separate chat and
  `/reset` is refused, so neither reaches the Gateway. OpenClaw waits for a running
  turn there to end before it commits, so a check-in that comes due while the
  owner's turn runs appears after that turn's answer, never inside it; the run
  itself does not wait, so it may not know that answer yet. The owner's next
  message, in AgentPier or on Telegram, has the check-in in its context.
- AgentPier handles a check-in only when the completion event reports the commit
  into the conversation as `delivered`; a check-in that did not reach the
  conversation stays in the run history. In the AgentPier chat it leaves the
  transcript for a "Check-in" row of the main chat's **Events** area, in the owner's
  interface language (a `heartbeat` record in `assistant_routine_results`, served as
  the history's `events`); Telegram gets the `Check-in:` marker in the channel's
  language.
- MEMORY.md is not part of a detached run's prompt (a chat turn's is), so the
  check-in prompt asks the agent to read it with `memory_get` first; the run's tools
  are `memory_search` and `memory_get` only, so nothing is written unattended.
- `delivery: { mode: "announce", completionDestination: { mode: "webhook" } }`:
  announce is the session commit (no channels are configured), the completion
  webhook is the reminder receiver. A `NO_REPLY` result is silent: nothing is
  committed (the conversation shows no message; OpenClaw records the run as
  not delivered), and AgentPier drops the posted `NO_REPLY` summary.
- A new main chat retires the job and creates one for the new session key. The main
  chat cannot be archived or deleted (409 `CHAT_MAIN`), so this happens only for a
  person who had none yet. A pairing change never does.

The binding (kind `heartbeat`, hidden from reminder and routine lists) stores the main
chat and the paired Telegram destination, which each sync brings to the current
pairing. AgentPier drops an empty or `NO_REPLY` summary and failed runs; anything else
is recorded for the chat and sends an `agent-checkin` push notice that names only the
agent and the conversation it opens. Unless the owner switched **Also send to
Telegram** off (`heartbeat.telegram: false`), it also goes, prefixed with `Check-in:`
(server message `heartbeatPrefix`, in the chat's language), to the outbox of the
paired chat (kind `heartbeat`). The model's text never chooses a recipient. The push
is sent when the check-in is recorded, not after Telegram accepted it. Native
`chat.inject` was evaluated for the reply context first and rejected: gateway-injected
notes appear in the transcript but never reach the model.

A saved change converges the job at once (update in place, or removal when switched
off). So do changes of the paired chat (`ChannelService.channelChanged`): starting a
new pairing or disabling, disconnecting or halting the chat only stops the Telegram
extra, completing a pairing sends later check-ins to the new chat too; the job stays. Archiving a member retires
its job and restoring it schedules one again. Every Gateway ready and every end of
maintenance repeats the convergence for all agents. Maintenance switches the whole
scheduler off. Agents whose model connection is blocked, archived members, and
agents without memory keep no job, and queued check-ins of such agents are not sent. Switching reminders off pauses an agent's jobs, and the
same save schedules its check-ins again. A creation whose acknowledgement was lost
stays tracked until a listing shows its job; the job's first completion adopts it.

The heartbeat contract (`tests/integration/assistant-heartbeat-contract.test.js`)
force-runs the job on the pinned runtime with the compiled native configuration: the
check-in sees the agent's instructions and the conversation, reads MEMORY.md through
`memory_get`, reaches the paired chat once with its prefix, appears in the
conversation, and is in the model input of the owner's next reply. `NO_REPLY` leaves
no visible message and sends nothing. A check-in due during a running owner turn is
committed after that turn's answer. A message sent after the job was created reaches
the next check-in's model input, and after an owner `/reset` and `/new` sent from
Telegram the same job reads only the new session and commits into it
(`deliveryStatus: "delivered"`). The
agent's native heartbeat job stays disabled, and switching off removes the job.

### Recall across conversations is not offered yet

AgentPier keeps OpenClaw's cross-conversation recall off
(`memory.search.rememberAcrossConversations: false`, transcripts not indexed). A
person's chats with an agent are kept apart on purpose: a new chat starts without the
others' history, and on a shared agent each user's chats are her own. Recall across
them would carry one chat, or one user's words, into another, and cost extra model
calls.

`tools.sessions.visibility` is `"agent"` on every Gateway: OpenClaw's default
`"all"` lets session tools reach other agents' transcripts. Teams do not use
OpenClaw session tools (members run in their own sessions and report through the
AgentPier bridge), and the team plugin contract passes with it.

<a id="dreaming-is-not-offered"></a>

### Dreaming

OpenClaw's dreaming (memory-core's nightly sweep,
`plugins.entries.memory-core.config.dreaming`) is one owner switch under **Agents › Runtime › Dreaming**: **Dream at night**, the hour (default
03:00) and its time zone. Switching on adopts this device's zone; **Use my time zone**
adopts it again later. The setting lives in `assistants/dreaming.sqlite`
(`dreaming-settings.js`, `GET`/`PUT /api/assistant-dreaming`) and compiles
(`openclaw-config/dreaming.js`) to
`dreaming: { enabled, frequency: "0 <hour> * * *", timezone, storage: { mode: "separate" } }`:
every phase at memory-core's defaults, deep included, and no `model` key, so each agent
dreams with its own model and model account. A save reaches the running Gateway as a
live `config.patch` of that path, which reschedules the job in place without a Gateway
restart (a running turn ends normally). OpenClaw writes the change at once but answers
the patch only after it applied it, and it applies it only once running turns have
ended; a turn longer than the 10 s call timeout therefore leaves the save pending
until then. A change the Gateway does not take (it is not
ready, or it refuses the patch) stays pending: the one-minute `DreamingBackups` tick
patches it, under admission, once the Gateway is ready, so it applies within a minute
(only where the Gateway's dreaming section differs). A Gateway start compiles the saved
setting and clears what was pending.

- **Who dreams.** memory-core 2026.10.7 sweeps every agent configured in the runtime
  and has no per-agent scope (`memoryPolicy.excludeSessions` filters by channel, chat
  type or hook source only). So every agent dreams, temporary team members and agents
  with **Remember information** off included, each only over its own conversations,
  into its own workspace, with its own model; nothing is written into `memory/lead/`,
  and a temporary member's copy of its lead's memory leaves out the lead's
  `memory/dreaming/` notes (their gist reaches the mirrored `MEMORY.md`).
  A shared agent dreams over all its chats (every user's and the owner's own) into its
  one shared memory, and its light-sleep notes can quote chat lines word for word. A
  sweep runs in its own `agent:main:cron:*` session: a busy agent's turn neither blocks
  it nor is interrupted, so no night is skipped and AgentPier adds no busy or retry
  logic. A promoted member joins from the next night.
- **Memory on for permanent agents.** Permanent agents (personal agents, permanent
  team members, users' own and shared agents; `dreamingCovered` in
  `dreaming-service.js`) get their memory switched on and kept on. Switching dreaming
  on while some of them have memory off answers 409
  `ASSISTANT_DREAMING_MEMORY_CONFIRMATION_REQUIRED` with their names; the settings page
  lists them in a confirmation (`kind: "dreamingMemory"`, see the
  [settings pattern](settings-pattern.md)) and, once confirmed, turns memory on for each.
  An agent that is busy cannot be changed: dreaming stays off, the answer is 409
  `ASSISTANT_DREAMING_AGENTS_BUSY` naming the busy agents, and the owner saves again
  later. While dreaming is on, switching memory off for a permanent agent, or creating
  an agent with memory off, is refused with `dreamingMemoryRequired`, and the agent's
  **Remember information** toggle is locked with a hint where to switch dreaming off.
  A permanent agent whose memory is still off (one restored from the archive) can
  save other changes; once its memory is on, it stays on. The bulk switch-on sends
  only the known boolean capabilities with memory on, so a stored legacy key cannot
  refuse it.
  New agents start with memory on, also while dreaming is off (`memory-rules.js`).
- **Output.** Dream notes land in `memory/dreaming/{light,rem,deep}/YYYY-MM-DD.md` and
  show in the memory view like any other note. The Dream diary (`DREAMS.md` in the
  workspace root) shows first in the owner's and the users' memory view, read-only.
  Three notes a night pass 200 within weeks, so the note list (`GET
/assistants/:id/memory/files`, `GET /me/agents/:id/memory`) pages:
  `?offset=` (a whole number, default 0) returns the next 200 notes newest first (same
  instant: by name) with `total` and `nextOffset` (null on the last page), the diary
  heading the first page only. A folder is read up to 10,000 notes. The memory view
  shows **Load N more notes** while notes are left. A note is read up to 256 KiB; a
  larger diary is not refused but read from its end (OpenClaw appends each night's
  entry at the end of the diary section): the last 256 KiB from the first `---` entry
  break, with `truncated: true` and the whole `size`, and the memory view says that
  older entries are cut off.
  On a user's own agent the owner reaches them only under her **Owner may read chats**:
  without it the owner-content guard (`owner-content-guard.js`, `agentContent` in
  `owner-privacy.js`) answers 404 on every owner memory route of that agent (`GET`
  `/memory`, `/memory?name=…`, `/memory/files`, `/memory/search`), dream notes and
  diary included, while her `/api/me/agents/:id/memory` lists them; with it he reads
  them in full, older entries included, so light-sleep notes may quote her chats from
  before the opt-in (`tests/blackbox/owner-privacy-dreaming.test.js`). The deep phase may rewrite `MEMORY.md`. The raw corpus `memory/.dreams/` (session
  corpus, seen hashes, short-term entries) is never listed, read or returned by memory
  search, and the team plugin's `dreams-guard.js` refuses it to the agent's `read`,
  `memory_get`, `write`, `edit` and `apply_patch`, also through `file://` and
  percent-encoded spellings.
- **`MEMORY.md` backups.** `DreamingBackups` (`dreaming-backups.js`) ticks once a
  minute (it starts with the agent services, or when maintenance ends if AgentPier
  started in maintenance or recovery) and, in the five minutes before the hour in the setting's zone (on a
  spring-forward night the minutes before the jump), copies `MEMORY.md` of every agent
  compiled into the runtime to
  `assistants/memory-backups/<runtimeAgentId>/MEMORY-<UTC stamp>.md` (written to a
  temporary file and renamed, mode 0600). An agent with a copy younger than six hours
  is skipped, so a restart inside the window takes no second copy; the newest seven
  copies are kept. A folder whose agent or workspace is gone is removed. The copies are
  outside the workspace, so neither the memory view nor the agent's tools see them;
  host backups seal them with history like `workspaces/` ([backups](backups.md)). To
  restore, copy a backup back to the agent's `MEMORY.md` while the agent is idle.
- **Deleted chats.** Deleting a chat runs
  `openclaw memory forget --agent <runtimeAgentId> --session <sessionId> …`
  (`forgetDreamingSession`), dreaming on or off, since earlier nights may have read
  the chat. It names every session id the chat's key had: the live one and those
  OpenClaw's transcript archives still record for the key (`archivedSessionIds` in
  `transcript-archives.js`, read before the purge removes them), so a reset's earlier
  ids go too. It removes the session from the corpus, seen hashes and short-term
  entries and keeps it out of later sweeps; notes
  already distilled from it stay. The forgets run one after another in the background,
  outside admission; maintenance (restore, update) and AgentPier's shutdown wait for the
  queue. A forget that
  fails (for example a 10 s wait for memory-core's workspace lock during a sweep), or
  that is lost because AgentPier stops before it runs, is logged without content and
  not retried: that chat's corpus lines stay. The forget runs after the deletion has
  purged OpenClaw's transcript archive (the `<session id>.jsonl.deleted.*` files and
  the `session_transcript_archives` rows, `transcript-archives.js`, see Delete under
  [Several chats per agent](#several-chats-per-agent)); a purge that fails is retried at the next Gateway
  start, and the forget runs once it succeeds. A chat whose native session id
  AgentPier never learned is forgotten by the ids its archives name; only when the
  Gateway knows no session for the key and no archive names one is there no id to
  forget (`memory forget --session <key>` resolves a key only against live sessions
  and archives too, and would record the key literally).
- **Resolved data directory.** On 2026.10.7 the sweep fails every workspace ("Canonical
  session reader continuation is no longer current") and writes no corpus or notes
  when the state directory's path runs through a symbolic link. The data directory
  must therefore not sit behind a symbolic link; `runtime-paths.js` does not resolve
  it. Default data directories have no linked ancestor.

The contracts pin this on 2026.10.7: `assistant-dreaming-contract.test.js` (each
agent's own chats into its own memory only, ingestion state rewritten wholesale, a
deleted or forgotten chat stays out, a live hour change during a turn) and
`assistant-dreaming-scope-contract.test.js` (a temporary member is swept, a shared
agent dreams over every chat while memory search returns no raw corpus, a sweep during
a running turn, the managed schedule under the hardened heartbeat, no corpus under a
symlinked data directory). On the rollback targets (2026.10.3, 2026.9.9 and 2026.9.8),
which run this release's compiled configuration after a failed activation,
`assistant-dreaming-rollback-cross-version.test.js` pins in the cross-version job that
the section is accepted, the managed job follows the switch and a live hour change
without a restart, a sweep keeps each agent to its own chats, and a deleted chat leaves
dreaming. See [memory qualification](assistant-memory-qualification.md#dreaming).

## Work goals (2026-10-24, AGENTPIER-208)

The agent tool `agentpier_goal` (actions `set`, `update`, `done`, `blocked`) records one
work goal per chat in `work-goal-store.js`; the owner's `POST
/api/assistant-conversations/:id/goal/stop` stops it (404 for an unknown chat, 503
while teams are not wired). It is offered only for the owner's
own chats with a personal agent or permanent member (not shared or user agents,
not temporary members). `set` needs the owner's direct turn (context `owner` or
`telegram`, not forwarded, no `goal` marker), recognised by meaning from the model, never
from forwarded, quoted, scheduled, tool-provided or member content. `update` works from
the owner's direct turn or a goal turn of the open goal (a turn of a replaced goal is
refused with `GOAL_UPDATE_TURN`); `done` and `blocked` work from any attempt-bound
turn of that agent in the goal chat. None of them widens rights. Every change is a note in the chat and is audited by its
kind only, never with the goal's texts.

**Nudge, not cron or heartbeat.** AgentPier itself sends the continuation as a follow-up
turn (ledger request with recorded context) 90 seconds after the goal's chat has been
idle. A follow-up accepted under its client request id (`goal-continuation:<goal>:<n>`
or `lead-request-result:<request>`) whose bookkeeping a crash lost is sent again with
the text and context recorded for it, never a context worked out anew, so a retry
adopts the accepted request instead of conflicting. OpenClaw cron and heartbeat runs have no attempt and no context, so every right
would need `exec-continuation.js`-style proof; the follow-up turn keeps rights, audit and
the live feed unchanged. The idle timers are in memory: a restart only restarts the delay.

**Context and anchor.** A continuation is recorded as `kind: "owner"` with a `goal` marker
and has exactly the rights of its anchor, the owner's latest direct turn in the chat (at
first the one that set the goal; a direct Telegram message counts), and never more. Owner proofs (@mentions, quotes, negations such as "change nothing") are
read from the anchor's text only, once across the anchor and all its continuations.
The lead's `member-result` follow-up in the goal chat counts as a goal turn; member
reports (`member-report`) and peer results do not. In a goal turn a delegated task writes
like an Autonomous lead's own task at every Use team level, at most 4 per turn and outside
the 20-per-hour limit, and only while the goal is still open (a turn running on after Stop
delegates as it would without a goal); a member named in the anchor does not make it read-only. Trusted
SSH and SFTP hosts work as in an owner turn (origin `owner`). A background command a goal
turn starts is continued by its completion run like an owner turn's (see **Command
completions**): it writes, uses project-folder file actions and shares the result with
`agentpier_share_file` (AGENTPIER-237).

**Exclusions.** Approval cards still wait for the owner. A goal turn cannot use the
short-yes consent (**Go ahead**), switch **May write**, create or change reminders or
routines (both go through `turnAudience`), grant shell or SSH access, or set or widen a
goal. Lead shares and grants a lead turn may make today stay allowed.

**Holds.** No nudge while the chat has a pending attempt, a live check-in run, a running
compaction or summary, a queued owner message, an approval card, an open lead or peer
request whose result will be delivered into this chat (the lead's own, a colleague's
answer for a permanent member's chat, or one a member sends to the lead; member reports
excluded), its team, or a background command. On OpenClaw 2026.10.7 a command's
completion run counts as a background command from its model input until its end
(the Gateway method's `completing`, for at most 30 minutes per run), because no agent
event marks it before it writes. An uncertain attempt, and any interrupted
attempt other than a goal continuation, stays pending until the owner reviews it, so it
holds the goal until then: an uncertain run may still be running and may have run tools.
An interrupted continuation AgentPier sent itself is reviewed on the next pass the way a
user's own review works (`abortAndReview` in `attempt-recovery.js`: `sessions.abort` for
its run, then the attempt is marked reviewed), audited as `continuation-reviewed`. Background commands
are asked with the Gateway method `agentpier.backgroundCommands` (team plugin,
`background-commands.js`) for the chat's session once the delay is over, and then on every
pass while that hold lasts; they hold for at most 2 hours from when the chat became idle
around them, and an error counts as none running. The anchor is also read only then.

**Brakes.** 3 technical failures (failed, interrupted or reviewed uncertain attempts) in a
row, or 3 continuations without any tool call, end the goal as blocked. A tool call is a
Gateway `item` event of kind `tool`; one named `agentpier_goal` is not progress, one
without a name is. A refusal that only says "not
now" (409, 503) restarts the delay. An archived chat or agent, a lost anchor, an agent that
became ineligible, or a cancelled continuation turn (`turn-cancelled`) end the goal; it is
audited with source `user` only when the owner's stop control
(`POST /api/assistant-attempts/:id/cancel`) cancelled it, otherwise `system`. Continuations and goal notes are not sent to Telegram, and goals never block
saving agent settings between turns.

## Hook proposals (2026-10-25, AGENTPIER-216)

`agentpier_hook` (actions `propose` and `list`) is compiled next to `agentpier_routine`
into the entries of own agents and permanent members with **Allow reminders and
routines** on (`goalAgent` in `profileTools`). It is locked for user agents and never in
a routine's or a hook run's `toolsAllow` (`routineTools`, `hookTools`). The bridge
serves it only in a turn with an active attempt, never in a routine, hook or command
completion session, and `invokeHook` (`agent-hook-proposals.js`) admits only a direct
owner turn (`directOwnerTurn`); forwarded, scheduled, member-result, memory-step,
lead-request and goal continuation turns answer `HOOK_OWNER_ONLY`, an agent that may not hold hooks
`HOOK_UNAVAILABLE`. `propose` validates name, sender, reason, instruction, rights and
hourly limit as the owner's own create does and reserves a `hook_proposal` approval
action; the hook is created only when the owner approves, without a secret. `list`
returns each hook's id, name, sender, state, the rights it holds now and its
addresses. The agent never receives a secret or its hash. See
[agent hooks](assistant-workflows.md#agent-hooks).

## SSH access proposals (2026-10-26, AGENTPIER-249)

`agentpier_ssh_access` (actions `propose` and `status`) is compiled for own agents and
permanent members (`goalAgent` in `profileTools`), locked for user agents and never in a
routine's or a hook run's `toolsAllow`. `invokeSshAccess` (`agent-ssh-proposals.js`)
admits only a direct owner turn (`SSH_PROPOSAL_OWNER_ONLY`) of an agent without a
Telegram bot for other people (`SSH_PROPOSAL_UNAVAILABLE`), validates the endpoint like
the SSH catalog, limits proposals (`SSH_PROPOSAL_LIMIT`), scans the host key and
reserves an `ssh_access` approval action. The owner's decision may carry `keyId` and
`mode` from the browser only (`decisionKeys`); approving registers the host through
`ssh-verified-host.js` and grants it with `AssistantAccess.grantSsh`. The outcome
reaches the agent once as an `ssh-access-result` turn. See
[SSH accesses](ssh-access.md#proposals-from-agents).

## Live agent chat feed

`/api/assistant-conversations/<id>/stream?cursor=<cursor>` is a WebSocket behind the
login and the origin check of the session chat stream. The upgrade is refused with
404 for an unknown conversation (the check of the history route) and with 503 while
the agent feature is off; a logout closes the socket (1008). The client sends nothing.
The agent chat in the browser reads its messages only from this feed; the
`/api/assistant-events` stream keeps the agent list and the sidebar current (see
[Live agent list](#live-agent-list)) and no longer carries reply text.

- `ConversationFeeds` (`server/features/assistants/conversation-feeds.js`) keeps one
  feed per watched conversation, shared by every tab and device. An invalidation is
  debounced for 200 ms and then read once: the latest history window, exactly what
  `GET /api/assistant-conversations/<id>/messages` returns.
- `AssistantService.changed({ conversationId })` invalidates only that feed; a plain
  `changed()` invalidates every live feed. Both still publish the `change` event on
  `/api/assistant-events` for the list and the sidebar. The busy paths name their
  conversation: a sent turn, the queued message, a confirmed run, a compaction, a
  routine, reminder or check-in result, and Telegram input and reply delivery. A
  run's terminal chat frame invalidates its feed directly. While a turn of the
  conversation is active (an attempt pending, accepted or running, a compaction, or a
  reply streaming), the feed also re-reads every 30 seconds. The reconciliation poll
  (every 2 s while a turn is unresolved) re-reads only the feeds whose history or
  turns changed during the pass.
- The window also carries `actions`: what waits for the owner in this agent's chat
  (`AssistantWorkflows.pending`), the same rows as
  `GET /api/assistants/<id>/actions` limited to approvals still awaiting a decision
  (team coding requests and members' requests in turns the agent delegated included)
  and allowed SSH commands while they run. They are read with the history, once per
  invalidation for every socket. Every write of the action store (a new request, a
  decision, an expiry, a revoked grant, a finished run) re-reads the feeds of the
  agent that owns the action and of the lead it is shown to, batched per tick of the
  event loop (`AssistantActionStore.onWrite`); the matching change event is published
  with `changed({ feeds: false })` and re-reads no other feed. The workflow pass that
  advances open actions every second publishes a change only when it wrote an action.
- `sync` frames (`{type: "sync", sequence, data}`) carry the `ChatSync` encoding of
  the session chat: a full window (the history payload plus
  `sync: {mode: "full", cursor}`) or a delta (`sync: {mode: "delta", base, cursor}`,
  `metadata` with `requests`, `queued`, `compacting`, `stale`, `nextBefore` and
  `actions`,
  `upserts` as whole rows, `removed` ids and `order` when the order changed). A read
  that changes nothing for a socket sends nothing. The baseline scope is the
  conversation, its runtime session key and the Gateway launch (`generationId`): a
  cursor from another launch, or an expired (30 minutes) or unknown cursor, for
  example after an AgentPier restart, yields a full window. Cursors are not persisted.
- `stream` frames (`{type: "stream", runId, from, text}`, without a sequence) carry
  the reply streaming now. A socket first receives a run's whole text (`from: 0`),
  then only the appended part; a rewritten reply or a new Gateway connection starts
  at `from: 0` again. The text is capped at 64 KiB; the history has the rest.
- `steps` frames (`{type: "steps", runId, steps, omitted, phase, retry, quietMs}`)
  carry what the running turn does now, and `steps-end` (`{type: "steps-end", runId}`)
  drops them when the run ends. See [Live steps and stalled turns](#live-steps-and-stalled-turns).
- A socket that falls more than 2 MiB behind is closed with 1013; the client
  reconnects with its cursor. Stopping the agent feature closes every feed socket
  (1001).
- `GET /api/assistant-conversations/<id>/messages?cursor=<cursor>` (an empty cursor
  for none) answers with the same encoding, for a client that cannot keep the socket
  open.

The browser side (`web/features/assistants/useAgentConversationStream.js` on the
shared `chat-stream-transport.js`):

- The chat applies `sync` frames with the session chat's `applyChatSync`. A
  sequence gap reconnects with the held cursor; a delta on another base drops the
  baseline and reconnects without a cursor for a full window. A `stream` frame with
  `from: 0` replaces the reply text, any other `from` appends where the held text
  ends; one that does not fit reconnects, and the new socket sends the whole text.
  The streamed reply disappears once the stored reply is in the history.
- A hidden page closes the socket and a visible one reopens it with the cursor; coming
  back online reconnects at once, and so does a close with 1013. While no socket
  connects, at most three HTTP reads with the cursor stand in.
- Sending, queueing, taking back, stopping, recovering and removing a shared file
  only await their request: the feed brings the result. While the socket is down, the
  chat reads once over HTTP instead.
- The approval cards (`useAssistantActions`) and the lead's pending team coding
  requests (`useTeamCodingRequests` in `TeamApprovals`) use the feed's `actions`
  while its socket is connected: no change event reads `/actions` then, and nothing
  polls. A decided card stays hidden until the feed pushes its next state. While the
  socket is down, or with a server whose window has no `actions`, the chat reads
  `GET /api/assistants/<id>/actions` at start, on change events and every 5 seconds
  while an approval waits. **Team › Teams** in the agent's settings still reads the team requests
  itself.
- The chat shows the live window, the rows the window pushed out while the chat is
  open, and the pages "Earlier messages" loaded above them
  (`agent-history-view.js`), each row once. The last window of recently opened chats,
  with its cursor, stays in the page's memory (`AgentHistoryCache`): a chat opened
  again shows it at once, also offline, and resumes the feed with a diff.

### Live steps and stalled turns

AGENTPIER-184. A turn showed only "Working" for 15 minutes while its model call hung
after a tool result. The chat now shows what a turn does, says when the model stays
silent, and a silent turn ends.

What the pinned Gateway (OpenClaw 2026.10.3, re-verified on 2026.10.7) sends, pinned
by
`tests/integration/assistant-run-steps-contract.test.js`:

- Every operator connection receives the `agent` events of every run, also of runs
  it did not start (Telegram, reminders), without a capability: `item` frames of kind
  `tool` (`phase` start, update and end, `name`, `status` running, completed or
  failed, `meta`), `thinking` and `assistant` deltas, `run_status` (`starting_model`,
  and `retrying` with `retryAttempt`, `maxRetries` and `reason`), `compaction` and
  `lifecycle` (`start`, `model`, `waiting-approval`, `end`, `error`). The raw `tool`
  stream with arguments and results needs the `tool-events` capability, which
  AgentPier does not declare. `command_output` frames carry a command's output.
- An exec item's `meta` is the model's `title` argument for the call ("short
  purpose … No secrets", redacted by OpenClaw), or OpenClaw's summary of the command
  ("print text"). Other tools fill `meta` from raw arguments: a URL, a search query,
  an image prompt.
- There is no event for "waiting for the model" between tool calls: a finished tool
  hands back to the model.
- `chat.history` returns `sessionInfo`: `totalTokens` is the size of the last
  model call's prompt and current only while `totalTokensFresh` is true (a failed turn
  or a compaction clears it); `contextTokens` is the model's window.

AgentPier's side:

- `RunSteps` (`server/features/assistants/run-steps.js`) turns those frames into a
  run's steps: tools with their state, and thinking. It never keeps command output,
  thinking or reply text, arguments or results. A step's label is the exec or process
  `meta`, at most 80 characters, and only when it reads like a title: text with a
  secret-like word (token, password, key …), an assignment, a URL, shell characters or
  a long mixed token is dropped. Other tools show their localized name only. The phase
  is `model` (waiting for the model), `thinking`, `writing`, `tool`, `approval`,
  `compacting` or `retrying`. A run keeps its newest 24 steps and counts the rest.
- `bindChatEvents` (`gateway-wiring.js`) hands every frame of a chat's run to
  `RunSteps`; any frame counts as a sign of life. The feed (`ConversationFeeds.steps`)
  sends the run's view when it changed and at most every 15 seconds while only signs
  of life arrive, with `quietMs`, the time since the last one. A new socket receives
  the views the service holds. Steps follow the reply's privacy: the owner reading a
  user's chat under her opt-in only receives the steps of a run that answers what she
  wrote since then, and without the opt-in he has no socket at all. A user's own app
  receives all steps of her chats.
- A turn that sends no event for 15 minutes while it waits for the model (`model`,
  `thinking`, `writing` or `retrying`) is aborted with `sessions.abort` and fails with
  `failure: "stalled"` (`run-stall-guard.js`, checked by the 2 s reconciliation poll).
  A running tool, an exec approval and a compaction are never stalled: they report
  nothing until they end and have their own limits. Only runs this AgentPier process
  observed are guarded; after a restart the run budget still applies, and after a
  Gateway reconnect a run counts again only once it sent a new frame (frames, its end
  among them, may have been lost). The guard re-reads the run's phase and quiet time
  right before the abort and the attempt's state after it: a reply that ended the run
  meanwhile keeps the turn, and a reconciliation that sees the aborted run first still
  records `failed`/`stalled` (the run is marked in `runFailures` before the abort).
  Each abort, and each abort that fails, is logged with the attempt or run id only.
- OpenClaw's own limits apply unchanged, so AgentPier compiles no timeout: the model
  idle watchdog aborts a model stream that sends nothing for 120 seconds (cloud
  providers, the ChatGPT accounts' `openclaw-native-codex-responses` transport
  included; `models.providers.<id>.timeoutSeconds` replaces it), retries it a few
  times with growing delays (each retry a `run_status` event) and then ends the turn
  with a `chat` error of `errorKind: "timeout"`. The run budget
  `agents.defaults.timeoutSeconds` (48 hours, **Agent service › Advanced settings › Time limit per task**)
  bounds the whole turn. A turn that failed for want of an answer keeps
  `failure: "timeout"` on its attempt (`run-reconciler.js`).
- The history window carries `longChat: true` when the last model call read at least
  60 % of the model's context window (`sessionInfo.contextTokens`), or 100,000 tokens
  when the session names no window (`longContext` in `conversations.js`), unless its
  person hid the hint (below). Providers cache prompts, so a long chat mostly costs a
  slow first reply after a pause (the cache expired) and older details the model
  misses, which is what the hint says. The owner reading under a user's opt-in never
  receives it: it measures her earlier messages too.
- Summarise now and Hide (AGENTPIER-186, `server/features/assistants/long-chats.js`):
  `POST /api/assistant-conversations/:id/compact` (the owner's own chats; the privacy
  guard answers 404 for a user's chat, opt-in or not) and
  `POST /api/me/conversations/:id/compact` (her own chats; another person's is the
  unknown-route 404) call OpenClaw's `sessions.compact {key}` for the chat's own
  session and answer `{compacted: true}` once it is done, or `{compacted: false,
running: true}` after ten minutes while it still runs (below). The key, the chat, its main
  role and every delivery bound to it stay. Refused for a chat that takes no turns
  (404, as for a send), an archived chat (409 `CHAT_ARCHIVED`), and while a turn runs,
  a message waits or team work reports into it (409 `CHAT_BUSY`, also when the Gateway
  answers `has an active run` or `has queued work`). OpenClaw's `compacted: false`
  (for example `reason: "Already compacted"`) is 409 `CHAT_COMPACT_NOTHING`; any other
  Gateway refusal is 502 `CHAT_COMPACT_FAILED` and
  are logged with the chat id, the Gateway code and its error class only (never its
  text, which may name host paths); a Gateway that went away is 503. A request while one runs joins it, so a double click
  compacts once. While it runs, the chat counts as busy (`busyChats`): a send answers
  409 `active` and the composer queues instead (queued dispatch skips the chat without
  a retry backoff, and the compaction's end sends the message at once), archive and
  delete answer `CHAT_BUSY`, maintenance, backups and runtime updates see
  `ASSISTANT_WORK`, the logout of the agent's model account answers 409 `active`,
  and the history carries `compacting: true`, so the chat shows the compaction status
  without a turn. OpenClaw 2026.10.3 runs the summary inside
  `runExclusiveSessionLifecycleMutation("compact")` and holds the session's lifecycle
  lock until it committed; a `chat.send` meanwhile waits for it, so a send would only
  time out and turn uncertain. A large history can take longer than the ten minutes
  the request waits (AGENTPIER-190, `compactTiming` in long-chats.js): the request
  then answers `{compacted: false, running: true}`, never a failure, and the chat
  stays compacting until the Gateway ended the summary. The end, whatever it was, is
  the `sessions.compact` answer: the call stays open up to 60 minutes, and every
  answer maps to one outcome (`compactOutcome` in
  `server/features/assistants/compaction-watch.js`). OpenClaw answers a summary that failed
  (provider or auth error, abort, context-engine failure) as a successful call with
  `ok: false`: that is a failure (502 `CHAT_COMPACT_FAILED`). An active run is a
  refusal (409 `CHAT_BUSY`); the call carries only its reason text, "manual compaction
  unavailable while another embedded run is active", since sessions-compact forwards
  no `failure`. Only `ok: true, compacted: false` or its preflight's "Already
  compacted" / "Nothing to compact" reasons mean nothing was left (409
  `CHAT_COMPACT_NOTHING`). Logs name a short code for such answers (`ok_false`,
  `active_run`), never the reason text. A dropped call is logged with its code. A chat deleted while its summary runs ends that run: no notice, no queued dispatch, no further polls. 2026.10.3 exposes no
  per-session lifecycle state to a read-only call, and its `session.operation`
  events reach only connections subscribed to every session's changes, so neither is
  used. A dropped connection loses only the call (`CLOSED`): if the runtime still
  runs the same Gateway (state `ready` or `reconnecting`, same client and launch), a
  new compaction marker in `chat.history` shows the summary's success (polled every
  30 seconds; the newest marker is read before `sessions.compact`, and if that read
  fails, a marker written since the summary began counts). Any other end leaves no
  marker, so this wait lasts ten minutes at most and then ends as `unknown`; before
  the request answered, it answers that the summary runs. A Gateway that is gone,
  stopping or failed ends the summary at once (before the answer: 503). Failing
  reads are logged once per summary with their code only. An end after the
  request's answer is logged with the Gateway's code and error class and is the
  history's `compactOutcome` (`failed`, `nothing`, `busy`, `interrupted` or
  `unknown`), which the chat shows as a notice until the next summary or a turn the
  person wrote after it showed (a message queued during the summary, even if edited,
  goes out without clearing it); a successful one shows its compaction marker
  (`tests/integration/assistant-manual-compact-contract.test.js` records the answers
  and the marker). The state lives in memory: an AgentPier restart frees
  the chat. Every end publishes `change` and dispatches a queued message once. Afterwards `sessionInfo.totalTokensFresh` is false until the next
  turn, so `longChat` drops, and `chat.history` keeps the earlier messages and adds the
  usual compaction marker. `sessions.compact` itself runs no pre-compaction memory flush
  (that runs only before a turn, `agent-runner-memory`), so for an agent that may write
  memory (`MemoryStep.eligible`: **Remember information** on and the write guard live; a
  shared agent's step writes its shared memory) the request first runs the memory step
  (see the write guard above). The outer job is registered at once, the request answers
  `{compacted: false, running: true}` as soon as the step starts, and the history
  carries `compacting: "memory"` during the step (the chat shows "Saving memories before
  the summary …" and "Saving memories" in
  the header) and `true` during the summary. Any step result but a saved one (failed,
  refused, timed out, interrupted, completed without an admitted memory write, or a
  summary that failed after it) still leads to
  the summary and sets the separate history field `memoryNotSaved: true` next to
  `compactOutcome` ("No memories were saved before the summary."); if the chat is
  still busy afterwards the summary ends with `busy` next to that note. Other sends
  are refused (409) for the whole job. `POST …/long-chat-dismissal` (same routes and
  refusals) reads the session's current `totalTokens` and stores it per person and
  chat under admission, after checking again that the chat still takes turns
  (`assistant_long_chat_dismissals`, private in backups; a deleted chat forgets it). A
  session without a size stores nothing and answers `{dismissed: false}`; a Gateway
  refusal of the read is 502 `CHAT_HINT_FAILED`, a Gateway that went away 503. The
  hint stays hidden until the context reaches that size plus half of it or plus
  50,000 tokens, whichever is smaller (`reappearsAt`). A successful summary forgets
  the hidden hint, and so does a context read smaller than the hidden size (OpenClaw
  summarised it on its own): a chat that grows long again shows the hint. Verified live on the pinned runtime with a
  real local model: refusal during a run, a 109 s compaction (21,277 → 15,512 tokens)
  with one summary model call and no OpenClaw flush, the marker, `Already compacted` on a
  second call and an intact follow-up turn.

The chat (`web/features/assistants/AgentRunState.jsx`, owner's chat and user app
alike) shows the phase or the running tool with its label below the turn, the steps
collapsed under "N steps", and from three quiet minutes while the turn waits for the
model "No answer from the model for N minutes." with **Stop** and **Try again**. Try
again stops the turn and sends "Please continue where you stopped." as the person's
own message; a turn that failed with `timeout` or `stalled` says the model did not
answer in time and offers **Try again** too. A queued message replaces Try again: it
goes out once the turn ends. While no turn runs, a long chat says so with **Summarise
now** and **Hide** where the person can act ([What the agent is doing](agents.md#what-the-agent-is-doing)).

## Live agent list

`/api/assistant-events` (server-sent events, behind the login) carries the agent list
that the sidebar, the agents page and the settings read, as diffs instead of a full
`GET /api/assistants` per `change` event in every tab.

- `AssistantListFeed` (`server/features/assistants/assistant-list-feed.js`) is one
  feed per service, shared by every tab and device. Each `change` or `runtime` event
  schedules a read, debounced for 200 ms; a burst of events reads once, and nothing
  is read without a subscriber. The read is the `GET /api/assistants` body plus
  `runtime`, the `GET /api/assistant-runtime` answer.
- The list becomes `ChatSync` rows (`listRows`): one row per item of an array whose
  items have unique ids (`assistants/<id>`, `conversations/<id>`, ...), one per key
  of an object (`activity/<agentId>`, ...), and one for any other section; the
  metadata `shape` names each section's kind, so empty sections survive. Frames are
  `id: <cursor>` plus `data: {"type":"sync","data":...}` with the encoding of the
  chat feed (a full list or a delta with `upserts`, `removed` and `order`). A read
  that changes nothing sends nothing; subscribers on one cursor share one encoding.
- The stream opens with `{type: "connected", list: true}` and then sends the list
  against the cursor of `Last-Event-ID` (the browser's own reconnect) or the
  `cursor` query parameter (a new stream): a delta when the baseline is known, else
  the whole list. A tab that joins a settled feed gets that value at once and the
  fresh read after it. Baselines live in the feed's own `ChatSync` (30 minutes, not
  persisted); after a restart the stream answers with the whole list. A failed read
  sends `{type: "list-error"}`.
- `change` and `runtime` events still go out; views with their own data (an
  agent's waiting actions, a lead's team coding requests) still read on `change`.
- The browser (`AssistantsRoot.jsx`, `agent-list-sync.js`) applies the frames with
  the session chat's `applyChatSync` and rebuilds the list; sections without changed
  rows keep their identity, so views keyed on one (the teams, for example) do not
  reload. A delta on another base reopens the stream without a cursor for the whole
  list. The browser reads `GET /api/assistants` once when the page starts (a
  sync that overtakes the read wins) and otherwise only as the fallback: while the
  stream fails (which also tells whether AgentPier is reachable), after
  `list-error`, for a server without `list: true` (on `connected` and `change`),
  on coming back to a page whose stream is closed, and after the owner's own actions
  that call `refresh()`.

## Chat attachments (2026-10-13)

The owner can attach up to five files of at most 10 MB each to a message in the
agent chat, to the lead agent and in the direct chat with a team member: "+" >
"Attach file, image or video", paste or drag and drop. Accepted are JPEG, PNG, WebP,
GIF and HEIC images, PDF and UTF-8 text files with a known text or code extension, and
videos (see below). The server decides by the bytes, never by the name or the browser's
type.

- **Storage.** Each file is uploaded when it is picked and copied into
  `attachments/` of the receiving agent's own workspace under a generated name
  (`<date>-<time>-<random>-<safe name>`), mode 0600. The folder must be a real
  directory inside the agent's real workspace; a link there refuses the upload. The
  index (name, type, size, request) lives in the assistants database, never in the
  workspace. Unsent uploads expire after a day, and a page that is closed or reloaded
  discards its own. The page keeps each chat's unsent files with its text draft
  (`assistant-drafts.js`, `agent-attachment-drafts.js`) when the chat is left; on
  return it checks each one with `GET …/conversations/:id/attachments/:file`, which
  restarts its day or answers `attachmentNotFound` (404) for a file that expired or
  whose copy is gone. A conversation keeps at most 20 unsent uploads; a further one
  replaces the oldest, so files abandoned elsewhere never block a new message. Each
  agent holds at most 1 GB or 1000 files there. On a shared agent of users each
  chat's files stay with that chat: the team plugin asks AgentPier
  (`/attachment-policy`, `attachment-access.js`) for every `read`, `memory_get`,
  `pdf`, `image`, `image_generate`, `write`, `edit` or `apply_patch` call naming
  `attachments/` (also as a `file://` URL, judged both as written and as the
  percent-decoded path OpenClaw reads, `file-urls.js`), which allows only files indexed for the calling chat (its turn's, a
  routine run's or the session's own), and `agentpier_share_file` refuses another
  chat's file with `SHARE_NOT_FOUND`. When the agent deletes a sent copy,
  the chat history keeps the message and names that file as no longer available
  (`unavailable: true`, no link).
- **Delivery.** `sessions.send` carries the owner's text followed by a note that
  names each saved copy by its workspace-relative path, so the agent can read it with
  its tools. Images the agent's model accepts also travel inline as `attachments`
  (OpenClaw's `ChatAttachmentSchema`: `type`, `mimeType`, `fileName`, base64
  `content`); the pinned Gateway refuses inline images above 6 MiB, and AgentPier
  keeps all inline images of one turn below 15 MiB so the RPC frame fits. HEIC is
  converted to JPEG in browsers that can decode it (Safari); otherwise it stays a
  workspace file. Image input comes from the model: endpoint models declare it, ChatGPT
  accounts have it, and an OpenRouter model has it when OpenRouter's catalog lists
  `image` among its `architecture.input_modalities`. AgentPier then compiles that
  model with `input: ["text", "image"]`, which the Gateway's `modelSupportsInput`
  reads; without it the Gateway treats the model as text-only and describes images
  instead. A model outside the catalog stays text-only. The composer says so before
  sending when the agent's model cannot see images.
- **History.** OpenClaw keeps the sent text; the history strips the note again and
  returns the files by id. Thumbnails and downloads are served by
  `GET /api/assistant-attachments/:id` behind the login, with `nosniff`, a sandboxed
  content policy and no file system path. Uploads and reads are rate limited.
- **Untrusted names.** File names lose controls, invisible formatting (bidi,
  zero-width) and line separators, are NFC-normalised and cut by whole characters
  within 200 UTF-8 bytes. The note quotes each path as a JSON string and tells the
  agent that names and contents are untrusted data, not instructions.
- **Copies on disk.** Each copy is created by descriptor (`O_EXCL|O_NOFOLLOW`) and
  written only after its inode is proven to be in the checked folder. The index keeps
  its size and SHA-256 (not its inode: Linux reuses inode numbers at once and a restore
  assigns new ones); reads and inline delivery refuse changed, hard-linked or grown
  files and check the inline limits on the bytes read. JPEG and WebP above
  80 megapixels are refused like PNG and GIF. The quota counts the folder itself, and
  index rows whose copy is gone are dropped.
- **Backups.** Copies and their index are part of runtime update snapshots, and of
  host backups only with history and a passphrase, sealed (see
  [backups](backups.md#what-a-backup-holds)).
- **Clearing (2026-10-18).** `GET /api/assistants/:id/attachment-usage` returns the
  folder's entries and regular-file bytes against the limits (`files`, `bytes`,
  `maxFiles`, `maxBytes`, and `capped` once a count stops at 5000 entries).
  `DELETE /api/assistants/:id/attachments`, behind the owner login and the
  admission queue, empties the folder: open video uploads end with their partial
  copies, the folder is removed, unsent index rows are deleted (a queued message
  naming them fails and says so), and sent rows are marked gone, so their messages
  keep the file name as unavailable. Shared files (`shares/<agent>/`) are a separate
  store and stay. The clear is audited as `assistant.updated` with kind
  `attachment-clear`, the entry count and the bytes, never file names. Overview ›
  Chat attachments in the agent settings offers it after a confirmation.
- **Replaced folder.** An agent that puts a link, a file or anything else that is not
  a directory in place of `attachments/` blocks every upload. When the agent's own
  workspace is still a real directory at its real place, usage reports `unsafe: true`
  with 0 files and 0 bytes (the settings explain it), and clearing removes that entry
  itself; the next upload creates the folder again. Any other unsafe storage, such
  as a linked workspace, stays refused.
- **Removal by verified folder.** Clearing and `purge` never delete through a path
  alone. The checked folder (device and inode from the folder check) is first renamed
  into `<assistants>/attachment-trash/`, a private directory outside every workspace;
  rename moves the name itself, never a link's target. Only if the moved entry is still
  that directory is it removed there, out of the agent's reach, where entries are
  unlinked and never followed. A non-directory in the folder's place is unlinked in
  the trash, never what it points to; one that turned into a directory since the check
  is put back. A link or another directory swapped in since the check
  is renamed back untouched and the request fails with `attachmentStorageUnsafe`.
  The share store's `purge` uses the same removal. The trash is runtime-only and
  never part of a backup, sealed or not.
- **Limits.** Agents cannot be deleted today (only archived), so the copies follow
  the workspace; `AgentAttachments.purge` removes an agent's folders and index for a
  future deletion path. OpenClaw also stages inline images it receives under
  `media/inbound/` of the workspace, so such an image exists twice.

### Chat videos (2026-10-18)

The owner can also attach MP4, QuickTime (MOV, as iPhones record in HEVC or H.264)
and WebM videos of up to 200 MB (`agent-video-types.js`, `agent-video-uploads.js`).

- **Recognition.** A video is recognised by its first bytes: an `ftyp` box whose
  major brand is `qt  ` (QuickTime) or an MP4 brand (`isom`, `mp42`, `M4V `, …),
  or, failing that, a compatible brand of either; HEIF brands (`heic`, `mif1`,
  `msf1`, …) stay images. WebM needs an EBML header with DocType `webm`; other
  Matroska files are refused. A completed MP4 or MOV must contain its `moov` box;
  otherwise it is refused and its copy removed.
- **Chunked upload.** `POST /api/assistant-conversations/:id/video-uploads?name=&size=&upload=`
  carries the first chunk and announces the full size; `PUT
…/video-uploads/:upload?offset=` carries the next ones, each at most 8 MiB and
  streamed to disk, so no request meets Node's five-minute request timeout and no
  video is held in memory. The copy is created by descriptor like every attachment
  (`O_EXCL|O_NOFOLLOW`, proven before the first byte) and the chunks are written
  through that descriptor at their offsets. A chunk at the wrong offset gets a 409
  naming the received length, so the composer resumes there; more bytes than
  announced, or a larger chunk, end the upload. The SHA-256 is computed while the
  chunks arrive. Only the completed, checked copy is indexed as a staged attachment,
  making room among the conversation's unsent files like any upload.
- **Retries.** The page chooses the upload id (a UUID), so every chunk can be sent
  again when its reply is lost: a repeated first chunk continues the upload, and for
  ten minutes a finished upload's id answers with its staged file. The composer has
  no fixed request timeout for video chunks; it gives up a chunk after 60 seconds
  without progress and retries it up to three times, and any progress resets that
  budget.
- **Housekeeping.** An upload idle for ten minutes is removed. An agent has at most
  three open uploads; a fourth takes the place of one without a chunk for two
  minutes, or is refused with 429 while all three are moving. Entering maintenance
  (backup, restore, update) drops every open upload with its partial copy. Copies a
  crash or restart left half-written (AgentPier-named files without an index row,
  untouched for ten minutes) are removed at startup and before every quota check.
  Videos still arriving count with their announced size against the per-agent quota
  (1 GB, shared with all other attachments).
- **Metadata.** Duration and display size come from the container without decoding:
  `mvhd` and the video track's `tkhd` (a quarter-turn matrix, as iPhones write for
  portrait videos, swaps width and height) or WebM's `Info` and `Tracks`. The note
  names them, for example `(video/quicktime, 12.3 MB, 0:42, 1080x1920)`, and adds a
  line that the agent cannot watch videos directly.
- **No video understanding.** OpenClaw 2026.10.3 can describe inbound video through
  `tools.media.video` with Google, Moonshot or Qwen (50 MB default), but AgentPier
  configures no such provider, and an RPC frame carries at most 25 MiB. Videos
  therefore never travel inline and no keyframes are extracted (no ffmpeg is
  provisioned).
- **Playback.** `GET /api/assistant-attachments/:id` serves a video inline with its
  type, `nosniff` and the sandboxed content policy, and answers `Range` requests with
  206 (Safari plays nothing otherwise) or 416. Its bytes are checked against the
  recorded size and SHA-256 once per file identity (device, inode, size, change
  times), so a seek does not hash 200 MB again. The app's content policy needs no
  `media-src`: `default-src 'self'` covers the route. The chat shows
  `<video controls playsinline preload="metadata">` without a server-side poster; a
  `#t=0.001` media fragment makes Safari draw the first frame.
- **Download.** `?download=1` on the same route answers with
  `Content-Disposition: attachment` and the file name, also for a video, audio or
  image otherwise served inline, and without a `Range` header sends the whole file
  (200 with its `Content-Length`; `HEAD` gives the length alone). The download
  button beside every video, audio and file in the chat
  (`AgentMessageAttachments.jsx`) links there through `FileLink`: a plain
  `download` link in a browser, which streams to disk without buffering; in the
  iPhone or iPad home-screen app the share sheet, or a separate window for a file
  over 50 MB, because the native players there offer no download.
- **Not yet.** Telegram videos are not received.

### Files agents share (2026-10-17)

`agentpier_share_file {path, caption?}` is compiled into every non-archived agent's
`tools.allow`, team members included, and into a routine's `toolsAllow`. The bridge
serves it in a turn with an active attempt, in a bound routine's run session (as
for SSH) and in a proven completion run of a background command (see **Command
completions**: the plugin sends the call's run and the Gateway's exec record, and the
share acts as the turn that started the command (the owner's own, a work-goal
continuation or a lead's `member-result` follow-up), into its chat and, for a
`telegram` turn whose chat is still paired, to that Telegram chat; AGENTPIER-237), never in a sender bot's session, and routes it to `AgentShares`
(`agent-shares.js`). While AgentPier is in maintenance or recovering it refuses. Its
result tells the agent who sees the file now: the owner, or in a user's chat the
person who asked, never the owner.

- **Source.** `path` is relative to the agent's workspace or absolute inside it. The
  roots come from `shareRoots()` (`agent-share-source.js`): the agent's own
  workspace, which must not itself be a link. With `projectId` the root is a granted
  project folder instead (AGENTPIER-123): only in the turns that may use project
  folders (`AssistantWorkflows.context`: the owner's own, a work-goal continuation,
  a task member's team turns, a lead's `member-result` follow-up on its own grants, the completion run of
  a command one of them started, never a routine), read access suffices
  (`AgentProjectFiles.shareRoot`), the path is first resolved with `projectTarget`
  (never `.git`, links out of the folder or AgentPier's data directory; links that
  stay inside it are resolved, as for folder reads), and the audit event names the
  project. Below the root no component
  may be a symbolic link (even one pointing back inside). Every folder on the way is
  checked with `lstat` (a real directory), then the file is opened without following
  any link (`project-open.js`: `O_NOFOLLOW_ANY` on macOS, the descriptor's own path
  in `/proc/self/fd` on Linux) and must be a regular, non-empty file of at most
  25 MiB with a single hard link. A folder that an agent with a shell swaps for a
  link after the checks is refused by that open, on both platforms; the bytes are
  read through the descriptor. A path in the wrong case is a missing file. Refusals return a stable code and an English reason to the model
  (`SHARE_OUTSIDE`, `SHARE_NOT_FOUND`, `SHARE_TOO_LARGE`, `SHARE_EMPTY`).
- **Store.** The copy goes outside every workspace, into
  `<data>/assistants/shares/<agent id>/` (mode 0700; `SharedFiles`,
  `agent-share-store.js`), written by descriptor like an upload. Shares have their own
  budget per agent, 1 GiB or 2000 files, separate from the owner's uploads; a copy
  expires after 90 days (no longer served, removed by an hourly sweep), and a full
  store gives up its oldest copies. Its type is decided by the bytes: JPEG, PNG, WebP,
  GIF, HEIC and PDF keep theirs; MP4, QuickTime and WebM videos and MP3, Ogg, WAV,
  FLAC and M4A audio are served inline a byte range at a time (`openMedia`, checked
  once by size and SHA-256 per file identity, like the owner's videos) and play in the
  chat; anything else (text, CSV, office files, archives) is stored as
  `application/octet-stream` and only ever downloaded. In the installed home-screen
  app (`display-mode: standalone`, `web/lib/standalone.js`) no file link navigates:
  `FileLink` and `saveBlob` fetch the file and hand it to the share sheet, or open a
  separate window without file sharing. The index row in
  `agent_attachments` names `share:<request id>` (`share:routine:<run id>` for a
  routine; a completion run names the request of the turn it continues) as its request, so no delivery, claim, history note or upload quota of an
  owner turn ever picks it up. The owner deletes a copy with
  `DELETE /api/assistant-conversations/:id/shared-files/:file` from a chat that shows
  it; every message showing it is then marked gone. Copies and index are part of host
  backups.
- **History.** `AgentAttachments.sharedFor` adds one agent message per shared file to
  the history page it falls into (`withSharedFiles`), at the time it was shared, with
  the caption as text and the file in `attachments`; `shared: true` marks it, and
  `unavailable: true` replaces the file when the copy is gone. A change event makes
  the open chat read it at once, also while the turn still runs. The browser's
  history cache keeps it while AgentPier is unreachable.
- **Members.** A member's file joins the member's chat. For a lead's question or task
  (`lead-request`) and a team assignment (`team-member`) a second index row shows the
  same copy in the lead's chat, with `from` set to the member's name.
- **Telegram.** When the turn came from the paired owner chat (`telegram` context),
  or a member works for a lead turn that did (its context's `telegram`), the share is
  queued as a durable outbox notice of kind `file` for that chat, while the chat and
  user still match. The worker reads the copy back by its recorded size and SHA-256
  and uploads it as `multipart/form-data`: `sendPhoto` for JPEG, PNG and WebP up to
  10 MB, `sendDocument` otherwise (up to 50 MB); a photo Telegram refuses outright is
  sent once more as a document. The caption is plain text, at most 1,024 characters.
  `TelegramClient.upload` admits only these two methods; every other method stays
  JSON-only. The caption is stored with the outbox entry, apart from the text the
  activity list shows. A file gone before delivery ends as `FILE_UNAVAILABLE`. A
  routine's run sends to the chat its routine delivers to. Each share writes an
  `assistant.sent` audit event with `kind: "share"`.

## Continuous integration

The `Assistant runtime` workflow runs the opt-in native contracts in a
`native-contracts` job (Ubuntu x64 on pull requests touching assistants; nightly,
on demand and before a release also macOS arm64, Ubuntu arm64 and macOS x64). Each
runner splits the contracts into balanced shards (four, six on macOS
x64) with `scripts/assistant-contract-shards.mjs`, whose JSON file lists every
contract and its recorded duration. Each shard provisions the pinned runtime with
`scripts/provision-assistant-contracts.mjs`, uses simulated model endpoints, accounts
and channels, needs no secrets, and fails if any contract skips. It also points the
compiled web tools contract at the runner's preinstalled Google Chrome and fails
when none is installed. The live provider
test stays manual. A `cross-version` job (nightly and before a release) installs the
runtimes that older release tags pinned and runs the cross-version update tests
against the current pin; see
[release qualification](assistant-release-qualification.md#update-paths-installed-users-take). The browser matrix runs every
`assistant*.spec.js` in Chromium and, nightly or on a pull request labelled `webkit`,
in WebKit; a Playwright `tablet` project (820x1180, touch) repeats those specs at iPad
size in WebKit. The slim `Assistant runtime (queue)` workflow
(`assistant-runtime-queue.yml`) runs in the merge queue only: it passes at once when
no assistant runtime path changed and otherwise runs the core native contracts.

Dependabot must never update `server/features/assistants/runtime-lock/`; the
exclusion and the refresh procedure for security alerts there are described in
[runtime updates](assistant-runtime-updates.md). Changing the OpenClaw version
follows the requalification checklist in
[ADR 0002](adr/0002-managed-openclaw-assistants.md#openclaw-coupling-and-version-requalification).

## Deferred work and known limits

- **Team spend budgets** are deferred (Plane AGENTPIER-7). Team size, concurrency and
  deadlines bound a team; token or cost budgets do not exist yet.
- **Azure qualification pending an endpoint.** Ollama and llama.cpp were qualified
  with small local models on 2026-10-10 (see [provider qualification](assistant-provider-qualification.md)).
  Azure OpenAI-compatible connections are verified against simulated endpoints only.
- **Not started:** Gmail, Microsoft 365, Google Calendar and Apple service adapters, a
  sandbox design, independent Gateway instances and Linux or other architectures
  beyond the qualified hosts.
- **MCP servers:** SSE servers (with headers or OAuth), OpenClaw's idle eviction of
  stdio processes and its stdio environment filtering are not qualified; OAuth is
  qualified against a local authorization server on Streamable HTTP only, and Linux
  runs only in CI (see [MCP qualification](assistant-mcp-qualification.md#boundaries)
  and [MCP OAuth qualification](mcp-oauth-qualification.md)).
- **Shell access:** no sandbox; commands moved to the background keep running
  when the level goes to Off (OpenClaw offers no way to end them from outside the
  agent) until they end, or on Linux until the Gateway stops; `process` actions, a
  real 30-minute approval expiry and allow-always availability on Linux are not
  qualified locally (see
  [shell qualification](assistant-shell-qualification.md#boundaries)).
- Plain-language team authorization has the accepted limits described under Visible
  teams. Rollback or restore after a credential revocation needs a new login, and
  works on the same host only (see [runtime updates](assistant-runtime-updates.md)).
