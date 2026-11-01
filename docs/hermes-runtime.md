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

| File                       | Content                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `config.yaml`              | Model, toolsets, approvals, memory, plugins and the defaults below |
| `.env`                     | The model connection's key                                         |
| `SOUL.md`                  | The agent's instructions                                           |
| `plugins/agentpier-guard/` | `plugin.yaml` and `__init__.py`, only for every-command approval   |

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
`cronjob` and `computer_use` stay off until AgentPier serves them on Hermes.

### Not mapped yet

The compiler names what an agent wants that Hermes does not get yet, so the owner can see
it: ChatGPT accounts, the browser, MCP servers, assigned skills, PDF reading, routines,
team tools and the extra folders on the shell's PATH. Routines, MCP, skills and Telegram
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
approval resync and own-job pauses skip them. Their chats reconcile on their own
set's connection (`chat-reconcile.js`, `run-reconciler.js`), and the run events of
every set reach the chat path and the event hub once (`agentRuntimeEvents`).

| Capability                                              | Hermes                              |
| ------------------------------------------------------- | ----------------------------------- |
| host, sessions, events, approvals, config, agents       | available                           |
| everyCommandApproval                                    | available (unavailable on OpenClaw) |
| agentFiles, routines, skills, browser, models, channels | `hermesNotYetSupported`             |
| advancedSettings                                        | `advancedSettingsUnsupported`       |

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

Every refusal is code 4001 with its reason in `error.data.reason`; an unknown parameter
is refused as `invalid_params`, so AgentPier sends only the parameters listed.

## Contract tests

`tests/unit/hermes-config-golden.test.js` compares the compiled homes with
`tests/fixtures/hermes-golden/`. `tests/integration/hermes-config-check-contract.test.js`
runs `hermes config check` on each compiled home and checks how Hermes reads it: the
approval mode, the toolsets, the guard plugin, the model route and that the key stays out
of child processes. The sessions, approvals, host and install contracts run the agent
through the Hermes runtime, its supervised gateway and the RPC bridge, against the
in-repo fake model. Set `AGENTPIER_HERMES_CONTRACT_RUNTIME` to an installation made by
`scripts/provision-hermes-contracts.mjs` (its `venv/bin/` holds `python` and
`hermes`). The tests use a private `HOME` and `HERMES_HOME` and never touch
`~/.hermes`.
