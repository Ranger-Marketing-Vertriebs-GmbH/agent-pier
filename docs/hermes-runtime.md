# Hermes runtime

AgentPier can run an agent on [Hermes Agent](https://github.com/NousResearch/hermes-agent)
beside OpenClaw ([ADR 0006](adr/0006-assistant-runtime-port.md)). Each Hermes agent runs
in its own supervised process set, its messaging gateway and AgentPier's RPC bridge,
with its own `HERMES_HOME` inside AgentPier's private runtime folder
([processes](assistant-runtime-updates.md#hermes-agent-runtime)). This guide describes
what AgentPier writes into that home, which defaults it sets and how it talks to the
gateway. AgentPier pins the Hermes release `v0.22.5` (commit `bf0203a7`, pinned
release since 2026-11-01); key names, file references, the gateway protocol and the
approval and event shapes below were verified against it. The
[spike](research/hermes-runtime-spike.md), on the earlier `main` commit `a4994d4e`,
records the hands-on evidence.

## Hermes configuration

The Hermes compiler (`server/features/assistants/runtimes/hermes/hermes-compiler.js`)
turns one agent's runtime-neutral desired state into these files of its home, and
nothing else:

| File                       | Content                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `config.yaml`              | Model, toolsets, approvals, memory, skills, MCP and defaults     |
| `.env`                     | The model connection's key and the MCP servers' secrets          |
| `SOUL.md`                  | The agent's instructions                                         |
| `plugins/agentpier-guard/` | `plugin.yaml` and `__init__.py`, only for every-command approval |

The agent's memory (`memories/MEMORY.md`, `memories/USER.md`) and the `AGENTS.md` of
its work folder are not compiled: they are read and written through the agentFiles
sub-port ([memory and instructions](#memory-and-instructions)).

### Merging with what Hermes writes

Hermes writes into the same files: `_config_version`, `onboarding.seen.*`,
`gateway.multiplex_profiles`, `command_allowlist` after an "always" approval, and
channel tokens in `.env`. These keys are runtime state. AgentPier reads the whole file,
replaces only the keys it owns, keeps every other key where it was and writes the
document once, so no key appears twice (Hermes's YAML loader refuses duplicate keys). A
`config.yaml` that is not a YAML mapping is refused rather than overwritten. Files are
written atomically and owner-only. A start that does not know the model connection or
the instructions leaves the `model` section, the key in `.env` and `SOUL.md` as they are.

### Shell levels

| Level         | Hermes setting                                                              |
| ------------- | --------------------------------------------------------------------------- |
| Off           | `terminal` and `code_execution` toolsets disabled; `approvals.mode: manual` |
| Approval      | `approvals.mode: manual`: commands Hermes flags as dangerous ask the owner  |
| Every command | `manual` plus the `agentpier-guard` plugin in `plugins.enabled`             |
| Full          | `approvals.mode: off`: Hermes runs every command without asking             |

Hermes's own default, `smart`, lets an auxiliary model approve flagged commands; AgentPier
always sets `manual` or `off`. The guard plugin's `pre_tool_call` hook returns
`{"action": "approve"}` for every `terminal` command, `execute_code` run and input sent
to a running process. Its message carries the command itself, and its rule key hashes
the exact text, so "always" allows that one command again and never every command.
Every-command approval is a Hermes-only option: the agent's settings offer **Every
command** beside **Dangerous commands** (`approval`) where the runtime reports the
`everyCommandApproval` capability, and store it as `shell: "approval"` with
`shellEveryCommand: true`. The desired state keeps AgentPier's three levels; the
runtime passes the choice to the compiler (`strict`). OpenClaw reports the capability
unavailable, because its "approval" already asks before every command. A dangerous
command under every-command approval asks once: Hermes asks a plugin's question
first and then runs its own dangerous-command check, so the guard leaves the shell
commands Hermes flags as dangerous (`tools/approval_detection.py`) to that check,
which asks with Hermes's reason. A plugin's question names the call only as
`<terminal> (plugin approval rule)`; AgentPier shows the guard's message, the command
itself, in the approval card.

### Model connection

| Connection                        | `model` section                                                        | `.env`                        |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| Custom OpenAI-compatible endpoint | `provider: custom`, `base_url`, `default`, `key_env`, `context_length` | `AUXILIARY_AGENTPIER_API_KEY` |
| Endpoint with an `api-key` header | the same, plus `extra_headers` referencing the key                     | `AUXILIARY_AGENTPIER_API_KEY` |
| Local server without a key        | `provider: custom` without `key_env`                                   | none                          |
| OpenRouter                        | `provider: openrouter`, `default`                                      | `OPENROUTER_API_KEY`          |
| ChatGPT account                   | removed: not supported on Hermes yet                                   | none                          |

`api_mode` is always `chat_completions`. The key never appears in `config.yaml`. Hermes
strips `AUXILIARY_*_API_KEY` and `OPENROUTER_API_KEY` from every command and process it
starts, so the agent's own commands do not see the key. A model that accepts images sets
`agent.image_input_mode: native`.

### Practical defaults

AgentPier changes only what touches credentials, sends data off the host without the
owner's choice, changes the installation or rewrites the first turn:

| Key                                                | Value   | Why                                                       |
| -------------------------------------------------- | ------- | --------------------------------------------------------- |
| `auth.adopt_external_logins`                       | `false` | Never borrow the host's Codex or Claude Code logins       |
| `web.keyless_fallback`                             | `false` | No searches through free tiers the owner did not choose   |
| `onboarding.profile_build`                         | `"off"` | No onboarding offer appended to the first message         |
| `delegation.subagent_auto_approve`                 | `false` | A subagent's dangerous command is never approved silently |
| `updates.check`, `plugins.auto_update_check_hours` | off     | AgentPier installs and updates Hermes                     |
| `security.allow_lazy_installs`                     | `false` | No packages installed from PyPI at run time               |
| `telemetry.shared_metrics.enabled`, `.send`        | `false` | No shared metrics                                         |

Invisible subagents (`delegate_task`) stay on. In a session of the messaging gateway,
their dangerous commands reach the owner through the session's approval queue.
`terminal.backend` is `local` and `terminal.cwd` is the agent's folder.

### Toolsets

`agent.disabled_toolsets` follows the agent's settings: `memory` (and
`memory.memory_enabled`) with memory, `file` with memory or shell access, `web` with web
search or fetch, `vision` with documents and `image_gen` with image creation. `browser`,
`computer_use` stay off until AgentPier serves them on Hermes; `cronjob`, the agent's own
Hermes jobs, stays off because AgentPier sets up routines on the same scheduler
([Routines](#routines)).

### Memory and instructions

The agentFiles sub-port (`runtimes/hermes/hermes-files.js`) serves a Hermes agent's
files under the names AgentPier uses for OpenClaw's, while the agent's set runs:

| Name        | File                               | Meaning                                          |
| ----------- | ---------------------------------- | ------------------------------------------------ |
| `MEMORY.md` | `<HERMES_HOME>/memories/MEMORY.md` | The agent's own notes (Hermes's `memory` store)  |
| `USER.md`   | `<HERMES_HOME>/memories/USER.md`   | What it knows about the owner (`user` store)     |
| `SOUL.md`   | `<HERMES_HOME>/SOUL.md`            | The instructions AgentPier compiles              |
| `AGENTS.md` | `AGENTS.md` in its work folder     | Project context Hermes loads from `terminal.cwd` |

Hermes has no API for these files (`tools/memory_tool.py`, `tools/memory_tool_store.py`),
so the adapter reads and writes them directly: atomically, owner-only, only over the
hash or absence the caller read, never through a link the agent put in their place.
Entries in a memory file are separated by `\n§\n`. Hermes refuses a memory write that
would take a store over its limit, counted as its entries joined by that separator:
2,200 characters for `MEMORY.md` and 1,375 for `USER.md`. AgentPier compiles both
limits (`memory.memory_char_limit`, `memory.user_char_limit`) and refuses an owner's
edit beyond them with `memoryTooLarge` (413), since Hermes would keep loading such a
file but refuse every later write of the agent. Hermes freezes memory into a
session's prompt when the session starts, so an edit reaches the agent's next chat.
Memory search looks for the query's words in the entries of both files; Hermes's own
`session_search` covers past chats, not memory.

The agent keeps its memory with Hermes's `memory` tool and Hermes's background review
after a turn (`memory.write_approval` stays off, Hermes's default). AgentPier's memory
step before a chat summary is OpenClaw's: AgentPier's write guard never sees a Hermes
agent's writes, so Hermes agents skip it (`memory-step.js`). Notes below `memory/` and
the Dream Diary are OpenClaw's and stay empty for a Hermes agent.

### Skills

Hermes seeds every skill it bundles into the home's `skills/` folder
(`tools/skills_sync.py`) and offers each skill it finds there or in a folder of
`skills.external_dirs`, unless `skills.disabled` names it (`agent/skill_utils.py`).
The compiler (`hermes-config/skills.js`) writes:

| Key                    | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| `skills.disabled`      | Every bundled skill the owner did not switch on, except `hermes-agent` |
| `skills.external_dirs` | The live folder of each catalog skill the owner switched on            |

`hermes-agent` is essential to Hermes and cannot be switched off. Catalog skills are
checked before each apply (a tampered copy is restored from the catalog's store, a
damaged one is left out) and offered from their folders in the catalog's live copy; a
skill of the same name in the home wins over an external one, so such a catalog skill
shows as replaced. An assigned name Hermes neither bundles nor finds in the catalog is
named as `skills` (below). AgentPier's built-in skills (shopping) need the browser and
are not offered yet.

Skills the agent writes itself (`skill_manage`) or installs inside Hermes stay on:
practical default, owner's choice. Nothing names them, so Hermes offers them, and
`skills.write_approval` stays off. The skills page lists them as **On: the agent wrote
or installed this skill itself in Hermes Agent** without a switch. Hermes's curator
may archive such skills after long disuse; it never touches bundled, hub-installed or
external skills.

The skills sub-port (`hermes-skills.js`) answers `status` from the installation and
the home as Hermes reads them: each skill with its `origin` (`bundled`, `catalog`, or
`local` for the agent's own), whether `skills.disabled` filters it, and what it
misses on this host (`prerequisites.commands` on the agent's PATH, `platforms`,
`required_environment_variables` in its `.env`).

### MCP servers

The MCP servers the owner binds to a Hermes agent under **Access** come from
AgentPier's central MCP store, as for OpenClaw; the compiler (`hermes-config/mcp.js`)
writes them into the agent's `mcp_servers`
(`website/docs/reference/mcp-config-reference.md`, `tools/mcp_tool_config.py`):

| Store                    | `mcp_servers.<name>`                                 |
| ------------------------ | ---------------------------------------------------- |
| Local command (stdio)    | `command`, `args`, `env`, `cwd`                      |
| Streamable HTTP, SSE     | `url`, `headers`; `transport: sse` for SSE           |
| Startup and tool timeout | `connect_timeout`, `timeout`                         |
| Agent placeholders       | resolved to the agent's work folder (`terminal.cwd`) |

Each agent has its own home, so a server keeps its stored name, and Hermes names its
tools `mcp__<server>__<tool>`, other characters than letters, digits and `_` replaced by
`_` and the name cut to 64 characters with a hash (`tools/mcp_tool_schema.py`
`mcp_prefixed_tool_name`; Hermes's own guide still says `mcp_<server>_<tool>`): a
server `my-api` offers `create-issue` as `mcp__my_api__create_issue`. Hermes offers
MCP tools through its tool search (`tools.tool_search`, on by default,
`website/docs/user-guide/features/tool-search.md`): the model sees `tool_search`,
`tool_describe` and `tool_call` with a listing of the servers' tools and calls one
through `tool_call`, which Hermes unwraps to the tool itself. AgentPier keeps that
default. No secret stands
in `config.yaml`: every environment value, header and URL is a reference
(`${AUXILIARY_AGENTPIER_MCP<n>_<kind><m>_API_KEY}`) to the agent's `.env`, which Hermes
resolves when it connects. Hermes strips such names from every command and process it
starts, so the stdio server gets its configured value while the agent's shell never
sees it. A secret with a quote or a line break cannot stand in `.env` literally; such a
server is left out. Trust stays Hermes's default `full`, as on OpenClaw: a bound
server's tools run without asking. No spend limit is set; AgentPier's store has no
tool costs.

A change of a Hermes agent's servers (a binding, an edited server or secret) applies
that agent (`mcp-changes.js`), whether or not OpenClaw runs. The agent's set restarts:
Hermes's gateway watches `config.yaml` and `reload.mcp` rediscovers servers, but a
session's tool list stays frozen until its next start, so neither would reach the
chats already open. The pinned installation includes Hermes's `mcp` extra (the MCP
SDK); AgentPier keeps Hermes's lazy installs off, so an installation built before the
extra was pinned is offered as an update.

OAuth servers are not offered to Hermes agents: OpenClaw holds the login's tokens
([MCP OAuth qualification](mcp-oauth-qualification.md)) and AgentPier keeps none of its
own to hand over, while Hermes's own OAuth store would need a second login per agent
inside Hermes. Binding one to a Hermes agent is refused (`oauthHermesUnsupported`), and
the compiler names one bound before as `mcpOAuth`. The owner's server overview resolves
agent placeholders for OpenClaw's workspace; a Hermes agent's resolved paths differ.

### Not mapped yet

The compiler names what an agent wants that Hermes does not get yet, so the owner can see
it: ChatGPT accounts, the browser, MCP servers it cannot compile (`mcp`, `mcpOAuth`),
assigned skills Hermes cannot offer, PDF reading, the agent's own routine tool (owner
routines work, [Routines](#routines)), team tools and the extra folders on the shell's
PATH. Routines, MCP, skills and Telegram
follow in step 5 of the ADR's delivery order, teams and the browser in step 6. Hermes has
no advanced settings in AgentPier yet: the capability reports
`advancedSettingsUnsupported`.

## Agents on Hermes

`runtime-for.js` resolves an agent that records `runtime: "hermes"` to its own
runtime in the Hermes fleet (`runtimes/hermes/hermes-fleet.js`), one supervised
process set per agent, keyed by its runtime agent id. The fleet is attached to the
OpenClaw supervisor that feature code passes around, so callers keep using
`runtimeFor(agent, supervisor)`, `hostReady(supervisor, agent)` and
`hostConnection(supervisor, agent)`; calls that know only a session key use
`runtimeForSession`. Hermes agents may be created and started only while Hermes is
enabled and installed (problem `hermesUnavailable` otherwise).

| Event                                    | What happens to the agent's set                             |
| ---------------------------------------- | ----------------------------------------------------------- |
| Created, or a setting changed            | The apply writes its home; a changed home restarts the set  |
| AgentPier starts, Hermes switched on     | Every Hermes agent that is not archived starts              |
| Archived                                 | The set stops; restoring starts it again                    |
| Deleted                                  | The set stops; its HOME, HERMES_HOME, work, tmp and logs go |
| Hermes switched off, agents switched off | Every set stops                                             |
| Hermes update (**Agents › Runtime**)     | All sets stop, the new release starts them, or rolls back   |

The OpenClaw start never compiles Hermes agents, and OpenClaw's roster checks,
approval resync skip them. Their chats reconcile on their own
set's connection (`chat-reconcile.js`, `run-reconciler.js`), and the run events of
every set reach the chat path and the event hub once (`agentRuntimeEvents`).

| Capability                                                  | Hermes                              |
| ----------------------------------------------------------- | ----------------------------------- |
| host, sessions, events, approvals, config, agents, routines | available                           |
| agentFiles, skills                                          | available                           |
| everyCommandApproval                                        | available (unavailable on OpenClaw) |
| browser, models, channels                                   | `hermesNotYetSupported`             |
| advancedSettings                                            | `advancedSettingsUnsupported`       |

## Routines

Reminders, routines, check-ins and hook runs of a Hermes agent run on the cron scheduler
of its own messaging gateway (`runtimes/hermes/hermes-routines.js`, translation in
`hermes-routine-jobs.js`). The adapter reaches the scheduler through the REST routes the
gateway hosts (`/api/cron/jobs…`, `hermes_cli/web_routers/cron.py`): the RPC bridge's
`agentpier.http` method takes a one-request `native-http` ticket from the gateway's
owner-only control socket for each call (`hermes_cli/dashboard_auth/native_http.py`),
so no ticket leaves the bridge. The gateway serves its home as the profile `default`.

| Routine field                  | Hermes job                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| name, prompt text              | `name`, `prompt` (Hermes trims it)                                                       |
| schedule cron / at / every     | five-field expression, ISO time (`once`), `every <n>m` (whole minutes only)              |
| prompt model `provider/model`  | `model` (the model id, on the agent's own connection)                                    |
| enabled                        | `enabled`, through `pause` and `resume`                                                  |
| marker, target, delivery, rest | the job's own `agentpier` field (Hermes keeps fields it does not know)                   |
| run state                      | `next_run_at`, `fire_claim.at` (running), `last_run_at`, `last_status`, `failure_streak` |
| runs                           | `GET …/runs`: each run's own stored session                                              |

A job is created paused, given its `agentpier` field and only then resumed, so it never
runs without AgentPier's marker. Hermes's forced run (`trigger`) resumes a paused job; a
routine that was disabled (event routines, hook runs) is paused again right after it.
The trigger answers once the run ended; a run still going after 15 seconds counts as
queued. The delivery is always `local`: Hermes keeps the result, and the adapter hands
it to AgentPier's completion webhook as OpenClaw does (`{ jobId, runAtMs, status,
summary, error, deliveryStatus, sessionKey }`, with the webhook's token). It finds a
finished run by the job's `last_run_at`, checked on each `cron.changed` event the
gateway sends, after each forced run and every 15 seconds, and records what it delivered
in `agentpier-routine-runs.json` in the agent's `HERMES_HOME`, so a restart delivers a run
once more at most (AgentPier's receivers ignore a replay). The summary is the run's last
reply, whole; Hermes's `[SILENT]` arrives as `NO_REPLY`. Hermes runs a routine in a
session of its own and does not write its result into the target chat's transcript
(`deliveryStatus: "not-delivered"`): AgentPier shows it in the chat, but a later turn of
the agent does not see it. A run's session key is
`agent:<runtimeAgentId>:hermes:cron:<job>:<session id>` (`routines.runOf`); the sessions
sub-port reads its transcript.

Hermes runs cron expressions in the agent's Hermes time zone, which is the time zone
AgentPier passes to the process set; a routine's own time zone is kept with the job but
does not move it. Hermes refuses dangerous commands in a routine run
(`approvals.cron_mode: deny`, no one is there to answer); with every-command approval that
is every command. The agent's own routine tool needs AgentPier's team tools, which come to
Hermes with teams.

## Gateway protocol

AgentPier writes the home before each start (`runtimes/hermes/hermes-runtime.js`), then
talks to the gateway's session store over the RPC bridge: newline-delimited JSON-RPC
2.0, the same framing as Hermes's stdio server, but the gateway's own methods. The
adapter (`hermes-sessions.js`, `hermes-run-state.js`, `hermes-approval-queue.js`)
relies on these:

| Purpose           | Gateway method or event                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Create a chat     | `session.create { request_id, title }`: idempotent by `request_id`; titles are unique     |
| Attach a chat     | `session.resume { session_id, omit_messages }`: needed before a turn, after every restart |
| Find a chat       | `session.list { title }`                                                                  |
| Run a turn        | `prompt.submit { session_id, text, submission_id }`: answers the turn's `admission_id`    |
| Stop a turn       | `session.interrupt { session_id, execution_generation }`; `prompt.cancel` while queued    |
| Read a transcript | `session.history { session_id }`                                                          |
| Compress, archive | `session.mutate { operation, payload, request_id, expected_revision, … }`                 |
| Delete            | `session.mutate` with `delete` and `expected_generation`                                  |
| Title a chat      | `llm.oneshot` with the `title_generation` task                                            |
| Turn frames       | `message.start`, `message.delta`, `tool.*`, `message.complete`, each with `admission_id`  |
| Approvals         | `approval.request` → `approval.respond`; `approval.settled`, `approval.cancelled`         |
| Routines          | `agentpier.http` (the bridge) → `/api/cron/jobs…`; the event `cron.changed`               |

Every refusal is code 4001 with its reason in `error.data.reason`; an unknown parameter
is refused as `invalid_params`, so AgentPier sends only the parameters listed.

## Contract tests

`tests/unit/hermes-config-golden.test.js` compares the compiled homes with
`tests/fixtures/hermes-golden/`. `tests/integration/hermes-config-check-contract.test.js`
runs `hermes config check` on each compiled home and checks how Hermes reads it: the
approval mode, the toolsets, the guard plugin, the model route and that the key stays out
of child processes. The sessions, approvals, routines, host and install contracts run
the agent through the Hermes runtime, its supervised gateway and the RPC bridge, against
the in-repo fake model; `hermes-agent-routines-contract.test.js` runs an owner's routines
through AgentPier's routine routes. `tests/integration/hermes-files-contract.test.js`
checks the agent's files: a memory entry written through the port reaches the agent's
prompt, and an entry the agent adds with Hermes's `memory` tool comes back through it;
an assigned bundled skill and a catalog skill reach the agent's skill index while an
unassigned one stays out, and a skill the agent writes is reported as its own; a bound
stdio MCP server's tool is offered and called, and its secret never reaches the agent's
shell. Set `AGENTPIER_HERMES_CONTRACT_RUNTIME` to an installation made by
`scripts/provision-hermes-contracts.mjs` (its `venv/bin/` holds `python` and
`hermes`). The tests use a private `HOME` and `HERMES_HOME` and never touch
`~/.hermes`.
