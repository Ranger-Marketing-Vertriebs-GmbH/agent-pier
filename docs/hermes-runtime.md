# Hermes runtime

AgentPier can run an agent on [Hermes Agent](https://github.com/NousResearch/hermes-agent)
beside OpenClaw ([ADR 0006](adr/0006-assistant-runtime-port.md)). Each Hermes agent runs
in its own Hermes process with its own `HERMES_HOME` inside AgentPier's private runtime
folder. This guide describes what AgentPier writes into that home and which defaults it
sets. Key names were verified against Hermes `a4994d4e` (2026-10-31); the
[spike](research/hermes-runtime-spike.md) records the hands-on evidence.

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
Every-command approval is a Hermes-only option that the desired state does not carry
yet: a start names those agents explicitly.

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

Invisible subagents (`delegate_task`) stay on. Under the stdio gateway AgentPier uses,
their dangerous commands reach the owner through the parent session's approval queue.
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

## Contract tests

`tests/unit/hermes-config-golden.test.js` compares the compiled homes with
`tests/fixtures/hermes-golden/`. `tests/integration/hermes-config-check-contract.test.js`
runs `hermes config check` on each compiled home and checks how Hermes reads it: the
approval mode, the toolsets, the guard plugin, the model route and that the key stays out
of child processes. Set `AGENTPIER_HERMES_CONTRACT_RUNTIME` to a Hermes installation
folder whose `bin/` (or `.venv/bin/`) holds `python` and `hermes`. The test uses a
private `HOME` and `HERMES_HOME` and never touches `~/.hermes`.
