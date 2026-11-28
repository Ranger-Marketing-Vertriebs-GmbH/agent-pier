# Hermes runtime

AgentPier can run an agent on [Hermes Agent](https://github.com/NousResearch/hermes-agent)
beside OpenClaw ([ADR 0006](adr/0006-assistant-runtime-port.md)). Each Hermes agent runs
in its own supervised process set, its messaging gateway and AgentPier's RPC bridge,
with its own `HERMES_HOME` inside AgentPier's private runtime folder
([processes](assistant-runtime-updates.md#hermes-agent-runtime)). This guide describes
what AgentPier writes into that home, which defaults it sets and how it talks to the
gateway. AgentPier pins the Hermes release `v0.23.3` (commit `caafe538`, pinned
release since 2026-11-22); key names, file references, the gateway protocol and the
approval and event shapes below were verified against it. AgentPier supports only the
release it pins; an update can roll back to the previous pin (`v0.22.5`) only
([updates](assistant-runtime-updates.md#hermes-agent-runtime)). The
[spike](research/hermes-runtime-spike.md), on the earlier `main` commit `a4994d4e`,
records the hands-on evidence.

## Hermes configuration

The Hermes compiler (`server/features/assistants/runtimes/hermes/hermes-compiler.js`)
turns one agent's runtime-neutral desired state into these files of its home, and
nothing else:

| File                          | Content                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `config.yaml`                 | Model, toolsets, approvals, memory, skills, MCP, plugins, the agent's bot and the defaults                               |
| `.env`                        | The model connection's key, the MCP servers' secrets, the agent's bot token and the Deepgram key, the PDF fallback's key |
| `SOUL.md`                     | The agent's instructions                                                                                                 |
| `plugins/agentpier-guard/`    | `plugin.yaml` and `__init__.py`, only for every-command approval                                                         |
| `plugins/agentpier-team/`     | AgentPier's team tools, tool guard ([teams](#teams)) and pdf tool ([PDFs](#pdfs))                                        |
| `plugins/agentpier-deepgram/` | `plugin.yaml` and `__init__.py`, only for a bot for other people with voice                                              |
| `plugins/agentpier-web/`      | `plugin.yaml`, `__init__.py`, `web.json`: web fetch and Perplexity search ([web](#web-search))                           |

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
always sets `manual` or `off`. It is not offered as OpenClaw's **Automatic review**
level: `smart` is not qualified here (which model reviews through AgentPier's proxy,
what it sees and how it fails), and it covers only the commands Hermes flags, so
Hermes's `approvals.shellLevels` has no `review`, the agent's settings say that
automatic review is not available, and the server refuses the level
([shell qualification (i)](assistant-shell-qualification.md#i-exec-mode-auto-the-model-review)). The guard plugin's `pre_tool_call` hook returns
`{"action": "approve"}` for every `terminal` command, `execute_code` and `browser_exec`
run and input sent to a running process. Its message carries the command itself, and its rule key hashes
the exact text, so "always" allows that one command again and never every command.
Every-command approval is a Hermes-only option: the agent's settings offer **Every
command** beside **Dangerous commands** (`approval`) where the runtime's trait
`approvals.shellLevels` has `every` ([ADR 0007](adr/0007-runtime-descriptor.md)), and
store it as `shell: "approval"` with `shellEveryCommand: true`. The desired state
keeps AgentPier's three levels; the runtime passes the choice to the compiler
(`strict`). OpenClaw's levels have no `every`, because its "approval" already asks
before every command. A dangerous
command under every-command approval asks once: Hermes asks a plugin's question
first and then runs its own dangerous-command check, so the guard leaves the shell
commands Hermes flags as dangerous (`tools/approval_detection.py`) to that check,
which asks with Hermes's reason. A plugin's question names the call only as
`<terminal> (plugin approval rule)`; AgentPier shows the guard's message, the command
itself, in the approval card.

**The browser asks too.** Hermes's `browser_exec` ([browser](#browser)) runs the agent's
Python on the host and passes none of Hermes's approval checks, so with the browser on
an asking level the guard plugin asks before it as Hermes asks before an `execute_code`
run (`browserAsks` in its `guard.json`): on **Dangerous commands** the card offers
**Allow for this chat** beside **Allow once**. Hermes offers only once or deny for a
plugin's question, so AgentPier answers it once and every later `browser_exec` card of
the same agent's same session itself (`allow-chat`, `exec-approvals.js`, recorded as
answered by the chat's grant). The grant lives in AgentPier's memory: it never reaches
another chat, a routine or a hook run, ends when the chat is reset or replaced (a new
session) and after an AgentPier restart, and a shortened script is never covered. On
**Every command** each run asks, with its own key; in a routine run the guard asks
through the team bridge like any Python run ([routines](#routines)). Full access asks
nobody, and without a shell Hermes offers no `browser_exec` at all.

**Always allow.** AgentPier never offers Hermes's own "always" answer: it would allow a
whole pattern class (every "recursive delete") for good in `command_allowlist`, which
AgentPier compiles. **Always allow** on a Hermes agent answers once and AgentPier
remembers the exact command (`exec-remembered.js`, by the SHA-256 of its full text); the
identical command is then answered without a card, any other one still asks. A card
that shows a shortened command (the guard shortens its message after 4000 characters
and ends it with ` … [shortened]`; a card carries at most 32768) offers no **Always
allow** (`partial`, `hermes-approval-queue.js`): the text it would remember is not
the whole command. **Always allowed commands** (**Capabilities** → **Shell access**) lists these commands with the
folder they were approved in and when they were added, and deletes them, as it does
OpenClaw's allowlist. A Hermes agent's list is AgentPier's own (`exactOnly` in
`GET /api/assistants/:id/shell-allowlist`), so it is read and deleted while Hermes and
OpenClaw are stopped (a deletion still waits out the agent service's recovery and
maintenance, like every other agent change); the page says that only the identical
command runs without asking. The live topic `agent.allowlist:<id>` pushes each change,
and a deletion writes the same `assistant.revoked` audit event (`kind: "allowlist"`) as
one of OpenClaw's entries.

### Model connection

| Connection                           | `model` section                                                                                                                                                                        | `.env`                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Custom OpenAI-compatible endpoint    | `provider: custom`, `base_url`, `default`, `key_env`, `context_length`                                                                                                                 | `AUXILIARY_AGENTPIER_API_KEY` |
| Keyed endpoint that offers Responses | `provider: custom:agentpier-model`, `default`, `context_length`; `providers.agentpier-model` with `base_url`, `api_mode: codex_responses`, `key_env`, `extra_headers` for a key header | `AUXILIARY_AGENTPIER_API_KEY` |
| Endpoint with an `api-key` header    | the same, plus `extra_headers` referencing the key                                                                                                                                     | `AUXILIARY_AGENTPIER_API_KEY` |
| Local server without a key           | `provider: custom` without `key_env`                                                                                                                                                   | none                          |
| OpenRouter                           | `provider: openrouter`, `default`                                                                                                                                                      | `OPENROUTER_API_KEY`          |
| ChatGPT login AgentPier holds        | `provider: openai-codex`, `default`; pool row in `auth.json`                                                                                                                           | `HERMES_CODEX_BASE_URL`       |
| ChatGPT login OpenClaw holds         | refused until moved to AgentPier                                                                                                                                                       | none                          |

A connection that sends a key and offers Responses (the Azure OpenAI preset ticks it)
runs the agent's own model on Responses, the rule OpenClaw agents follow
([model connections](assistant-model-connections.md)): Azure reasoning deployments
refuse function tools on Chat Completions unless `reasoning_effort` is `none`, and
Hermes drops the field after the first refusal, which does not help (AGENTPIER-439).
Hermes keeps `api_mode: codex_responses` for a host other than OpenAI's only on a
named provider (`hermes_cli/runtime_provider.py` `_resolve_plain_custom_api_mode`), so
the model section names `custom:agentpier-model` and that entry holds the URL, mode, key
name and key header; Hermes's Responses transport knows Azure hosts
(`agent/transports/codex.py`). While the agent has advisors, the same entry is the
aggregator's on Chat Completions ([Mixture of Agents](#mixture-of-agents)).

Every other endpoint kind AgentPier offers agents (OpenAI, Azure OpenAI, Anthropic's
and other vendors' OpenAI-compatible APIs, Ollama, llama.cpp, LM Studio) offers Chat
Completions and compiles to `provider: custom` with `api_mode: chat_completions`, so
Hermes never switches an `api.openai.com` or `/anthropic` URL to another wire protocol
(`agent/agent_init.py`). The endpoint's Chat Completions options need no key: Hermes
sends no output cap on an agent's turn and picks `max_completion_tokens` itself where
it sends one (`maxTokensField`), and it repeats a stream without `stream_options` once
an endpoint refuses them (`streamUsage`).

A ChatGPT login AgentPier holds ([model connections](assistant-model-connections.md#chatgpt-logins-held-by-agentpier))
runs on Hermes's own `openai-codex` provider, which keeps the Codex request shaping on
whatever its URL (`agent/codex_responses_adapter.py` `is_codex_backend`; a plain
`provider: custom` drops `api_mode: codex_responses` for a host other than OpenAI's,
`hermes_cli/runtime_provider.py`). `HERMES_CODEX_BASE_URL` in `.env` points it at
AgentPier's model proxy (`<proxy>/chatgpt/codex`); it wins over every credential's own
URL, also when Hermes rotates credentials (`credential_pool.py` `runtime_base_url`).
The credential is the proxy's, for this agent and this login only, as an `api_key` row
(`source: manual:agentpier`) of Hermes's credential pool in `auth.json`; the writer
replaces only that row and keeps Hermes's own rows and status fields. Hermes refreshes
only `oauth` rows with a refresh token, so it never redeems anything, and the proxy adds
the account's token, `ChatGPT-Account-Id` and residency header that Hermes leaves out
for a non-JWT credential (`agent/codex_headers.py`). The home never holds an OpenAI
token, and Hermes needs no running OpenClaw: without the Gateway, AgentPier reads
the login's model list from the Codex backend itself. The credential works only while
this agent's current model is that login. A login OpenClaw still holds is listed
unavailable and refused (`runtimeAccount`, `modelAccountRuntime`) until the owner moves
it to AgentPier. The models sub-port (`hermes-models.js`) answers Hermes's model
inventory of the home (`model.options`) and no accounts; sign-ins stay host-wide in
AgentPier. A model switch is a `config.apply` that restarts
the agent's process set; AgentPier has no per-chat model. The key never appears in `config.yaml`. Hermes
strips `AUXILIARY_*_API_KEY` and `OPENROUTER_API_KEY` from every command and process it
starts, so the agent's own commands do not see the key. A model AgentPier knows accepts
images (an endpoint model that declares it, an OpenRouter model whose catalog lists image
input, a ChatGPT login) sets `agent.image_input_mode: native` and
`model.supports_vision: true`: Hermes hands a tool's images (a PDF's pages,
[PDFs](#pdfs); a project image) and a turn's attached images
([attached images](#attached-images)) only to a model it knows sees them, and its own
lookup does not know a custom endpoint's models and may miss an OpenRouter model
(`agent/image_routing.py`). Any other model gets no mode: Hermes's own lookup decides.

### Chats follow the agent's settings

Hermes freezes a session's policy when it creates it (`gateway/session_policy.py`
`build_policy`): the model route, its providers and their keys. Resuming a session
refreshes its toolsets, MCP servers, terminal and reasoning default, never its route
(`gateway/session_policy_refresh.py`), and a key that changed in `config.yaml` since
the session started ends every turn with `launch_credentials_unavailable … changed in
config.yaml since this session started`
(`gateway/session_policy_credentials.py` `recover_config_secrets`). So a model or
connection switch broke the existing chats, the main chat included, and a new or
removed advisor never reached them (AGENTPIER-438).

AgentPier creates every chat with `follow_profile_config: true`, the flag of Hermes's
own Bot Chat. Such a session re-reads `model`, `providers`, `custom_providers`,
`fallback_providers`, `fallback_model`, `model_aliases` and `platform_toolsets`
from the home's `config.yaml` at every turn, keys included, and never checks the keys
it froze for those sections (`FOLLOW_SECTIONS`, `LocalSessionPolicy.effective`). A
model, connection, advisor or key change therefore reaches every chat at its next
turn, with no **Restart main chat**.

A chat an older AgentPier created stays frozen, and Hermes has no edit that makes it
follow (it adopts only a chat titled "Bot Chat"). Before such a chat's next turn
AgentPier moves it to a new following session, its successor
(`hermes-session-successors.js`): `session.create` with `follow_profile_config`,
request id `agentpier-successor-<old session>` and the title `<title> (<last 8
characters of the old session id>)`. The successor starts with an internal note
(`agentpier.note`) that carries the conversation so far: the owner's and the agent's
text, newest kept, at most 24,000 characters. The chat keeps its key, so routines,
Telegram and the chat list need nothing new. Its history is the old session's rows
followed by the successor's, deleting or archiving the chat does the same to both,
and a routine's note goes to the successor. The chain is kept in
`agentpier-session-successors.json` in the agent's HERMES_HOME. A chat moves once; the
agent sees the earlier conversation only through the note, not as its own turns.
`hermes-session-policy-contract.test.js` switches the connection of an existing
chat, adds an advisor to one and moves a frozen one, on the pinned Hermes.

### Mixture of Agents

An agent's **Mixture of Agents** ([agents](agents.md#capabilities)) is stored as its
Hermes options, `runtimeOptions.hermes.mixture.advisors` (one to three `{
connectionId, modelId }`, [ADR 0007](adr/0007-runtime-descriptor.md#9-per-agent-runtime-options)).
`hermes-config/mixture.js` compiles it, verified against Hermes v0.23.3:

| Key                                     | Value                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.provider`, `model.default`       | `moa`, `agentpier` (every other key of the agent's model section stays)                                                                                                                         |
| `providers.agentpier-model`             | the agent's own model: `base_url`, `api_mode: chat_completions`, `key_env` as its model's                                                                                                       |
| `providers.agentpier-advisor-<n>`       | advisor `n`: `base_url`, `api_mode: chat_completions`, `key_env: AUXILIARY_AGENTPIER_ADVISOR_<N>_API_KEY`                                                                                       |
| `moa.presets.agentpier`                 | `reference_models` (`custom:agentpier-advisor-<n>`), `aggregator` (`custom:agentpier-model`), `fanout: user_turn`, `degraded_reference_policy: loud`, `reference_timeout: 120`, `enabled: true` |
| `moa.default_preset`, `moa.save_traces` | `agentpier`, `false` (`moa.active_preset` empty)                                                                                                                                                |

`n` is the advisor's position in the stored list, so an advisor left out keeps the
others' numbers. Each key goes into the home's `.env` like the agent's own key; Hermes
strips every `AUXILIARY_*_API_KEY` from the agent's commands, and backups seal `.env`
([backups](backups.md#hermes-agents)). Every slot is a named provider
(`hermes_cli/runtime_provider_custom.py` `_match_new_style_provider`): `provider:
openrouter` would read the agent's own `OPENROUTER_API_KEY` or Hermes's credential pool,
and a bare `custom` slot beside `model.provider: moa` resolves to the first entry of
`providers:`, so an OpenRouter advisor gets a named entry at OpenRouter's URL and the
aggregator one of its own. A slot's call carries only the entry's URL, key and API mode
(`agent/moa_loop.py` `_slot_runtime`), no headers, while `model.extra_headers` would go
with every auxiliary call: neither the agent's model nor an advisor may take its key in
a header of its own (`keyHeader` in the model list).

**No silent fallback.** Hermes repairs a preset when it reads it: a slot without
provider or model is dropped and an empty list is filled with Hermes's built-in
`openai-codex` and OpenRouter models (`hermes_cli/moa_config.py` `_normalize_preset`),
and a provider it cannot resolve is called bare. The owner's conversation must never
reach a provider the owner did not choose, so `checkedPreset` refuses any slot but
AgentPier's named providers with a model. An advisor whose connection cannot be one
(deleted, without its key, a ChatGPT login) is left out and the settings say so.

The `moa` section is never left out. Hermes reads the preset from `config.yaml` at every
Mixture of Agents call, also for a chat that still runs `model.provider: moa` from
before (`agent/moa_loop.py` `_resolve_preset_cached`, `build_moa_facade`). Without a
section the built-in defaults apply (`hermes_cli/config_defaults.py`: preset `default`
with openai-codex `gpt-5.5`, OpenRouter `deepseek/deepseek-v4-pro` and an OpenRouter
`anthropic/claude-opus-4.8` aggregator), and a preset name Hermes does not find falls
back to that default (AGENTPIER-437). So an agent without advisors, with none left, or
whose own model Hermes cannot reach as a named provider (a ChatGPT login, a key header)
gets the **closed preset**:

| Key                          | Value                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `providers.agentpier-closed` | `base_url: http://127.0.0.1:9/v1` (the discard port), `api_mode: chat_completions`, no key    |
| `moa.presets.agentpier`      | `enabled: false`, one advisor slot and the aggregator, both `custom:agentpier-closed`, `none` |
| `moa.default_preset`         | `agentpier`; the explicit `presets` map replaces Hermes's own (`apply_user_moa_presets`)      |

A disabled preset calls its aggregator alone, so a chat still on `provider: moa` fails
its turn at the closed address instead of reaching any model; AgentPier's chats follow
the agent's model at their next turn anyway ([chats follow the agent's settings](#chats-follow-the-agents-settings)).
Removing the advisors removes AgentPier's advisor entries and their keys and writes the
closed preset. `hermes-mixture-contract.test.js` reads the compiled home with Hermes's
own loader and normaliser, and runs a turn of a chat frozen on `provider: moa` after
its advisors were removed: no advisor runs and no slot of Hermes's own preset is
resolved.

What the advisors see (`agent/moa_loop.py` `_reference_messages`): a fixed advisor
prompt and the chat's user and assistant text, tool calls inline as text and tool
results as previews of up to 4,000 characters, images as a placeholder; no Hermes
system prompt, no tool schemas. With `fanout: user_turn` they run once per user turn;
the aggregator, the agent's own model, runs every tool iteration and pays for almost all
of the run. Auxiliary tasks (titles, compression) run on the aggregator.

- **Failures:** an advisor that fails becomes a `[failed: …]` note, and with `loud`
  the aggregator is told; the turn goes on. Each advisor has 120 seconds
  (`reference_timeout`; Hermes's own default is 900 s). But Hermes's auxiliary client
  answers most failures of an explicitly chosen provider with the main agent's model,
  under MoA the aggregator, the agent's own model (`agent/auxiliary_client.py`
  `_ladder_provider_fallback` → `_try_main_agent_model_fallback`): a timeout, a 429
  after its retries, a 402 or used-up quota, a model the provider cannot serve, an
  invalid or status-less answer, a connection error. That answer arrives under the
  advisor's name, and `moa.reference` carries nothing that tells AgentPier who
  answered, so every advisor step says so in a fixed line and the settings say so
  too. Only an authentication error (401) and an error Hermes counts as none of these (such as a 400) are not retried and show as failed. The 120 seconds bound a timeout
  and its retry together to a few minutes instead of half an hour.
- **Steps in the chat:** Hermes sends each advisor's answer as `moa.reference`
  (`tui_gateway/tool_progress.py`, with `display.show_reasoning` at its default). The
  events adapter (`hermes-run-state.js`) makes it an `advisor` step (its number from
  the provider name, its round in the run, so a steered or queued message's advisors
  get steps of their own, its model and its text). A failed one keeps no text: Hermes's
  note can hold provider URLs, error bodies and key fragments, so the step names only
  an HTTP status or a kind (timeout, connection, interrupted, error). The run's
  live steps (`run-steps.js`) keep it with its answer, capped at 8,000 characters, and
  the chat shows it expandable. Like tool steps they live while the turn runs (a
  reload during the turn shows them again) and are not stored: Hermes keeps no advisor
  output in its transcript, and traces stay off (`save_traces: false`).
- **Routines and subagents:** gateway sessions and cron runs use `model.*`, so the
  agent's routines run with the advisors; `delegate_task` subagents appear to take the
  parent's provider (inferred, not tested).
- **Apply:** a save is a `config.apply`; the changed `config.yaml` restarts the agent's
  process set, as a model change does. A live apply resolves the advisors' connections
  like the agent's own model (`option-connections.js`), and a change of a connection an
  agent uses as an advisor counts as a change of a connection the agent uses. A real
  turn leaves the `moa` and `providers` sections as AgentPier wrote them
  (`hermes-mixture-contract.test.js`), so the next apply changes nothing.
- **Downgrade:** an AgentPier from before the closed preset removes `moa` at its next
  apply and leaves `providers.agentpier-closed`, which nothing uses then. An AgentPier from before Mixture of Agents neither writes nor removes
  `moa`, `providers.agentpier-*` or the `AUXILIARY_AGENTPIER_ADVISOR_*` keys, so they stay in the agent's home: the older compile writes the agent's own model again, but a gateway `/moa` turn still runs the preset with the advisors' keys.
  Remove the agent's advisors and let the agent apply before you downgrade. Otherwise
  remove `moa`, the `providers.agentpier-*` entries and the advisor keys from that
  agent's `config.yaml` and `.env` by hand.

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
| `file_tools.hosted_ocr`                            | `false` | PDFs never go to Firecrawl's hosted OCR                   |
| `telemetry.shared_metrics.enabled`, `.send`        | `false` | No shared metrics                                         |
| `agent.clarify_timeout`                            | `3600`  | A question waits an hour (Hermes's own default: 90 s)     |

Invisible subagents (`delegate_task`) stay on. In a session of the messaging gateway,
their dangerous commands reach the owner through the session's approval queue.
`terminal.backend` is `local` and `terminal.cwd` is the agent's folder.

### Toolsets

`agent.disabled_toolsets` follows the agent's settings: `memory` (and
`memory.memory_enabled`) with memory, `file` with memory, shell access or PDF reading,
`web` with web search or fetch ([web search](#web-search)), `vision` with documents and
`browser` with the browser ([browser](#browser)); `image_gen` with image creation through
a ChatGPT login AgentPier holds ([images](#images)), never on a FAL or Nous key AgentPier
does not hold (`tools/image_generation_tool.py`). `computer_use` stays off until AgentPier serves it on Hermes; `cronjob`, the
agent's own Hermes jobs, stays off because AgentPier sets up routines on the same
scheduler ([Routines](#routines)).

An agent of restricted users also loses `delegation`, `session_search` and
`connections`, Hermes's counterparts of the subagent and session tools OpenClaw locks
for it (`native-capabilities.js` `lockedTools`); its shell is off through its shell
level. A tool of a disabled toolset is neither offered nor run: Hermes answers a
model that names one anyway with `Tool '<name>' does not exist`
(`hermes-user-agent-lock-contract.test.js`). PDFs: **Read PDFs** gives the agent
AgentPier's `pdf` tool, which reads scanned pages too ([PDFs](#pdfs)), and keeps the
file tools on, whose `read_file` extracts a PDF's text layer itself
(`tools/file_tools.py`).

### Work folder

A Hermes agent AgentPier made (`ap-<id>`) works in AgentPier's own agent workspace
`<data>/assistants/workspaces/<id>`, the folder an OpenClaw agent works in
(`hermes-paths.js` `hermesWorkspace`): `terminal.cwd`, its secrets file
(`.agentpier/secrets.env`), files it shares, browser upload staging and SFTP transfers
all use that one folder. Its [chat files](#chat-files) lie outside it, in a folder per
chat. Its shell PATH starts with
its GitHub folder and its SSH agent's `bin/`, as on OpenClaw; Hermes's commands inherit
the gateway's PATH (`tools/environments/local.py`), so a change restarts the agent's
set.

### Attached images

Images the owner attaches in the chat or sends as Telegram photos reach a Hermes agent's
model inline, as an OpenClaw agent's, while its home takes images natively
(`image_input_mode: native` above, home.js `nativeImages`). AgentPier picks them as for
OpenClaw (`agent-attachments.js` `delivery`: PNG, JPEG, GIF and WebP, at most 6 MiB
each and 15 MiB per message, never HEIC), and the turn's text still names each saved
copy in the chat's file folder ([chat files](#chat-files)) for the agent's tools. Another home gets the text only: in
Hermes's other mode the gateway would describe each image with an extra vision call
before the turn and put those notes before the owner's words
(`gateway/run_inbound.py` `_enrich_message_with_vision`), which OpenClaw never does.

The sessions sub-port (`hermes-inline-images.js`) stages each image with the gateway's
`image.attach_bytes` (`gateway/session_images.py`, into the home's `cache/images/`)
within one call's time in all, so the send holds AgentPier's admission no longer than
a turn without images, and only then submits: a staging failure (no answer, or a
refusal other than one image's `invalid_params`) submits nothing and fails the turn at
once. `prompt.submit` names the images as `attachments: [{ path, mime }]`; the gateway
commits their bytes with the admission (`gateway/session_ingress_media.py`
`admit_attachments`, into `cache/documents/native-inputs/`, at most 10), so a retried
submission runs the same images. The model gets them as image parts after the text and
a line `[Image attached at: <path>]` per image (`agent/image_routing.py`
`build_native_content_parts`); an image Hermes refuses is left out, and the text still
names its file.

Hermes stores those lines with the owner's row, and in the row's text a `[screenshot]`
placeholder per image. The history read drops exactly these again (`sentText`): only
lines naming files of the agent's own `HERMES_HOME/cache/`, after a blank line, with no
placeholder or one per image; and the notes of the description mode, which end in
such a path. The chat then shows the owner's words with the files, and replies stay
attributed to their runs. The owner's own words never match, as they name no file of
that folder.

On an agent shared with users each chat is private to its person, but these caches
hold every chat's images. Its file and vision tools therefore read only its work folder
and the calling chat's file folder ([chat files](#chat-files)). A user's own agent
(one user, not shared) uses only its work folder and its own chat folders, all of
which are hers. On every agent of restricted users the team plugin asks the bridge
before every `read_file`, `search_files`, `vision_analyze`, `write_file` and `patch`
(`privateFolders` in `tools.json`; `patch` shows the lines of a file it cannot match,
so it is a read too), and `hermes-home-guard.js` (`userReadRefusal`) refuses any path
outside those folders, a path that is no text, and any search whose folder lies
outside them (so neither its `HERMES_HOME`, its `HOME`, another chat's folder on a
shared agent nor another agent's workspace, chat files or Hermes home). Hermes itself
refuses such an agent's writes outside its work folder and its folder of chat folders
as well: its `.env` sets `HERMES_WRITE_SAFE_ROOT` to both (`hermes-config/tools.js`
`writeRoots`; `agent/file_safety.py`, which `write_file`, `patch` and a
`text_to_speech` `output_path` check). Every Hermes agent's search path with a
comma or whitespace asks: Hermes searches a path that does not exist as several, split at
commas or else at whitespace as Python's `str.split()` sees it, `\x1c`–`\x1f` and
`\x85` included (`tools/file_operations_search.py` `_try_multi_path_search`), so
the guard refuses such a search path on every Hermes agent ("Search one folder at a
time …"). While an `attachments/` from before the move is still in the work folder
(a copy whose chat folder was unsafe, or a video still arriving), a search whose
folder holds it is refused on a shared agent. The guard
resolves a path as Hermes does (a literal `file://` prefix dropped, `~` the agent's
`HOME`, a relative path from the work folder) and compares it as the file system does:
the nearest existing folder as the system spells it (`realpath.native`, links
followed), then case-folded, as the attachments rule does, since macOS's file system
ignores case; a path must lie inside an allowed folder both as written and as
resolved. It refuses `~name` and fails closed when the agent's folders are unknown or
the bridge does not answer, so such an agent cannot read files in its `HOME` either
(`~/.gitconfig`), nor anything in `/tmp`. Its `pdf` tool and `image_generate`
references take files of the same folders. An OpenClaw agent reads only its
workspace (`tools.fs.workspaceOnly`). The owner's own agents (no users) serve only the
owner's chats, which may read each other's attachments on OpenClaw too, so their reads
stay Hermes's own, except that any file call into the chat folders stays in its own
agent's. An older AgentPier did not limit a user's own Hermes agent this way: it
could read other agents' folders by absolute path. Not covered: Hermes's `video_analyze` (the `video` toolset, which AgentPier
never turns on) would need the same guard.

### Chat files

A Hermes agent keeps each chat's uploads (`agent-attachments.js`, `chat-file-folders.js`)
in a folder of that chat alone, `<data>/assistants/chat-files/<agent id>/<chat id>/`
(0700, each file 0600 under a stamped name, written and read as every upload is),
outside its work folder: a `search_files` of the work folder, including Hermes's
zero-match probe over hidden files (`_zero_match_probe`, `--hidden --no-ignore`), finds
no chat's files. The note a turn carries names the folder and each file by absolute
path ("saved in this chat's file folder …"); the chat strips that note and the older
one naming `attachments/`. On an agent shared with users a turn reads and writes only
its own chat's folder; images the agent creates are kept in the folder of the chat
they are shared into and count against the quota ([images](#images)); on any Hermes agent a file call into the chat folders stays in
the agent's own (`chat-files` in the plugin's first look, `hermes-home-guard.js`
`chatFolderRefusal`). `agentpier_share_file` and `agentpier_workspace`
`browser_upload_stage` take a file of the calling chat's folder by its absolute path.
An OpenClaw agent keeps its uploads in its workspace's `attachments/` (its file tools
read only the workspace, and none lists or searches it).

Uploads an older AgentPier left in the work folder's `attachments/` move before each
start of the agent's process set (`chat-file-migration.js`, under the agent's upload
queue): each row's copy into its chat's folder by rename, then the row is marked; a
start after a crash between the two finds the copy there (same size and SHA-256) and
only marks the row; a copy in neither place goes as the quota check lets it go.
Files no row names go to `chat-files/<agent>/.unclaimed/`, which no chat reads but the
quota counts and **Clear** removes; then `attachments/` goes. The quota (1 GB, 1000
files per agent) counts every chat folder. **Clear** removes the agent's chat folders,
removing a chat removes its folder, a shared agent that becomes one user's own loses
the folders of the other chats and `.unclaimed`, and deleting the agent removes `chat-files/<agent>/`.
Older AgentPier versions find nothing in `attachments/` after the move and mark sent
files unavailable; the copies stay in `chat-files/`, and the next start after an
upgrade makes each one whose bytes are unchanged available again. An older AgentPier
does not guard `chat-files/` either: on an agent shared with users a chat could read
other chats' uploads there by absolute path, so do not downgrade while Hermes agents
are shared with users (or **Clear attachments** on them first). A quota check after
a move stopped between a rename and the row's mark finds the copy in its chat's
folder, and the next start marks the row; discarding such an unsent file before
then removes that copy too.

Images an older AgentPier created for a Hermes agent lie in `generated-images/` of its
work folder, which every chat of an agent shared with users could read. On such an
agent they leave it at each start too, after the move of `attachments/` and also when
that failed (`hermes-image-migration.js`). Only files named as Hermes names a created
image (`<prefix>_<YYYYMMDD>_<HHMMSS>_<8 hex>.<ext>`) move, so other files in a folder
of that name stay where they are. An image whose bytes (size and SHA-256) a live file
the agent shared into an existing chat holds goes into the folder of the chat it was
first shared into as `generated-<name>`, kept like a newly created image
([images](#images)); its mtime stays, so one whose shared copy is past 90 days goes at
the next quota check. Any other goes to `.unclaimed`, a link moved itself, never
followed. Each move is one rename, so a start after a crash finishes the rest; an
image that cannot move stays with a warning in the log, the others still move, and
while one is left the guard refuses every read and search of the agent's that covers
or enters `generated-images/` (the plugin's first look asks for that name). A
`generated-images` link is left alone. The owner's and a user's own agents keep the
folder, as all their chats are one person's, and a user's own agent never becomes
shared.

**Clear** removes only what belongs to the agent: when `chat-files/` itself is no
real directory at its real place (a link, for instance), Clear fails with
`attachmentStorageUnsafe` and leaves it and every agent's chat folders untouched.

A search that covers the work folder's `.agentpier/` (the work folder itself, an
ancestor, or several paths in one) asks the bridge on every Hermes agent, and in a
hook run without the hook's Secrets switch it is refused as a read of the secrets
file would be: Hermes's zero-match probe would otherwise count matches of any pattern
in `secrets.env`.

### Web search

Hermes's `web_search` and `web_extract` (the `web` toolset; `search` holds `web_search`
alone) run on the backends `web.search_backend` and `web.extract_backend` name
(`tools/web_tools.py`). The compiler (`hermes-config/web.js`) maps the owner's web
search setting:

| Provider                      | Hermes backend                                              | `.env`                                   |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| DuckDuckGo                    | `ddgs` (the installation's `ddgs` extra)                    | none                                     |
| Brave                         | `brave-free`                                                | `BRAVE_SEARCH_API_KEY`                   |
| Perplexity through OpenRouter | `agentpier-perplexity` (AgentPier's `agentpier-web` plugin) | `AUXILIARY_AGENTPIER_WEB_SEARCH_API_KEY` |

Hermes's own Perplexity backend calls Perplexity's Search API (`POST /search`), which
OpenRouter does not serve. AgentPier's plugin therefore asks `perplexity/sonar-pro`
through OpenRouter's chat completions, as OpenClaw's Perplexity plugin does, and returns
the answer with its citations. Hermes strips both keys from every command and process it
starts (`tools/environments/local_env_policy.py`). A provider Hermes cannot serve (no
key, or DuckDuckGo on an installation without ddgs) is named as `webSearch` and its tool
is withheld (`search` in `agent.disabled_toolsets`). `web.keyless_fallback` stays off. A
changed setting applies each Hermes agent that searches; its set restarts when its home
changed.

Web fetch is AgentPier's own as well: no Hermes extract backend fetches a page itself
(each one is a third-party service). The plugin's `agentpier-fetch` reads the page
directly (at most 5 redirects, 5 MB, 30 s, HTML as text) through Hermes's connect-time
SSRF guard (`tools/url_safety.py`) with private, loopback, link-local and metadata
addresses always refused, at every connect and redirect, as OpenClaw's `web_fetch` does,
whatever **Allow private networks for all agent browsers** says. An agent with web
search but no web fetch keeps that backend pinned, and it refuses every page
(`web.json`), because Hermes offers `web_extract` together with `web_search`.

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
by default 2,200 characters for `MEMORY.md` and 1,375 for `USER.md`. AgentPier gives
every Hermes agent 10,000 and 5,000 instead, one fixed size, and compiles both
limits (`memory.memory_char_limit`, `memory.user_char_limit`) and refuses an owner's
edit beyond them with `memoryTooLarge` (413), since Hermes would keep loading such a
file but refuse every later write of the agent. Hermes freezes memory into a
session's prompt when the session starts, so an edit reaches the agent's next chat.
Entries the owner archives after a [model switch](agents.md#memory) leave these files
and live in AgentPier's own archive (`assistant_memory_archive`), not beside Hermes's
files, which have the hard limits above and which Hermes reads. **Restore** appends an
entry back as a `§` block and is refused with `memoryTooLarge` (409) when the file
would go over its limit.
Memory search looks for the query's words in the entries of both files; Hermes's own
`session_search` covers past chats, not memory.
That search is AgentPier's own over the two files on the memory page. The agent
itself has no memory search: Hermes puts both files into every chat. The owner's
[semantic memory search](agents.md#semantic-memory-search) therefore does not exist
for Hermes agents (capability `semanticMemory`, `semanticMemoryUnsupported`), and
nothing of it shows for them.

The agent keeps its memory with Hermes's `memory` tool and Hermes's background review
after a turn. Its instructions (`SOUL.md`, **Memory**) tell it so: save to the `memory`
and `user` stores, always when someone asks it to remember something, and keep entries
short; they never name AgentPier's memory files or a read-only memory. Hermes's review
writes without asking (`memory.write_approval` stays off, Hermes's default). AgentPier's
memory step before a chat summary is OpenClaw's: AgentPier's write guard never sees a Hermes
agent's writes, so Hermes agents skip it (`memory-step.js`). Notes below `memory/` and
the OpenClaw Dream Diary stay empty for a Hermes agent.

**Pinned entries.** An entry whose text starts with `📌 ` (`pinMarker`,
`hermes-config/memory.js`) is pinned. The marker is AgentPier's convention inside
Hermes's own format, counts toward the limit, and entries stay separated by `\n§\n`.
The agent's instructions tell it to write the entry with the marker whenever someone it
talks to explicitly asks it to remember something ("remember", "merk dir"), whoever that
is, and to replace a pinned entry in chat, keeping the marker, when told something
newer. The owner pins and unpins any entry on the memory page. Only dreaming is bound
by pins.

**Dreaming.** While [dreaming](agents.md#dreaming) is on, every non-archived Hermes
agent with memory dreams once a night (`hermes-dreams.js`). At the dreaming hour, or up to
6 hours after it when AgentPier or the host was down, AgentPier reads both files through
the files port, copies them to `assistants/memory-backups/<runtimeAgentId>/`
(`MEMORY-*.md`, `USER-*.md`, the last 7 nights), and makes one `llm.oneshot` call on the
agent's own model without tools (`hermes-dream.js`). The input is the chats since the
last applied night (the first night: the last 24 hours), at most 60,000 characters a
night; a long day finishes over the next nights. The prompt asks for each file at or
below 80 % of its limit; that is an instruction only. Hermes caps every model attempt of
that call at 60 seconds, not configurable, so a model too slow for a full answer fails
the night and the diary says so.
The guard (`hermes-dream-guard.js`) applies the answer only when every pinned entry of
the start state is present word for word in the same file and both files are within
their hard limits; otherwise nothing changes and the night is discarded. A leading `📌`
is stripped from new texts, so dreaming never creates a pin. The files are written
through `set` over the hashes read; when the agent changed a file in a chat meanwhile,
the dream reruns once against the new state and is then postponed. A discarded,
postponed or failed night leaves the cursor, so its chats are read again. Each night with
chats leaves one structured diary entry (`hermes-dream-store.js`, in `dreaming.sqlite`),
shown newest first and read only as **Dream diary** on the memory page, up to 256 KiB.
The memory page follows it over the live topic `agent.memory:<id>`
([Live channel](architecture.md#live-channel)).

### Skills

Hermes seeds every skill it bundles into the home's `skills/` folder
(`tools/skills_sync.py`) and offers each skill it finds there or in a folder of
`skills.external_dirs`, unless `skills.disabled` names it (`agent/skill_utils.py`).
The compiler (`hermes-config/skills.js`) writes:

| Key                    | Value                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `skills.disabled`      | Every bundled skill the owner did not switch on, except `hermes-agent`    |
| `skills.external_dirs` | Each switched-on catalog skill's live folder; the built-in skills' copies |

`hermes-agent` is essential to Hermes and cannot be switched off; the skills page lists
it as on without a switch (state `essential`). Bundled also counts a skill an earlier
release seeded into the home and the installed one no longer bundles: Hermes keeps its
copy and its `.bundled_manifest` entry (`tools/skills_sync.py`), so v0.22.5's `docx`,
`xlsx` and the like stay off after the update to v0.23.3 instead of turning into
skills of the agent's own. Catalog skills are
checked before each apply (a tampered copy is restored from the catalog's store, a
damaged one is left out) and offered from their folders in the catalog's live copy; a
skill of the same name in the home wins over an external one, so such a catalog skill
shows as replaced. An assigned name Hermes neither bundles nor finds in the catalog is
named as `skills` (below). AgentPier's built-in skills (shopping, `built-in-skills.js`)
need the browser and come with it: the team plugin's folder carries a copy
(`plugins/agentpier-team/skills/<name>/SKILL.md`) and `skills.external_dirs` names it
relative to HERMES_HOME (`agent/skill_utils.py` `get_external_skills_dirs`). The skills
report names such a skill `builtIn`, so the skills page leaves it to the **Shopping**
switch.

An agent of restricted users reads only the catalog skills switched on for it:
`skill_view` and `skills_list` find a catalog skill only through its folder in
`skills.external_dirs` and refuse a `file_path` out of the skill, and its file tools
stay in its work folder and chat folders (`hermes-home-guard.js`, [Attached images](#attached-images)), which no
catalog skill lies in. It reads a switched-on skill and its linked files through
`skill_view`. The owner's own agents read files as Hermes lets them.
`hermes-user-skill-reads-contract.test.js` checks this on the pinned Hermes.

Skills the agent writes itself (`skill_manage`) or installs inside Hermes stay on:
practical default, owner's choice. Nothing names them, so Hermes offers them, and
`skills.write_approval` stays off. The skills page lists them as **On: the agent wrote
or installed this skill itself in Hermes Agent** without a switch. Hermes's curator
may archive such skills after long disuse; it never touches bundled, hub-installed or
external skills.

**Learns its own skills** (`skillLearning`, [ADR 0007](adr/0007-runtime-descriptor.md)
decision 8) decides whether the agent writes them by itself. Hermes counts tool
iterations and, at `skills.creation_nudge_interval` (code default 10,
`agent/agent_init.py`), reviews the finished turn in the background for a skill to
write (`agent/turn_finalizer.py`, `agent/background_review.py`); the review runs on
the agent's model with the agent's toolsets, so it may read other chats
(`session_search`) and memory. An agent that learns, the default for every Hermes
agent, has no key; with the switch off the compiler writes
`skills.creation_nudge_interval: 0`, which never starts the review, and switching it
on removes the key again. Nothing else changes: the `skills` toolset stays (it also
holds `skills_list` and `skill_view`), so the agent still writes a skill when asked,
and the memory review (`memory.nudge_interval`), `auxiliary.background_review` and
the curator are not touched. A task member takes its lead's switch at its own next
apply: a change to the lead does not re-apply its members, so a running member keeps
the interval it was started with until something applies it again. A restricted
user's agent keeps its skills in its own home, so the switch works for it as for any
agent.

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

An OAuth server whose login AgentPier holds ([MCP](mcp.md#oauth-logins-held-by-agentpier))
reaches a Hermes agent as a plain Streamable HTTP server: the URL of AgentPier's MCP
proxy (`<proxy>/mcp/<server id>`) and the proxy credential of that server as its
`Authorization` header, both by reference to `.env`. Hermes runs no OAuth flow of its
own and never holds the tokens; an SSE server goes through the proxy the same way.
The credential is this agent's own and works only while the agent is bound to the
server. A server whose login OpenClaw still holds is left out and named `mcpOAuth`
until the owner logs in again. The owner's server overview resolves a Hermes agent's
placeholders in its work folder and names its entry by the server's name, active while
its set runs (`mcp-placeholder-view.js`).

### Not mapped yet

The compiler names what an agent wants that Hermes does not get yet: ChatGPT logins
OpenClaw still holds, the browser while AgentPier knows no browser app, MCP servers it
cannot compile (`mcp`, `mcpOAuth`), assigned skills Hermes cannot offer, a web search
provider it cannot serve (`webSearch`), image creation without a ChatGPT login
AgentPier holds, its proxy or the team bridge (`createImages`) and AgentPier's tools
while no team bridge runs (`teams`).

### Advanced settings

The owner's [advanced settings for all agents](agents.md#turn-agents-on) are
AgentPier's (`runtimes/shared-settings.js`): each runtime states which of them it
takes and how ([ADR 0007](adr/0007-runtime-descriptor.md), decision 5). Hermes takes
the ones Hermes v0.23.3 has a faithful equivalent of, by the shared setting's id
(`hermes-config/advanced.js`): its own key, the translation of the value, and whether
a running agent takes a change live or restarts. They are stored once, in the store
OpenClaw's overrides always used. While Hermes is on and at least one Hermes agent
exists, the page marks the others **OpenClaw only** and Time zone **Restarts Hermes
agents**, its badge then **Immediate for OpenClaw**; these texts take the runtimes' names from the server, so the page itself
names no runtime. Hermes describes no advanced setting of its own yet; one would
show as a row under **Hermes Agent** on the same page.

| Setting              | Hermes                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking level       | `agent.reasoning_effort` | A chat reads the level from `config.yaml` at each turn ([chats follow the agent's settings](#chats-follow-the-agents-settings)), and AgentPier resets a level a chat pinned before its next turn (`session.mutate` `reasoning` reset), so a change needs no restart. New chats and routine runs read it at once. **Off** is `none`; **Adaptive** has no Hermes level and leaves Hermes's default (it thinks adaptively anyway). |
| Time zone            | `HERMES_TIMEZONE`        | The processes' environment, which `hermes_time` reads before `config.yaml`: the agent's clock and its cron. A change restarts the agent; routines keep their own zone ([Routines](#routines)).                                                                                                                                                                                                                                  |
| Time limit per task  | none                     | `agent.run_budget_seconds` only adds a wrap-up notice at 80 % and never stops the task.                                                                                                                                                                                                                                                                                                                                         |
| Image quality        | none                     | Attached images go to the model as they are; tool images are scaled to a fixed byte budget.                                                                                                                                                                                                                                                                                                                                     |
| Maximum image size   | none                     | Tool images are scaled to a fixed 1568 px (`tools/vision_tools.py`).                                                                                                                                                                                                                                                                                                                                                            |
| Media file retention | none                     | Hermes sweeps its media caches after a fixed 24 hours (`MEDIA_CACHE_MAX_AGE_HOURS`).                                                                                                                                                                                                                                                                                                                                            |

Each start and apply writes `agent.reasoning_effort` from the stored value and starts
the processes with `HERMES_TIMEZONE`; without a value the key is removed or the variable
left out, and Hermes's default applies. `timezone` in `config.yaml` is always removed:
the gateway would copy it over the variable (`gateway/run.py`). A start without a desired
state (at server start, after a Hermes update) merges the keys into the existing
`config.yaml` alone. The zone is taken from the environment only while the agent's home
serves a single profile, as AgentPier's always does (`hermes_time._env_timezone`
ignores it in a multiplexing process). Like
OpenClaw's overrides, the mapping is approved for one Hermes version
(`hermesAdvancedRuntime`, checked against `hermes-manifest.json` by
`tests/unit/hermes-advanced.test.js`): another installed version (an update AgentPier
has not approved yet, a rollback) starts with Hermes's defaults, the values stay stored,
and the page names that version. A save of a setting Hermes takes applies every Hermes
agent, as for [web search](#web-search): a new thinking level reaches each chat's next
turn without a restart (a level a chat pinned with Hermes's own `/reasoning`, which
AgentPier does not offer, gives way to it), a new time zone restarts each agent (a turn
under way ends). `tests/integration/hermes-advanced-contract.test.js` checks an existing
chat on the pinned Hermes. None of
the keys touches access, approvals, toolsets, plugins or management.

**Downgrade.** The time zone lives in no file, so an older AgentPier starts its Hermes
agents in the host's zone again, the zone its routine pinning assumes. The thinking
level stays in each agent's `config.yaml`, which an older AgentPier does not own: set
**Thinking level** to its default before a downgrade, or remove `reasoning_effort`
under `agent:` from `config.yaml` in each Hermes agent's home afterwards (the level only
changes how much the model thinks).

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

- **Tools.** The plugin registers the agent's AgentPier tools with `ctx.register_tool`
  under their OpenClaw names, with the same descriptions and schemas
  (`team-plugin/index.js`): its team tools (`agentpier_team_propose`,
  `agentpier_team_delegate`, …; a member gets `agentpier_team_peers`,
  `agentpier_team_peer_ask`, `agentpier_team_peer_delegate` and
  `agentpier_team_report`) and AgentPier's own tools as its grants name them
  (`native-capabilities.js` `toolGrants`): `agentpier_reminder`, `agentpier_routine`,
  `agentpier_hook`, `agentpier_workspace` (project folders, coding requests, browser
  upload staging), `agentpier_share_file`, `agentpier_pinboard`, `agentpier_card`, `agentpier_ssh`, `agentpier_ssh_access`,
  `agentpier_goal`, `agentpier_coding_session`, `agentpier_mail`, `agentpier_project`,
  `agentpier_preview` and, while Android devices can run on the host,
  `agentpier_device`. A restricted user's agent holds what OpenClaw's holds (no
  team, SSH, goal, mail, project, preview or device tools). The bridge serves and checks every
  call as it does OpenClaw's. A project image (`agentpier_workspace` `image_view`)
  comes back as Hermes's multimodal tool result (`_multimodal` with `content` and
  `text_summary`, `tools/registry.py`): OpenClaw's line naming the image and the image
  as an image part, never as base64 text. A model Hermes does not know to see images
  gets the summary instead (`agent/vision_message_prep.py`), which names the image and
  says it cannot be shown. A device's screenshot (`agentpier_device` `screenshot`,
  [Android devices](devices.md#devices-for-agents)) comes back the same way: the
  note AgentPier wrote for it with its width, height and size, and the PNG as an
  image part; the summary for a model without image input says to use action `ui`
  (the screen as numbered elements) instead. The bridge judges a Hermes agent's
  device call by its run exactly as an OpenClaw agent's (`agent-device-origin.js`):
  the plugin names a chat's session, or a routine's or hook's run session
  (`…:hermes:cron:<job>:<session>`), and a session AgentPier does not know (an
  invisible subagent's own session) gets no ticket and so no device. A plugin tool's handler receives
  the calling session's id, the stored session id the session keys carry, and runs
  under the tool call's id (`model_tools.py` `handle_function_call`,
  `tools/approval_context.py`); an MCP call carries neither (`tools/mcp_tool_handlers.py`
  sends only the arguments), so the team tools are no MCP server. Each call takes a
  ticket for its session from the bridge (`/prepare`) and waits inside the tool for the
  answer (`/invoke`): an ask or a proposal waits up to about two minutes, a staged
  browser upload up to five. A routine or hook run's session
  (`cron_<job>_<YYYYmmdd_HHMMSS>`, `cron/scheduler.py`) is keyed by its job
  (`agent:<agent>:hermes:cron:<job>:<session>`, `hermes-routine-jobs.js`), so the bridge
  binds its calls to that run as on OpenClaw. A compression continues a chat in a new
  stored session (its parent ends with `compression`); the plugin walks those parents
  through Hermes's shared `SessionDB` (`hermes_state_registry`) and tries the chat's
  earlier segments, so tool calls and the guard keep finding the chat AgentPier keys by
  an older id. Hermes's Tool Search would put plugin tools behind its
  `tool_search` bridge (`tools/tool_search.py`); an agent with team tools gets
  `tools.tool_search.enabled: off`, so they are offered directly. OpenClaw agents
  differ here: their Gateway runs OpenClaw's tool search in directory mode, which
  lists the team tools by name in the system prompt instead of sending their schemas
  ([OpenClaw tool search](assistant-gateway.md#openclaw-tool-search)).
- **Guard.** A `pre_tool_call` hook asks the bridge (`/hermes-guard`,
  `hermes-tool-guard.js`) before a team member's `write_file` or `patch`, before a file
  call (`read_file`, `search_files`, `vision_analyze`, the writes) whose arguments name
  `attachments/`, `chat-files/` or `.agentpier/`, before a search of the whole work
  folder or beyond it ([chat files](#chat-files)) (on an agent of restricted users,
  own or shared, before every file call: [attached images](#attached-images)), before every browser call and before every
  `image_generate` ([images](#images)); AgentPier's `pdf` tool asks it at each call
  ([PDFs](#pdfs)). It applies the
  OpenClaw guard's rules (`team-plugin/tool-guard.js`, `secrets-guard.js`): an
  attachment is read only from the chat it was sent in (`/attachment-policy`), the
  secrets file not in a hook run without the hook's Secrets switch; a member's file
  change stays inside its own folder, never touches an instruction file
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

Beside OpenClaw's guard: memory steps are OpenClaw's (Hermes keeps its memory itself);
restricted users' locked tools are compiled away (toolsets, [Toolsets](#toolsets))
rather than refused at run time; image creation passes the same image policy
([images](#images)), and a PDF read the same PDF policy ([PDFs](#pdfs)).

## Browser

AgentPier starts and owns each Hermes agent's Chromium (`runtimes/hermes/hermes-browser.js`),
as OpenClaw does for its agents, with the same browser app (`browser-detection.js`):
the agent's own profile in `<data>/assistants/hermes/home/<agent>/agentpier-browser/`,
a CDP port on `127.0.0.1` chosen once and kept, headless unless the agent's **Visible
window** and a separate agent browser app allow a window, and the launch flags of
OpenClaw's managed launches (mock keychain and basic password store, no sync or crash
bubbles, no throttling, no self-reloading error page; headless without the GPU; on Linux without `/dev/shm`, with
Chromium's config and cache homes beside the profile unless set). Like OpenClaw's
managed browser it connects directly: `--no-proxy-server`, and the proxy variables
(`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, also lowercase) are dropped
from its environment, because **Allow private networks for all agent browsers** is
checked against the address a page resolves to, which a proxy would hide (only the browser's
environment changes). The sandbox always stays on: on Linux the app is first
checked to start (`browser-launch-check.js`), one that cannot (such as a Chromium
without a sandbox helper under Ubuntu's AppArmor limit) is passed over for the next,
and the agent's browser settings name the cause ([Linux](linux.md#optional-assistants)).
The compiled home turns the
`browser` toolset on with:

| Key                          | Value                                             |
| ---------------------------- | ------------------------------------------------- |
| `browser.cdp_url`            | `http://127.0.0.1:<port>` of the agent's browser  |
| `browser.allow_private_urls` | **Allow private networks for all agent browsers** |

Hermes's browser is `browser_exec` (since v0.23 its only one): the agent writes Python
against pre-imported helpers (`new_tab`, `goto_url`, `js`, `page_info`, `click_at_xy`,
`fill_input`, `capture_screenshot`, raw `cdp(...)`), which browser-harness, a core
dependency of Hermes's own environment, runs over CDP against the agent's Chromium
(`tools/browser_use_cli.py`). A CDP URL never launches a browser of Hermes's own or a
cloud browser: it ranks before every other backend. `browser_exec` is plain Python on
the host, so Hermes offers it only to an agent with a shell (`terminal` among its tools,
`model_tools.py` `_rewrite_browser_exec`), and AgentPier's guard asks before it on the
asking levels ([shell levels](#shell-levels)). An agent without a shell, such as a task
member its lead grants none or an agent of restricted users, browses with
`browser_cdp`: raw CDP commands on the same browser, which Hermes checks for private
addresses itself (`tools/browser_cdp_tool.py`). The team plugin's guard refuses the
commands that reach past the web pages it works on (`tools/hermes-cdp-policy.js`):
`DOM.setFileInputFiles` (staged files go through `agentpier_browser_upload`),
`Page.setDownloadBehavior`, every `Browser.*` command but `Browser.getVersion`,
`Network.loadNetworkResource`, `Target.exposeDevToolsProtocol`,
`Target.attachToBrowserTarget` and `Security.setIgnoreCertificateErrors`, and a
`Page.navigate` or `Target.createTarget` to anything but an `http`/`https` address or
`about:blank`; nothing refused there starts the browser. `browser_dialog` and `browser_vault` come with the
toolset. A home compiled for Hermes v0.22, whose `browser.backend: off` kept that
release's own browser tools, loses the key at its next start, before Hermes reads it, so
the agent switches to `browser_exec` without Hermes's one-time notice about the removed
key.

The team plugin's guard asks before every `browser_*` call
([teams](#teams)): AgentPier's browser limits (`agent-browsers.js`) admit it, start
the Chromium if it does not run, and refuse with the OpenClaw guard's reasons (the
owner holds the browser, three visible browsers are in use, the browser is off). The
idle stop after 15 minutes, the owner's start and stop, the live view and takeover work
as on OpenClaw: the browser sub-port speaks the part of OpenClaw's browser control API
they use (`GET /`, `POST /start`, `POST /stop`, `GET /tabs`, `POST /screencast`, and
for the takeover's browser toolbar `POST /navigate`, `POST /tabs/focus` and
`DELETE /tabs/<targetId>` in `hermes-browser-control.js`), and its screencast relays
CDP's `Page.startScreencast` frames in OpenClaw's frame format. An address the owner
opens there passes AgentPier's private-network check first; cloud metadata addresses
stay blocked even with private networks allowed.
The browser stops with the agent's process set, and a stop of the set returns only once
the browser is gone: AgentPier asks it to quit over CDP (`Browser.close`), sends
`SIGTERM` to the browser process alone if it is still running after five seconds, and
`SIGKILL` to its whole process group five seconds later; the group also gets `SIGKILL`
once the browser has exited, for a helper process that outlived it. A `SIGTERM` to the
whole group ends Chromium's helpers first, and Chrome 158 on Linux then waits about five
seconds before it exits.

Navigation policy: Hermes refuses the private, loopback and link-local addresses it finds
written in a `browser_exec` call before running it unless **Allow private networks for
all agent browsers** is on (`tools/browser_url_policy.py`), and cloud metadata
addresses always. That check reads only the addresses the code spells out, so
AgentPier enforces the setting in the browser itself: each launch of the agent's
Chromium starts AgentPier's navigation guard (`hermes-browser-guard.js`), one CDP
connection on the browser target that

- intercepts every request (`Fetch`, request stage), whatever tab, frame, worker,
  window or browser context makes it, redirects, a page's own `fetch` and XHR and a
  service worker's requests included. With the setting off a request to an address that
  is not public fails (`BlockedByClient`; a page shows Chromium's error page). Cloud
  metadata addresses and names, `file:` and `filesystem:` fail either way. An IPv6 form
  of an IPv4 address (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64 `64:ff9b::/96`) counts as
  that address, and a name that does not resolve fails. A verdict on a name holds for
  30 seconds.
- attaches to each page and frame as it starts and watches its answers (`Network`): an
  answer from an address the guard refuses, because the name resolved to another
  address when Chromium connected (DNS rebinding), closes that page.
- closes a page that shows one of the browser's own pages (`chrome:`, `devtools:`,
  `view-source:`), which no request reaches; the new tab page stays.

A browser whose guard cannot start or whose guard connection ends is stopped. Not
covered: WebSocket connections, which `Fetch` does not intercept, and what a rebinding
page does between its answer and its close. The guard is no network firewall. Saving
the setting applies every Hermes agent that browses (`web-tools-changes.js`), which
restarts its process set and with it the browser. `browser_exec` itself is Python on
the host, so an agent with a shell reaches the network as its shell does; the setting
limits the browser, not the shell. `hermes-browser-guard-contract.test.js` drives these
paths on a real Chromium.

A temporary team member whose lead grants the browser (`desiredAgent`
`browser.borrowed`) runs its own AgentPier Chromium in its own home. It shows a window
as its lead's would, and is held as one of the member slots of its kind (at most three
headless and three visible at once, `agent-browsers.js` `ownMemberSlot`), as OpenClaw
lends a slot. When the member ends, its browser stops and its profile is removed; a
promoted member keeps both as its own.

File uploads: an agent with AgentPier's browser gets `agentpier_browser_upload`
(`hermes-browser-upload.js`), so files AgentPier staged reach a page's file field
checked and recorded as on OpenClaw, also for an agent without a shell, whose
`browser_cdp` cannot read them. The agent stages a file as on OpenClaw
(`agentpier_workspace` `browser_upload_stage`) and passes the returned `uploadPath`;
AgentPier checks the call as OpenClaw's browser upload (the agent's browser limits,
then only files staged for this agent, `browser-upload-staging.js`), sets the files on
the page's file field over CDP (`DOM.setFileInputFiles` on the agent's own Chromium,
`hermes-browser-files.js`; `selector`, by default the first `input[type=file]`, and
`urlContains` when several pages are open) and records the upload for the owner.

## Images

A Hermes agent with **Create images** creates and edits images with gpt-image-2
through a ChatGPT login AgentPier holds, as an OpenClaw agent does with
`image_generate` (`hermes-config/images.js`). Hermes v0.23.3 bundles the image
backend `openai-codex` (`plugins/image_gen/openai-codex/`, a bundled backend
plugin Hermes loads without `plugins.enabled`): it posts to the Codex backend's own
`images/generations` and `images/edits` endpoints with the Codex credential Hermes
resolves for every Codex call (`agent/auxiliary_client.py`
`_resolve_codex_credential_and_base`: `HERMES_CODEX_BASE_URL` wins, the token comes
from the `openai-codex` pool row of `auth.json`). The compiled home therefore holds:

| Key or file                   | Value                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `agent.disabled_toolsets`     | without `image_gen`                                                          |
| `image_gen.provider`          | `openai-codex`                                                               |
| `HERMES_CODEX_BASE_URL`       | `<proxy>/chatgpt/codex` in `.env`                                            |
| `auth.json` `openai-codex`    | AgentPier's `api_key` row with the proxy credential for this agent and login |
| `agentpier-team` `tools.json` | `images`: the agent's folder, which its generated images are shared from     |

An agent that chats with a ChatGPT login AgentPier holds uses that login's row and URL
([model connection](#model-connection)); any other agent gets a row of its own for
the login AgentPier picks (`model-accounts.js` `heldImageLogin`: a held login
signed in at its last read, the agent's own first). `openai-codex` is no step of
Hermes's auxiliary chain (`_get_provider_chain`), so that row never carries the
agent's model or auxiliary calls. The runtime proxy forwards `POST
/chatgpt/codex/images/generations` and `/images/edits` with the login's token,
`ChatGPT-Account-Id` and residency header (`chatgpt-proxy.js`), and only while the
agent may create images now and the login is its model or the one AgentPier picked
for it (`proxy-access.js`). The home never holds OpenAI's tokens. A login OpenClaw
still holds never reaches Hermes: the switch then says to move the login to
AgentPier (`imagesRuntimeMove`), and the compiler names `createImages`.

Every call passes the team plugin's guard first (`hermes-tool-guard.js`
`imageGuard`), with OpenClaw's rules (`image-policy.js`): the agent must hold
**Create images** now, a reference from the web needs **Read web pages**, and each
generation writes an `assistant.executed` audit event with `kind:
"image-generation"`, never the prompt. A local reference (`image_url`,
`reference_image_urls`) must be an absolute path inside the agent's own folder, also
once resolved, and never an attachment of another chat or its secrets folder; Hermes
reads it itself and would send any file it can read to OpenAI, and it resolves a
relative path against its own process. Hermes's tool waits for the image (no
background task). The plugin's `transform_tool_result` hook hands the image Hermes
saved below `cache/generated/images/` (beside every other chat's) to
`agentpier_share_file` by name (`generated`; the plugin drops that argument from every
call of the model, so only the hook names a cached image), which shares it into the
chat its turn shares into, also to the owner's Telegram chat when the turn came from
there, and keeps a copy for the agent as `generated-<name>` in that chat's file folder
(`hermes-generated-images.js`, [chat files](#chat-files)), written in the agent's
upload queue and within its upload quota, which counts it; the tool result names that
copy. The copy has no index row: the next quota check after its shared copy expires
(90 days, `SHARED_TTL`) removes it. A routine run's image goes to the folder of the chat its routine commits to, a
hook run's to the agent's main chat, as their shares do. On an agent shared with users
only that chat reads it, and it goes with the chat's other files (**Clear**, removing
the chat). Images an older AgentPier created lie in `generated-images/` of the work
folder; on an agent shared with users they leave it before the next start of its
process set ([chat files](#chat-files)). The owner's and a user's own agents keep
that folder. When the share fails, the tool result says so and names no file.
Hermes's own media delivery into an AgentPier chat (`gateway/session_local.py`
`LocalSessionAdapter`) has no image send in v0.23.3, so Hermes logs a
`send_image_file fallback` warning; the image reaches the chat through the share
above. The agent's instructions name image creation as for OpenClaw.

## PDFs

A Hermes agent with **Read PDFs** reads PDFs as an OpenClaw agent does, scanned pages
included, with AgentPier's own `pdf` tool in the team plugin (`hermes-config/pdf.js`,
`pdf-tool.py`, written as `plugins/agentpier-team/pdf_tool.py`). Hermes's `read_file`
reads only a PDF's text layer and would offer scanned pages to Firecrawl's hosted OCR,
which stays off (`file_tools.hosted_ocr: false`). The tool takes OpenClaw's arguments
(`pdf` or up to ten `pdfs`, `prompt`, `pages` like `1-5,7`, `password`; no `model`)
and works like OpenClaw's pdf tool in its extraction mode: PDFium (pypdfium2, which
the installation provisions, [runtime updates](assistant-runtime-updates.md#hermes-agent-runtime))
reads the text of at most 20 pages of each PDF of up to 10 MB and renders every page
with fewer than 200 characters of text as a JPEG image, at most 200 dpi and 4
megapixels shared by all such pages of one call (OpenClaw shares them within one PDF).
PDFium is not thread-safe and Hermes runs subagents and chats in threads of one
process, so the tool opens the file once (never through a link) and reads each PDF in
a child process of its own with the installation's Python, which gets the bytes but
none of the agent's keys; a PDF that crashes or stalls PDFium ends that child only.
Reading all PDFs of a call must finish within 180 seconds, and so must the fallback's
answer, however slowly it arrives.

Each call first asks the team plugin's guard (`hermes-tool-guard.js` `pdfGuard`) with
the file names only (never the password or the prompt): only files in the agent's own
folder (a relative path from it, also once resolved), no web address, no attachment of
another chat and its secrets folder only where the run may read it, as for `read_file`,
judged for the path as written and for the file a link points at. Then AgentPier's PDF policy (`pdf-policy.js` `reader`,
the decision OpenClaw's pdf hook gets as a model reference) names who reads, with
OpenClaw's refusals (the agent may not read PDFs now; its own model takes images but is
unusable):

| Agent's model                        | Who reads                | What the agent gets                                      |
| ------------------------------------ | ------------------------ | -------------------------------------------------------- |
| Takes images                         | The agent's own model    | The page text and the page images as a multimodal result |
| Text only, with a PDF fallback       | The owner's PDF fallback | The fallback's answer to `prompt`                        |
| Text only, without a usable fallback | Nobody                   | The page text and which pages without text were not read |

The fallback is the one chosen under **Connections › Services for agents › PDF
reading** (`pdf-model-settings.js`). An agent whose own model takes no images gets it
in its home: in `tools.json` (`pdf.fallback`: Chat Completions URL and model, or the
model proxy's `<proxy>/chatgpt/codex` for a ChatGPT login AgentPier holds) and its key
in `.env` as `AUXILIARY_AGENTPIER_PDF_API_KEY`, which Hermes strips from every command
(for a ChatGPT login the proxy's credential for this agent and login, valid on the
Codex Responses route only and while the agent may read PDFs and that login is the
fallback, `proxy-access.js`). An agent whose own model takes images, by the policy's
own check (also an OpenRouter model, from the catalog), gets neither. The tool calls it
itself, once, never through Hermes's auxiliary client, whose recovery could move the
request to another provider, and follows no redirect, which would carry the key to
another address. A fallback without image input gets the text only, as on
OpenClaw. Saving the fallback applies every Hermes agent that reads PDFs
(`web-tools-changes.js`), which restarts only the homes it changed. The policy reads
the setting as it is now and names the fallback's identity (connection and model,
`pdfFallbackId`), which the home carries as `pdf.fallback.id`: while they differ (the
owner switched the fallback and the apply is pending or failed) the tool reads the
text only and sends nothing to the old fallback, and a cleared fallback stops reading
at once. A fallback
Hermes cannot call (another transport than Chat Completions, a login OpenClaw holds)
leaves such an agent with the text layer.

Beside OpenClaw's pdf tool: no native PDF input for Anthropic or Google models (every
model gets text and page images), no web addresses or OpenClaw media references, and
the agent's own model sees the pages directly in its context instead of through a
second call.

## Agents on Hermes

Everything that is Hermes's own lives in `server/features/assistants/runtimes/hermes/`:
the adapter's sub-ports, the compiler (`hermes-config/`), the nightly dreams
(`dreams/`), what answers the team plugin's hooks and keeps the agents' images
(`tools/`: the guards, the browser upload, the routine approvals, generated images),
the backup path rules (`hermes-backup-paths.js`), the owner's routes
(`hermes-routes.js`) and the wiring (`wiring.js`). Product code outside
`server/features/assistants/runtimes/` and `web/features/assistants/runtimes/` spells
no runtime's name in a string literal, a file name or an identifier, apart from the
listed exceptions of `tests/unit/runtime-id-rules.test.js`; the port's own modules in
`runtimes/` (`runtime-for.js`, `runtime-wiring.js`, `runtime-services.js`,
`runtime-backup-paths.js`) do name Hermes, and comments and log texts may
([ADR 0007](adr/0007-runtime-descriptor.md), Known limits of the rule). The
composition roots call `wireRuntimes`, `wireAgentHosts` and `ownProcessWiring`
(`runtimes/runtime-wiring.js`), which call Hermes's `wire` (the owner's switch, its
install state for the runtime list, its routes, its start once the server listens),
`agentHosts` (the fleet of one assistant graph) and `applyInputs`; feature code
reaches the tool routes, the dreams and the images through
`runtimes/runtime-services.js` and the backup rules through
`runtimes/runtime-backup-paths.js`
([ADR 0007](adr/0007-runtime-descriptor.md), decision 7).

`runtime-for.js` resolves an agent that records `runtime: "hermes"` to its own
runtime in the Hermes fleet (`runtimes/hermes/hermes-fleet.js`), one supervised
process set per agent, keyed by its runtime agent id. The fleet is attached to the
OpenClaw supervisor that feature code passes around as Hermes's agent hosts
(`attachAgentHosts`; feature code asks `agentHosts(supervisor, agent)`), so callers keep using
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

| Capability                                                  | Hermes                           |
| ----------------------------------------------------------- | -------------------------------- |
| host, sessions, events, approvals, config, agents, routines | available                        |
| agentFiles, skills                                          | available                        |
| models                                                      | available (no account sign-ins)  |
| channels                                                    | available (the owner's Telegram) |
| channelBots                                                 | available (Hermes's own adapter) |
| browser                                                     | available (AgentPier's Chromium) |
| advancedSettings                                            | available (those Hermes maps)    |

How Hermes behaves within them are the traits of its descriptor
(`runtimes/hermes/descriptor.js`, [ADR 0007](adr/0007-runtime-descriptor.md)); every
other value is OpenClaw's, the default:

| Trait                     | Hermes                                | OpenClaw                            |
| ------------------------- | ------------------------------------- | ----------------------------------- |
| `approvals.shellLevels`   | `off`, `approval`, `every`, `full`    | `off`, `approval`, `review`, `full` |
| `approvals.allowlist`     | `exactCommands` (AgentPier remembers) | `patterns`                          |
| `agentFiles.memoryFormat` | `entries` with character limits       | `markdown`                          |
| `agentFiles.dreaming`     | `agent` (each agent's nightly dream)  | `host`                              |
| `models.chatgptLogin`     | `agentpierHeld`                       | `any`                               |
| `channelBots.peopleApply` | `restart`                             | `live`                              |
| `skills.learnsByDefault`  | `true`                                | `false`                             |
| `skills.userAgentsLearn`  | `true` (skills in its own home)       | `false`                             |
| `skills.writesWhenAsked`  | `true` (`skill_manage` stays)         | `false`                             |
| `skills.channelBotsLearn` | `true` (no `session_search` with one) | `false`                             |
| `sessions.chatFolders`    | `true`                                | `false`                             |
| `host.process`            | `perAgent`                            | `shared`                            |
| `host.install`            | `optional`                            | `builtin`                           |

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
| `platforms.telegram.extra.fallback_ips`                     | Hermes's seed Bot API addresses: no DNS-over-HTTPS lookups             |
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
OpenClaw. Hermes appends a one-time "introduce yourself" note to the first message a
person sends while the home has no other session (`gateway/run_turn_prepare.py`), and
no setting turns it off; the RPC bridge therefore seeds an archived, empty session
(`agentpier-first-contact`) in a home without any at its start, so a person writing to
the agent's bot never gets it. Without a configured list Hermes's adapter asks Google's
and Cloudflare's DNS-over-HTTPS resolvers for `api.telegram.org` at each connect;
AgentPier compiles Hermes's own seed addresses as `platforms.telegram.extra.fallback_ips`,
so no lookup goes to a third party, IPv4 is still tried before the dual-stack host name,
and the host name stays the last path through the system resolver. Files reach the owner's paired chat when an agent shares them with
`agentpier_share_file`, as on OpenClaw.

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
| marker, target, delivery, rest | AgentPier's own, by job id (`agentpier-routines.json`, below)                            |
| run state                      | `next_run_at`, `fire_claim.at` (running), `last_run_at`, `last_status`, `failure_streak` |
| runs                           | `GET …/runs`: each run's own stored session                                              |

AgentPier keeps its part of each routine (marker, target, delivery, the prompt's run
settings, the routine's own schedule and zone, a revision) in `agentpier-routines.json`
in the agent's `HERMES_HOME`, by job id (`hermes-routine-meta.js`), beside the record
of delivered runs: Hermes v0.23 refuses to update any job field its REST routes do not
list (`hermes_cli/web_routers/cron.py`). A job written for Hermes v0.22.5 still carries
that part in its own `agentpier` field, which counts until AgentPier writes the job's
entry, so jobs of either release are read and a rollback to v0.22.5 keeps the routines
added since. An entry goes only once Hermes answers "not found" for its job, never because
a listing missed it (Hermes lists none while its `cron/jobs.json` is missing); a file
that is no JSON object is set aside as `agentpier-routines.json.corrupt-<time>` and
reported (`HERMES_ROUTINE_META_UNREADABLE` in the server log), never written over.
A job is created paused, given its entry and only then resumed, so it never
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
once per run; one that failed is tried again while its run is the job's last. A note for a chat whose turn runs or waits on AgentPier's connection is kept until that
turn ended and then written, after its reply.

**Time zones.** Hermes matches every cron expression in the time zone of the agent's
processes (`cron/jobs.py compute_next_run`, `hermes_time`: `HERMES_TIMEZONE` or
`timezone` in `config.yaml`, else the process's zone, which is AgentPier's own TZ,
passed on by `hermes-environment.js`); AgentPier sets no zone per job (v0.23 added
an optional one, which a job without it does not use). The owner's **Time
zone** ([advanced settings](#advanced-settings)) is the `HERMES_TIMEZONE` of the
agent's processes, and AgentPier pins against the zone of the current start. A cron
routine without a zone, or in that zone, runs as written; a pinned job whose routine is
in the zone Hermes runs in after a change of **Time zone** gets its own expression back,
and a job on its own expression that is due while the agent restarts for the change is
left to Hermes's catch-up once before it is pinned. A routine in another zone runs as a
pinned job (`hermes-cron-zone.js`): AgentPier computes its next occurrence in its own
zone and writes the expression `<minute> <hour> <day> <month> *` of that instant in the
process's zone; the routine's own expression and zone stay in AgentPier's entry for
the job and are what AgentPier reads back. Each delivery check, and each change or
resume of the routine, pins the job to the occurrence after it once its pin passed
(it ran, or it was due while the gateway was down), so `next_run_at` is always the
routine's next run in its own zone. Occurrences follow OpenClaw's policy
([routine qualification](assistant-routine-qualification.md)): a time the spring
transition skips does not run that day, a time the autumn transition repeats runs at
its first occurrence. A pinned expression is refused when it is not a standard
five-field expression (numbers, names, `*`, ranges, steps, lists). Known limit: a pin
names a wall-clock time in the agent's zone, so when the routine's next run falls into
the hour that zone repeats at the autumn transition, Hermes fires at the first of the
two (an hour early) when the second was meant, and that day's run then counts as done.
It needs a routine in another zone than the agent's, with the agent's zone changing its
clock at that hour.

**Dangerous commands in routine runs.** With **Full access** (`approvals.mode: off`)
Hermes runs every command of a routine run, as OpenClaw does. With **Dangerous
commands** or **Every command**, the owner is asked in the chat the routine reports to
(and its Telegram chat), and the run waits, as on OpenClaw. Hermes itself asks nobody in
a cron run: it clears every approval surface (`tools/approval.py _presence`,
`HERMES_CRON_SESSION`) and decides by `approvals.cron_mode`. AgentPier therefore sets
`cron_mode: approve` and lets the `agentpier-guard` plugin ask instead. Its
`pre_tool_call` hook asks AgentPier's team bridge (`/hermes-approval`,
`hermes-routine-approvals.js`) and waits up to five minutes
(`plugins.hook_callback_timeout: 330`, within Hermes's 600 s). It asks before each
action that mode would otherwise let through: a command Hermes flags as dangerous
(`tools/approval_detection.py`), every `execute_code` run, a write to the SSH client
config, and with every-command approval every other shell command and process input.
AgentPier raises the question through the agent's approvals sub-port (`approvals.ask`),
so it appears like Hermes's own approvals. An allow lets the call run; a denial, no
answer within five minutes, or no bridge blocks it, and the run reports the refusal
(`BLOCKED: …`) to the agent. Hardline commands stay blocked by Hermes's own floor.
Without the team bridge the home keeps Hermes's default `cron_mode: deny`, which
refuses those commands unasked. A cron run is no AgentPier-tracked run, so it shows no
`waiting-approval` phase.

The agent's own reminder and routine tools (`agentpier_reminder`, `agentpier_routine`)
come with the team plugin ([teams](#teams)) and schedule on the same Hermes cron.

## Gateway protocol

AgentPier writes the home before each start (`runtimes/hermes/hermes-runtime.js`), then
talks to the gateway's session store over the RPC bridge: newline-delimited JSON-RPC
2.0, the same framing as Hermes's stdio server, but the gateway's own methods. The
adapter (`hermes-sessions.js`, `hermes-run-state.js`, `hermes-approval-queue.js`)
relies on these:

| Purpose           | Gateway method or event                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Create a chat     | `session.create { request_id, title, follow_profile_config: true }`: idempotent by `request_id`; titles are unique |
| Attach a chat     | `session.resume { session_id, omit_messages }`: needed before a turn, after every restart                          |
| Find a chat       | `session.list { title }`                                                                                           |
| Run a turn        | `prompt.submit { session_id, text, submission_id, attachments? }`: answers `admission_id`                          |
| Attach images     | `image.attach_bytes { session_id, content_base64, ext }` → `{ path, mime }` before submit                          |
| Stop a turn       | `session.interrupt { session_id, execution_generation }`; `prompt.cancel` while queued                             |
| Read a transcript | `session.history { session_id }`                                                                                   |
| Compress, archive | `session.mutate { operation, payload, request_id, expected_revision, … }`                                          |
| Delete            | `session.mutate` with `delete` and `expected_generation`                                                           |
| Title a chat      | `llm.oneshot` with the `title_generation` task                                                                     |
| Review memory     | `llm.oneshot` with the `memory_review` task, no `session_id`                                                       |
| Turn frames       | `message.start`, `message.delta`, `tool.*`, `message.complete`, each with `admission_id`                           |
| Approvals         | `approval.request` → `approval.respond`; `approval.settled`, `approval.cancelled`                                  |
| Routines          | `agentpier.http` (the bridge) → `/api/cron/jobs…`; the event `cron.changed`                                        |
| Routine results   | `agentpier.note` (the bridge): a note row in the target chat's history                                             |
| Context size      | `session.stats { session_id }`: `last_prompt_tokens`, `context_length`                                             |
| Questions         | `clarify.request` → `clarify.respond`; `clarify.settled`, `approval.cancelled`                                     |
| Sudo, secrets     | the `sudo` and `secret` requests, declined at once with `{ value: "" }`                                            |

A turn that fails ends with `message.complete` (`status: error`) or an `error` event.
The run's outcome keeps Hermes's error text: the provider's own line where Hermes's
reply quotes it ("Provider said: …", `agent/turn_failure_copy.py`), else `error`, the
reply text or the event's `message`. An error of the provider's layers
(`error_surface.layer` `provider`, `endpoint`, `auth` or `billing`, not a timeout)
also names the provider as the cause, so the chat shows **The model provider refused
this message** with that text, redacted, as for OpenClaw agents
(`run-reconciler.js`, `routine-failures.js`; AGENTPIER-439).

After a model switch with fresh chats, AgentPier reviews the agent's `MEMORY.md` and
`USER.md` on its new model (`memory-review.js`) with one `llm.oneshot` call: the
review task as `instructions`, the two files as `input`, `max_tokens` 4000 and no
`session_id`, so no chat history goes with it. Checked against the pinned Hermes
v0.23.3: a one-shot without a session runs its `task` on the route
`auxiliary.<task>` configures, and AgentPier compiles no `auxiliary.memory_review`, so
Hermes takes its `auto` route, the agent's main provider and model from its own
`config.yaml` (`tui_gateway/methods_session.py` `llm.oneshot`,
`agent/auxiliary_client.py` `_resolve_task_provider_model`, `_resolve_auto_route`,
`_main_route_target`; only `title_generation` may opt into a faster model). Reading the
memory applies the agent's configuration first, so the review runs on the new model.
Limit: Hermes's one-shot has a fixed 60-second request timeout (`agent/oneshot.py`
`run_oneshot`) that a caller cannot raise, where OpenClaw's review gets 120 seconds; a
slow model's review fails and the owner is told the memory could not be reviewed.

A chat's history names how full its context was for the long-chat hint as OpenClaw's
does (`sessionInfo.totalTokens`, `totalTokensFresh`, `contextTokens`): the
`last_prompt_tokens` and `context_length` of the agent the gateway keeps for the
session (`gateway/session_usage.py`), read while the session is attached to
AgentPier's connection. Hermes keeps that agent only in the gateway's memory and stores no prompt size, so
after a gateway restart the size read last for the chat stands until its next model call
(its history is unchanged); after a compression AgentPier asked for, the size is unknown
until the next turn, as OpenClaw's is after a compaction (no hint meanwhile).

When a Hermes agent calls its `clarify` tool, Hermes asks every connection attached to
the session (`clarify.request`, one per question, with its choices; Hermes marks the
first as recommended). The adapter (`hermes-questions.js`) publishes it as the run
event `question.requested` in the port's shape, a request of one to three questions
([Questions to the owner](assistant-gateway.md#questions-to-the-owner-2026-11-27)):
Hermes's one question as a one-element list, its id `answer`, its choices as options
without descriptions, an own answer always taken. The run reports the phase
`waiting-approval`; `agent-questions.js` shows it in the agent's chat as a card with
the choices and a field for an own answer, and, when the turn came from the owner's
paired Telegram chat, as a notice there, where the next message answers it (a number
picks a choice). The answer goes back with `clarify.respond` as one text (several
chosen options joined by ", "). Hermes waits up to `agent.clarify_timeout`, which
AgentPier sets to an hour (Hermes's own default since v0.23 is 90 seconds), and then
tells the agent nobody answered; an interrupt withdraws the question
(`approval.cancelled`). Questions are not stored: after a restart, the attached session
lists what still waits and it is asked again. Hermes's `sudo` and `secret` requests ask
for a sudo password or a secret's value, which AgentPier never hands out through a prompt
(agents get the secrets the owner granted them): both are declined at once, so the agent
goes on and says what it lacks.

Every refusal is code 4001 with its reason in `error.data.reason`; an unknown parameter
is refused as `invalid_params`, so AgentPier sends only the parameters listed.

## Parity with OpenClaw agents

What AgentPier offers an OpenClaw agent and how a Hermes agent gets it (audit of
AGENTPIER-344, logins from AGENTPIER-340).

| Feature                                                    | OpenClaw                            | Hermes                                              | Notes                                                        |
| ---------------------------------------------------------- | ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Chats, streaming, tool steps, history                      | Gateway sessions                    | Gateway sessions over the RPC bridge                | [Gateway protocol](#gateway-protocol)                        |
| Chat titles, queued messages                               | While the Gateway is ready          | While the agent's set is ready                      | Independent of OpenClaw                                      |
| Chat deletion, user release                                | Session, archives, dreaming copies  | Session and transcript (`session.mutate delete`)    | Retried at the set's next ready                              |
| Long chats                                                 | Compaction, context size            | Compression, `session.stats`                        |                                                              |
| Model connection                                           | Every connection                    | Every connection; ChatGPT logins AgentPier holds    | [Model connection](#model-connection)                        |
| Shell levels                                               | Off, approval (every command), full | Off, dangerous commands, every command, full        | [Shell levels](#shell-levels)                                |
| Routine runs on an asking level                            | Ask the owner                       | Ask the owner through the guard                     | [Routines](#routines)                                        |
| Always allow                                               | OpenClaw's allowlist                | AgentPier remembers the exact command               | Same allowlist page, exact commands only                     |
| Memory                                                     | Files, memory steps, Dream Diary    | `MEMORY.md`, `USER.md`, Hermes's own review, pins   | No memory step; 10,000 / 5,000 characters                    |
| Dreaming                                                   | memory-core                         | AgentPier's nightly one-shot dream, pins kept       | [Dreaming](#memory-and-instructions); memory stays on        |
| Skills                                                     | Bundled, catalog, shopping          | Bundled, catalog, shopping, self-written            | `hermes-agent` always on                                     |
| Learns its own skills                                      | `skill_workshop`, mode `auto`       | `skills.creation_nudge_interval`                    | Off / on by default; [Skills](#skills)                       |
| Mixture of Agents                                          | —                                   | `moa.presets.agentpier`, up to three advisors       | [Mixture of Agents](#mixture-of-agents)                      |
| Memory wiki                                                | `memory-wiki`, bridge, read page    | —                                                   | Not available (capability `memoryWiki`)                      |
| Usage (tokens and cost)                                    | OpenClaw's usage report             | —                                                   | Not available (capability `usage`); context size only        |
| MCP servers                                                | stdio, HTTP, OAuth                  | stdio, HTTP, OAuth logins AgentPier holds           | [MCP servers](#mcp-servers)                                  |
| Web search                                                 | DuckDuckGo, Brave, Perplexity       | `ddgs`, `brave-free`, AgentPier's Perplexity plugin | [Web search](#web-search)                                    |
| Web fetch                                                  | `web_fetch`                         | AgentPier's `agentpier-fetch`                       | Private networks always refused                              |
| Read images                                                | `view_image`                        | `vision` toolset                                    |                                                              |
| Read PDFs                                                  | `pdf` with the PDF model            | AgentPier's `pdf` tool with the same model          | [PDFs](#pdfs); no native PDF input, no web addresses         |
| Create images                                              | ChatGPT account                     | ChatGPT login AgentPier holds                       | [Images](#images)                                            |
| Attachments, video                                         | `attachments/` in the workspace     | A folder per chat outside its work folder           | [Chat files](#chat-files); images inline                     |
| Browser                                                    | AgentPier's Chromium                | AgentPier's Chromium                                | [Browser](#browser)                                          |
| Browser for task members                                   | Member slot                         | Own Chromium under the slot limit                   |                                                              |
| Browser uploads                                            | Staged files                        | `agentpier_browser_upload` for staged files         | Checked and recorded as on OpenClaw                          |
| Reminders, routines, hooks (agent's tools)                 | Team plugin                         | Hermes team plugin                                  | Same bridge                                                  |
| Owner's routines, check-ins, hooks                         | OpenClaw cron                       | Hermes cron                                         | [Routines](#routines)                                        |
| Workspace, projects, project files                         | `agentpier_workspace`               | The same                                            | Project images as images                                     |
| Share files, to Telegram                                   | `agentpier_share_file`              | The same                                            |                                                              |
| Pinboard of files for the owner                            | `agentpier_pinboard`                | The same                                            | [Pinboard](agents.md#pinboard)                               |
| Interactive cards in the chat                              | `agentpier_card`                    | The same                                            | [Agent cards](agents.md#agent-cards)                         |
| Secrets for agents                                         | `.agentpier/secrets.env`            | The same file                                       | Hook-run read guard                                          |
| SSH, SSH access                                            | `agentpier_ssh`, plain aliases      | The same; SSH agent's `bin/` on PATH                | PATH change restarts the set                                 |
| GitHub                                                     | `gh` folder, MCP server             | The same                                            |                                                              |
| Work goals, coding sessions, mail, previews                | Team plugin                         | Hermes team plugin                                  |                                                              |
| Teams, lead requests, member grants, lead shares, mentions | Team plugin                         | Hermes team plugin                                  | Members run on the lead's runtime                            |
| Invisible subagents                                        | `sessions_spawn`                    | `delegate_task`                                     |                                                              |
| Questions to the owner                                     | `ask_user` (one to three questions) | `clarify` (one question)                            | OpenClaw: own agents only; waits 15 minutes, Hermes an hour  |
| Restricted users' locked tools                             | Refused at run time                 | Toolsets compiled off                               |                                                              |
| Telegram (owner's chat)                                    | AgentPier channel layer             | The same                                            |                                                              |
| Telegram for other people                                  | OpenClaw's adapter                  | Hermes's adapter                                    | A people change restarts the agent                           |
| Backups                                                    | Sealed credentials and history      | Sealed `.env`, `auth.json` and history              | [Backups](backups.md#hermes-agents)                          |
| Access and approval audit                                  | AgentPier                           | AgentPier                                           |                                                              |
| Advanced settings                                          | All six                             | Thinking level, time zone                           | [Advanced settings](#advanced-settings)                      |
| Thinking level, fast mode and loop protection per agent    | Identity › Model behaviour          | —                                                   | Hermes agents follow the level for all agents                |
| Fallback models per agent                                  | Identity › Model behaviour          | —                                                   | Hermes's own `fallback_providers` are not managed            |
| Looking up earlier chats                                   | With memory on (`sessions_*` tools) | Hermes's `session_search`, always                   | [Earlier chats](agents.md#earlier-chats)                     |
| Finding notes by meaning (local embeddings)                | Agents › Runtime, for all agents    | —                                                   | [Semantic memory search](agents.md#semantic-memory-search)   |
| Updates                                                    | OpenClaw update                     | Hermes update                                       | [Updates](assistant-runtime-updates.md#hermes-agent-runtime) |

## Contract tests

`tests/unit/hermes-config-golden.test.js` compares the compiled homes with
`tests/fixtures/hermes-golden/`. `tests/integration/hermes-config-check-contract.test.js`
runs `hermes config check` on each compiled home and checks how Hermes reads it: the
approval mode, the toolsets, the guard plugin, the model route and that the key stays out
of child processes. The sessions, approvals, routines, host and install contracts run
the agent through the Hermes runtime, its supervised gateway and the RPC bridge, against
the in-repo fake model; `hermes-agent-routines-contract.test.js` runs an owner's routines
through AgentPier's routine routes, `hermes-agent-hooks-contract.test.js` a hook event
through AgentPier's hook routes, and `hermes-routine-parity-contract.test.js` a routine in another time zone, a result the next turn reads, a result that waits for a
running turn's reply, the long-chat size (also after a gateway restart) and a dangerous
command in routine runs on full access and on approval (asked, allowed, denied).
`hermes-own-tools-contract.test.js` shares a file of the agent's work folder with
`agentpier_share_file`; `hermes-member-browser-contract.test.js` opens a page in a task
member's own Chromium; `hermes-browser-upload-contract.test.js` fills a local page's
file field with a staged file and refuses an unstaged one;
`hermes-skill-learning-contract.test.js` compiles a home with **Learns its own skills**
off, unset and on, and reads the review interval through Hermes's own agent setup (0,
then Hermes's 10);
`hermes-mixture-contract.test.js` reads a home with two advisors through Hermes's own
config loader and MoA normaliser (exactly AgentPier's slots, each resolving to its own
endpoint and key, every key name one Hermes hides), shows what Hermes would make of a
preset AgentPier never writes, and runs a turn with three advisors (one answering, one
refused, one unreachable) that brings one advisor step each to the run events;
`hermes-user-agent-lock-contract.test.js` forces a restricted user's agent to call each
locked tool and finds each refused; `hermes-user-skill-reads-contract.test.js` lets such
an agent read its switched-on catalog skill and refuses every other catalog skill;
`hermes-images-contract.test.js` creates an image
with a ChatGPT login AgentPier holds through the runtime proxy and a fake Codex backend
(the login's token only upstream, one audited generation, the image shared into the
chat) and refuses a reference outside the agent's folder.
`tests/integration/hermes-files-contract.test.js` checks the agent's files: a memory
entry written through the port reaches the agent's prompt, and an entry the agent adds
with Hermes's `memory` tool comes back through it; an assigned bundled skill and a
catalog skill reach the agent's skill index while an unassigned one stays out, and a
skill the agent writes is reported as its own; a bound stdio MCP server's tool is
offered and called, and its secret never reaches the agent's shell.
`hermes-chatgpt-contract.test.js` runs turns on a ChatGPT login AgentPier holds through
the model proxy against a fake Codex backend and issuer (no token in the home, one
renewal by AgentPier after a 401), and `hermes-mcp-proxy-contract.test.js` calls an
AgentPier-held OAuth MCP server's tool through the MCP proxy.
`hermes-update-contract.test.js` installs the
previous release (`tests/fixtures/hermes-previous-manifest.json`, made with
`scripts/refresh-hermes-runtime-lock.mjs`) and the pinned one into a disposable data
directory and updates an agent between them through AgentPier's Hermes update path: a
failed validation restores the snapshot and the previous release, the next activation
commits and the agent's chat is kept; a running turn blocks it until **Pause agents and
update** stops it. With `AGENTPIER_HERMES_DOWNLOAD_CACHE` set (as CI does), the
archives AgentPier downloads for both pins come from that folder
(`scripts/hermes-contract-downloads.mjs`); unpacking, `uv`, the identity check and the
receipt still run. The teams contract drives a Hermes lead's team tools (proposal, a
member provisioned as a Hermes agent, a delegated task) and the guard's refusal of a
read-only task's write; the browser contract opens a local page with `browser_exec` in the agent's
AgentPier-owned Chromium, reads the live view's frames and, with private networks off,
sees AgentPier's navigation guard keep the page out when the code builds its address;
the upload contract fills a page's file field, and the member browser contract browses
with `browser_cdp` in a task member's own Chromium. All three use the installed browser app, or the one
`AGENTPIER_TEST_BROWSER_PATH` names (`hermesContractBrowser` in
`tests/helpers/hermes-native.js`; skipped, with the reason, without one; with `CI` set
they fail instead). The `hermes-contracts` job exports that variable from the runner's
Google Chrome, or Playwright's Chromium on the Linux arm64 image without Chrome, as the
`native-contracts` job does ([web tools qualification](assistant-web-tools-qualification.md)): the Ubuntu
image's `/usr/bin/chromium`, which the detection prefers, is an unpacked snapshot
without a sandbox helper that AppArmor's user namespace limit stops at launch.
Set `AGENTPIER_HERMES_CONTRACT_RUNTIME` to an installation made by `scripts/provision-hermes-contracts.mjs` (its `venv/bin/`
holds `python` and `hermes`). `hermes-pdf-contract.test.js`
lets a text-only agent read a two-page PDF whose second page is a scan: the tool reads
it with the installation's PDFium, and the owner's fallback (a second connection of the
fake model that takes images) gets the text and the page image with its own key, while
a file outside the agent's folder is refused before anything is read.
`hermes-image-input-contract.test.js` gives an agent on a model that takes images (a
connection of the fake model declared with image input) an attached PNG and a project
folder image: the model's request carries the attachment as an image part after the
turn's text, the chat shows the owner's words with the file, and the image the agent
views with `agentpier_workspace` `image_view` reaches the model as an image part of the
tool result, never as base64 text. The tests use a private
`HOME` and `HERMES_HOME` and never touch
`~/.hermes`.
