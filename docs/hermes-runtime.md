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

| File                          | Content                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `config.yaml`                 | Model, toolsets, approvals, memory, skills, MCP, plugins, the agent's bot and the defaults       |
| `.env`                        | The model connection's key, the MCP servers' secrets, the agent's bot token and the Deepgram key |
| `SOUL.md`                     | The agent's instructions                                                                         |
| `plugins/agentpier-guard/`    | `plugin.yaml` and `__init__.py`, only for every-command approval                                 |
| `plugins/agentpier-team/`     | AgentPier's team tools and tool guard ([teams](#teams))                                          |
| `plugins/agentpier-deepgram/` | `plugin.yaml` and `__init__.py`, only for a bot for other people with voice                      |

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
| ChatGPT account                   | refused: Hermes agents cannot choose one                               | none                          |

Every endpoint kind AgentPier offers agents (OpenAI, Azure OpenAI, Anthropic's and other
vendors' OpenAI-compatible APIs, Ollama, llama.cpp, LM Studio) is a Chat Completions
endpoint and compiles to `provider: custom`. `api_mode` is always `chat_completions`, so
Hermes never switches an `api.openai.com` or `/anthropic` URL to another wire protocol
(`agent/agent_init.py`). The endpoint's Chat Completions options need no key: Hermes
sends no output cap on an agent's turn and picks `max_completion_tokens` itself where
it sends one (`maxTokensField`), and it repeats a stream without `stream_options` once
an endpoint refuses them (`streamUsage`). A ChatGPT account's OAuth profile stays in
OpenClaw's store, which OpenClaw refreshes; OpenAI rotates the refresh token, so a copy
in a Hermes home (Hermes's `openai-codex` provider refreshes on its own) would sign one
of them out. AgentPier therefore lists ChatGPT accounts unavailable for Hermes agents
and refuses one (`modelAccountRuntime`). The models sub-port (`hermes-models.js`)
answers Hermes's model inventory of the home (`model.options`) and no accounts;
sign-ins stay host-wide on OpenClaw. A model switch is a `config.apply` that restarts
the agent's process set; AgentPier has no per-chat model. The key never appears in `config.yaml`. Hermes
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
search or fetch, `vision` with documents, `image_gen` with image creation and `browser`
with the browser ([browser](#browser)). `computer_use` stays off until AgentPier serves
it on Hermes; `cronjob`, the agent's own Hermes jobs, stays off because AgentPier sets
up routines on the same scheduler ([Routines](#routines)).

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
default, except for an agent with team tools, which gets `tools.tool_search.enabled:
off` ([teams](#teams)) and so sees its MCP tools directly. No secret stands
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
it: ChatGPT accounts, the browser while AgentPier knows no browser app, MCP servers it
cannot compile (`mcp`, `mcpOAuth`), assigned skills Hermes cannot offer, PDF reading,
the agent's own routine tool (owner routines work, [Routines](#routines)), team tools
while no team bridge runs, and the extra folders on the shell's PATH. Hermes has no
advanced settings in AgentPier yet: the capability reports
`advancedSettingsUnsupported`.

## Teams

A Hermes agent leads a team and works as a member as an OpenClaw agent does
([teams](agents.md#teams-asks-and-tasks)): AgentPier's team tools, the team bridge, provisioning,
delegation, results and every member's own chat are the same. A member runs on its
lead's runtime (`assistant-store.js` reads a member's runtime from its lead), so a
Hermes lead's members are Hermes agents, each in its own process set, and an OpenClaw
lead's members run on OpenClaw. Mixed teams cannot arise: no path gives a member
another runtime than its lead's, and moving an agent between runtimes is a later
migration (ADR 0006).

The `agentpier-team` profile plugin carries both parts of the OpenClaw team plugin:

- **Tools.** The plugin registers the agent's team tools with `ctx.register_tool` under
  their OpenClaw names (`agentpier_team_propose`, `agentpier_team_delegate`, …; a
  member gets `agentpier_team_peers`, `agentpier_team_peer_ask`,
  `agentpier_team_peer_delegate` and `agentpier_team_report`), with the same
  descriptions and schemas (`team-plugin/index.js`). A plugin tool's handler receives
  the calling session's id, the stored session id the session keys carry, and runs
  under the tool call's id (`model_tools.py` `handle_function_call`,
  `tools/approval_context.py`); an MCP call carries neither (`tools/mcp_tool_handlers.py`
  sends only the arguments), so the team tools are no MCP server. Each call takes a
  ticket for its session from the bridge (`/prepare`) and waits inside the tool for the
  answer (`/invoke`): an ask or a proposal waits up to about two minutes, beyond Hermes's
  30-second hook timeout. Hermes's Tool Search would put plugin tools behind its
  `tool_search` bridge (`tools/tool_search.py`); an agent with team tools gets
  `tools.tool_search.enabled: off`, so they are offered directly, as on OpenClaw.
- **Guard.** A `pre_tool_call` hook asks the bridge (`/hermes-guard`,
  `hermes-tool-guard.js`) before a team member's `write_file` or `patch` and before
  every browser call. It applies the OpenClaw guard's rules (`team-plugin/tool-guard.js`):
  a file change stays inside the agent's own folder, never touches an instruction file
  (`AGENTS.md`, `SOUL.md`, skill folders, …) and is allowed only as the bridge allows
  the turn, so a task the owner did not ask for runs read-only. The hook answers within
  10 seconds; no answer blocks the call (Hermes blocks a hook that fails or outlasts its
  30 seconds as well). An own agent's file changes stay Hermes's own, as in step 4.

The bridge's address and token change with every AgentPier start. They live in
`plugins/agentpier-team/bridge.json`, which the plugin reads at each call, so a new one
needs no restart. A lead's instructions (`SOUL.md`) carry the **Your team** section
without the member list, because Hermes reads them only at its start;
`agentpier_team_members` lists the current members.

Invisible subagents (`delegate_task`) stay on and apart from visible teams: a subagent
runs under a session of its own, which no AgentPier turn is bound to, so its team tool
calls are refused; the plugin's `subagent_start` hook maps it to its parent, so the
guard judges its file changes and browser calls as the parent's.

Gaps beside OpenClaw's guard: memory steps, restricted users' locked tools, attachment,
secrets, image and PDF checks have no Hermes counterpart yet, because Hermes agents
have none of those features in AgentPier. A compression that gives a Hermes session a
new id ends its team tool calls until the chat is opened again.

## Browser

AgentPier starts and owns each Hermes agent's Chromium (`runtimes/hermes/hermes-browser.js`),
as OpenClaw does for its agents, with the same browser app (`browser-detection.js`):
the agent's own profile in `<data>/assistants/hermes/home/<agent>/agentpier-browser/`,
a CDP port on `127.0.0.1` chosen once and kept, headless unless the agent's **Visible
window** and a separate agent browser app allow a window, and the launch flags of
OpenClaw's launches (mock keychain, no throttling). The compiled home turns the
`browser` toolset on with:

| Key                          | Value                                             |
| ---------------------------- | ------------------------------------------------- |
| `browser.backend`            | `off`: Hermes's own tools, not Browser Use        |
| `browser.cdp_url`            | `http://127.0.0.1:<port>` of the agent's browser  |
| `browser.allow_private_urls` | **Allow private networks for all agent browsers** |

A CDP URL never launches a browser of Hermes's own and skips its Chromium checks and
installs (`tools/browser_tool_session.py`, `tools/browser_tool_cloud.py`). Hermes's
browser tools (`browser_navigate`, `browser_snapshot`, `browser_click`, …) run the
agent-browser binary against that URL; the Hermes installation provisions the release
Hermes's own package lock pins, so Hermes never installs it at run time
([installation](assistant-runtime-updates.md#hermes-agent-runtime)). Hermes reads the
URL at each call and opens one browser session per chat, closed at the end of each
turn; the browser and its tabs stay.

The team plugin's guard asks before every `browser_*` call
([teams](#teams)): AgentPier's browser limits (`agent-browsers.js`) admit it, start
the Chromium if it does not run, and refuse with the OpenClaw guard's reasons (the
owner holds the browser, three visible browsers are in use, the browser is off). The
idle stop after 15 minutes, the owner's start and stop, the live view and takeover work
as on OpenClaw: the browser sub-port speaks the part of OpenClaw's browser control API
they use (`GET /`, `POST /start`, `POST /stop`, `GET /tabs`, `POST /screencast`), and
its screencast relays CDP's `Page.startScreencast` frames in OpenClaw's frame format.
The browser stops with the agent's process set.

Navigation policy: with **Allow private networks for all agent browsers** off, Hermes
refuses private, loopback and link-local addresses before `browser_navigate`, after a
redirect, before clicks and typing, and after snapshots (`tools/browser_tool.py`,
`tools/url_safety.py`); cloud metadata addresses stay blocked even with it on, stricter
than OpenClaw. Hermes reads the setting at its start; a change reaches the agent with
its next apply, which restarts its process set. Gaps beside OpenClaw's policy: Hermes
checks the page's top-level address only, not the requests a page makes, and
`browser_scroll` is not checked. Temporary team members on Hermes have no browser yet
(OpenClaw lends them a member slot); a Hermes agent's file uploads in the browser are
not staged by AgentPier yet.

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
| models                                                      | available (no ChatGPT accounts)     |
| channels                                                    | available (the owner's Telegram)    |
| channelBots                                                 | available (Hermes's own adapter)    |
| browser                                                     | available (AgentPier's Chromium)    |
| everyCommandApproval                                        | available (unavailable on OpenClaw) |
| advancedSettings                                            | `advancedSettingsUnsupported`       |

Teams have no capability of their own: a Hermes agent offers them as OpenClaw does.

### Telegram

The owner's Telegram chat with a Hermes agent runs through AgentPier's own channel layer
(`server/features/assistant-channels/`), exactly as for OpenClaw agents: AgentPier pairs
the bot, polls it, checks the allowed sender, transcribes voice notes with Deepgram,
stages photos and files, hands each input to the agent's Hermes session like a web turn
and sends the reply from its history through the outbox. Hermes's own Telegram adapter
never polls the owner's bot: a bot id serves either the owner's AgentPier bot or one
agent (`native-telegram-store.js`), so one bot never has two pollers. Hermes's history rows carry no
run id; the sessions sub-port attributes the reply rows of the turns AgentPier submitted
by their prompt text (`hermes-turns.js`), so delivery finds the reply of the run its
input started.

An agent's own bot for other people (the `channelBots` capability, **Agents › _agent_ ›
Channels › Telegram for other people**) runs on Hermes's own Telegram adapter in that
agent's gateway (`hermes-config/telegram.js`). AgentPier keeps the token, the allowed
people and the speech key as for OpenClaw ([qualification](assistant-telegram-senders-qualification.md));
the agent's apply compiles them (`assistant-channels/telegram-senders-own.js`) and a
changed home restarts only that agent's set, so no Gateway restart is asked for.

| Setting                                                     | Effect                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `.env` `TELEGRAM_BOT_TOKEN`                                 | Enables the adapter; Hermes strips it from every command and process   |
| `platforms.telegram.extra.allow_from`                       | The allowed people's numeric ids                                       |
| `dm_policy: allowlist`, `unauthorized_dm_behavior`          | Strangers get no reply and no pairing code                             |
| `allowed_chats: ["0"]`, `guest_mode: false`                 | No group chat reaches the agent (`allow_from` alone admits groups)     |
| `allow_admin_from: ["0"]`, `user_allowed_commands`          | Slash commands are admin-only and nobody is admin: only /help, /whoami |
| `home_channel` chat `0`                                     | No "/sethome" prompt to each person; Hermes delivers nothing there     |
| `stt.provider: agentpier-deepgram`                          | Voice notes go to AgentPier's Deepgram plugin with the speech settings |
| `stt.enabled: false`                                        | Without a Deepgram key: no local or other cloud transcription          |
| `agent.disabled_toolsets` + `session_search`, `connections` | No recall of the owner's conversations or connector accounts           |

The Deepgram plugin registers a transcription provider (`agent/transcription_provider.py`)
and calls `/v1/listen` as AgentPier's channel layer does: the speech settings' model and
language (`auto` detects it), `smart_format`, "AgentPier" and the agent's name as key
terms, `Token <key>`. The key is `AUXILIARY_AGENTPIER_DEEPGRAM_API_KEY`, which Hermes
strips from child processes. Replies, voice and files go out as Hermes sends them
(`MEDIA:` tags become native attachments). The channels sub-port reports the bot from the
gateway's `gateway_state.json` (`platforms.telegram.state`). Other people's
conversations stay in Hermes's sessions and belong to no AgentPier chat, as on
OpenClaw. A person's very first message in a home that has no session yet gets Hermes's
one-time introduction note. Files reach the paired chat
when an agent shares them with `agentpier_share_file`; the Hermes team plugin does not
carry that tool yet, so Hermes agents name a file's path in their reply.

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
| schedule cron / at / every     | five-field expression (pinned in another zone, below), ISO time (`once`), `every <n>m`   |
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
reply, whole; Hermes's `[SILENT]` arrives as `NO_REPLY`. A run's session key is
`agent:<runtimeAgentId>:hermes:cron:<job>:<session id>` (`routines.runOf`); the sessions
sub-port reads its transcript.

**The result in the chat's history.** Hermes runs a routine in a session of its own. A
run whose routine delivers into a chat (routines, check-ins and hook runs that report to
the agent's main chat) is also written into that chat's session history before AgentPier
learns of it, so the agent's later turns there read it, as OpenClaw's do. The gateway has
no method that adds a message to a session without a turn (`session.mutate` has none, a
prompt starts a turn), so the RPC bridge's `agentpier.note { session_id, text }` writes it
the way Hermes records a result no one watched (`gateway/session_completion_notes.py`)
and mirrors a cron delivery into a chat (`cron/scheduler_delivery.py`): one user row
`[Cron delivery: <name>]` with the reply, of the display kind `internal_notification`,
appended through Hermes's own `SessionDB` to the session's current compression segment.
Hermes sends the row to the model and never the kind; AgentPier's chat view leaves it
out (`entry.internal`), because AgentPier already shows the result beside the chat
(`deliveryStatus: "not-delivered"`: the note is no reply of the agent). A note is written
once per run; one that failed is tried again while its run is the job's last. A note
that arrives while a turn of that chat runs lands before that turn's reply.

**Time zones.** Hermes matches every cron expression in the time zone of the agent's
processes (`cron/jobs.py compute_next_run`, `hermes_time`: `HERMES_TIMEZONE` or
`timezone` in `config.yaml`, else the process's zone, which is AgentPier's own TZ,
passed on by `hermes-environment.js`); v0.22.5 has no zone per job. A cron routine
without a zone, or in that zone, runs as written. A routine in another zone runs as a
pinned job (`hermes-cron-zone.js`): AgentPier computes its next occurrence in its own
zone and writes the expression `<minute> <hour> <day> <month> *` of that instant in the
process's zone; the routine's own expression and zone stay in the job's `agentpier`
field and are what AgentPier reads back. Each delivery check, and each change or
resume of the routine, pins the job to the occurrence after it once its pin passed
(it ran, or it was due while the gateway was down), so `next_run_at` is always the
routine's next run in its own zone. Occurrences follow OpenClaw's policy
([routine qualification](assistant-routine-qualification.md)): a time the spring
transition skips does not run that day, a time the autumn transition repeats runs at
its first occurrence. A pinned expression is refused when it is not a standard
five-field expression (numbers, names, `*`, ranges, steps, lists).

**Dangerous commands in routine runs.** With **Full access** (`approvals.mode: off`)
Hermes runs every command of a routine run, as OpenClaw does. With **Dangerous
commands** or **Every command**, OpenClaw asks the owner in the chat the routine
reports to and the run waits. Hermes cannot: in a cron run it clears every approval
surface (`tools/approval.py _presence`, `HERMES_CRON_SESSION`) and decides by
`approvals.cron_mode`, which knows only `deny` and `approve`. AgentPier keeps
Hermes's default `deny`, so the owner's choice to be asked is never answered by
running the command unasked: a command Hermes flags as dangerous, and with
every-command approval every shell command and Python run, is refused in a routine
run, and the run reports Hermes's refusal (`BLOCKED: …`) to the agent, which goes on
without it. Commands Hermes does not flag run on **Dangerous commands**.

The agent's own routine tool needs AgentPier's team tools, which come to Hermes with
teams.

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
| Routine results   | `agentpier.note` (the bridge): a note row in the target chat's history                    |
| Context size      | `session.stats { session_id }`: `last_prompt_tokens`, `context_length`                    |
| Questions         | `clarify.request` → `clarify.respond`; `clarify.settled`, `approval.cancelled`            |
| Sudo, secrets     | the `sudo` and `secret` requests, declined at once with `{ value: "" }`                   |

A chat's history names how full its context was for the long-chat hint as OpenClaw's
does (`sessionInfo.totalTokens`, `totalTokensFresh`, `contextTokens`): the
`last_prompt_tokens` and `context_length` of the agent the gateway keeps for the
session (`gateway/session_usage.py`), read while the session is attached to
AgentPier's connection. After a restart of the gateway or a compression the gateway
lets that agent go and the size is unknown until the chat's next turn, as OpenClaw's
is after a compaction (no hint meanwhile).

When a Hermes agent calls its `clarify` tool, Hermes asks every connection attached to
the session (`clarify.request`, one per question, with its choices; Hermes marks the
first as recommended). The adapter (`hermes-questions.js`) publishes it as the run
event `question.requested` and the run reports the phase `waiting-approval`;
`agent-questions.js` shows it in the agent's chat as a card with the choices and a field
for an own answer, and, when the turn came from the owner's paired Telegram chat, as a
notice there, where the next message answers it (a number picks a choice). The answer
goes back with `clarify.respond`. Hermes waits up to `agent.clarify_timeout` (an hour by
default) and then tells the agent nobody answered; an interrupt withdraws the question
(`approval.cancelled`). Questions are not stored: after a restart, the attached session
lists what still waits and it is asked again. Hermes's `sudo` and `secret` requests ask
for a sudo password or a secret's value, which AgentPier never hands out through a prompt
(agents get the secrets the owner granted them): both are declined at once, so the agent
goes on and says what it lacks.

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
through AgentPier's routine routes, `hermes-agent-hooks-contract.test.js` a hook event
through AgentPier's hook routes, and `hermes-routine-parity-contract.test.js` a routine
in another time zone, a result the next turn reads, the long-chat size and a dangerous
command in routine runs on full access and on approval.
`tests/integration/hermes-files-contract.test.js` checks the agent's files: a memory
entry written through the port reaches the agent's prompt, and an entry the agent adds
with Hermes's `memory` tool comes back through it; an assigned bundled skill and a
catalog skill reach the agent's skill index while an unassigned one stays out, and a
skill the agent writes is reported as its own; a bound stdio MCP server's tool is
offered and called, and its secret never reaches the agent's shell.
`hermes-update-contract.test.js` installs the
previous release (`tests/fixtures/hermes-previous-manifest.json`, made with
`scripts/refresh-hermes-runtime-lock.mjs`) and the pinned one into a disposable data
directory and updates an agent between them through AgentPier's Hermes update path: a
failed validation restores the snapshot and the previous release, the next activation
commits and the agent's chat is kept; a running turn blocks it until **Pause agents and
update** stops it. The teams contract drives a Hermes lead's team tools (proposal, a
member provisioned as a Hermes agent, a delegated task) and the guard's refusal of a
read-only task's write; the browser contract opens a local page in the agent's
AgentPier-owned Chromium with the installed browser app (skipped, with the reason,
without one) and reads the live view's frames. Set `AGENTPIER_HERMES_CONTRACT_RUNTIME`
to an installation made by `scripts/provision-hermes-contracts.mjs` (its `venv/bin/`
holds `python` and `hermes`, its `tools/` agent-browser). The tests use a private
`HOME` and `HERMES_HOME` and never touch
`~/.hermes`.
