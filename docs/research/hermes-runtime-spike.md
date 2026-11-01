# Hermes Agent as a second assistant runtime: spike

Date: 2026-11-01. Source: `NousResearch/hermes-agent` at `a4994d4e` (2026-10-31), installed
from source with `uv sync --frozen --python 3.14` (base 122 MiB venv, 162 MiB with the
`messaging` extra). Platform: macOS arm64. This is recorded evidence, not a promise about
later releases.

Goal: decide whether AgentPier can run Hermes **in parallel to OpenClaw, per assistant**,
at feature parity, and with practical defaults from the start (not locked down first and
relaxed later, as happened with OpenClaw).

## Probe conditions

Private `HOME`, `HERMES_HOME`, `TMPDIR` and work directory inside a disposable folder;
environment cleared (`env -i`). A deterministic local OpenAI-compatible model
(`RUN: <cmd>` produces a `terminal` tool call; tool results are echoed). No personal
accounts, channels, paid models or service installation. All processes were stopped
afterwards; the real `~/.hermes`, LaunchAgents and `~/.local/bin` stayed untouched.

## Hands-on observations

| Probe                    | Observed result                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control surface          | `python -m tui_gateway.entry`: newline-delimited JSON-RPC on stdio, `gateway.ready` after 4.6 s (cold)                                                                                                                                                                                      |
| Capabilities             | `gateway.capabilities`, `client.capabilities {server_requests:true}` lists `approval`, `clarify`, `secret`, `sudo`, …                                                                                                                                                                       |
| Session and turn         | `session.create` → `prompt.submit` → `message.start`/`message.delta`/`message.complete` with usage; `tool.generating`/`tool.start`/`tool.complete` per tool call                                                                                                                            |
| History, list            | `session.history` and `session.list` returned exact rows with durable `row_id`s                                                                                                                                                                                                             |
| First-turn injection     | Hermes appended an onboarding hint to the first user message; `onboarding.profile_build: "off"` removes it                                                                                                                                                                                  |
| Approvals                | Dangerous command (`rm -rf build`) → server→client request `approval` with `choices: once/session/always/deny`; `deny` blocked (directory kept), `once` ran it. Harmless `ls` ran without asking (denylist model)                                                                           |
| Every-command approval   | A 10-line profile plugin returning `{"action":"approve"}` from `pre_tool_call` raised the same `approval` request for every `terminal` call. The card shows `<terminal> (plugin approval rule)`, so the plugin message must carry the command; `always` would allow-list the whole rule key |
| Interrupt                | `session.interrupt` during a streaming turn → `{"status":"interrupted"}` and a terminal `message.complete`                                                                                                                                                                                  |
| Restart persistence      | New process, `session.resume <stored id>` restored all 14 rows including tool rows                                                                                                                                                                                                          |
| Many agents, one process | `profiles.create` + `session.create {profile}` ran a second profile in the same process with its own `SOUL.md` and plugins (the guard plugin only applied to that profile)                                                                                                                  |
| Memory                   | RSS ≈ 178 MB with one profile, ≈ 327 MB after a turn in a second profile                                                                                                                                                                                                                    |
| Env isolation            | Launch profile `.env` values reach that profile's shell; a secondary profile saw neither the launch value nor its own `.env` value                                                                                                                                                          |
| Cron                     | `hermes cron create/run/runs` work headless; durable `executions.db`, per-job model, workdir, skills, toolsets, delivery target; scheduling needs the messaging gateway (or `cron tick`)                                                                                                    |
| Messaging gateway        | `hermes gateway run` hosts platforms, cron and the API server; one host gateway serves all profiles (`gateway.multiplex_profiles`)                                                                                                                                                          |
| Process ownership        | A Hermes command started a detached host gateway (`--idle-exit`, launched through `osascript`, parent PID 1) without being asked. A stdio TUI gateway is refused while a gateway owns the home ("attach to it instead")                                                                     |
| Config ownership         | Hermes wrote `onboarding.seen.*`, `gateway.multiplex_profiles` and `_config_version` into `config.yaml` on its own                                                                                                                                                                          |
| API server               | Needs the `messaging` extra (aiohttp). `/v1/capabilities`: runs, SSE events, approval, steer, stop, sessions, skills; `admin_config_rw`, `jobs_admin`, `memory_write_api` are hard-coded `false`. Unauthenticated → 401                                                                     |

## Static mapping (docs and source)

| Area                               | Verdict         | Note                                                                                                                                                                  |
| ---------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions, chat, compaction, titles | native          | Richer than OpenClaw: idempotent create, event replay, `inflight`, `open_requests`                                                                                    |
| Many agents                        | adapter         | Profile = agent; one process serves all. MCP registration and terminal env are process-wide in the multiplexer (upstream known limitation)                            |
| Config                             | adapter         | No generic patch with base hash; `config.set` is a fixed setter list. Hermes writes the same file                                                                     |
| Shell and approvals                | adapter         | Denylist + optional LLM (`smart`) by default; every-command mode via the guard plugin; allowlist has no argument patterns                                             |
| Tool guard and team tools          | adapter         | `pre_tool_call` block/approve/modify equals the OpenClaw guard; hooks time out after 30 s (fail closed), so long waits must be tools. Team plugin needs Python or MCP |
| MCP                                | native          | Per profile, stdio/HTTP, OAuth, trust and spend limits; affected by the process-wide registration                                                                     |
| Skills                             | adapter         | Agents write their own skills by default                                                                                                                              |
| Routines                           | native          | Dashboard REST `/api/cron/jobs*` and CLI                                                                                                                              |
| Memory                             | adapter         | `MEMORY.md`/`USER.md` with hard size limits; REST `/api/memory`                                                                                                       |
| Telegram                           | native/adapter  | Per-profile bots and pairing REST; Deepgram needs a transcription plugin                                                                                              |
| Models                             | adapter         | Custom/Ollama/llama.cpp/Azure native; inject keys via secret source; turn off `adopt_external_logins`; Codex subscription refresh tokens must not be shared           |
| Web, browser, images, PDF          | adapter / gap   | Turn off `web.keyless_fallback`. No screencast/takeover API: AgentPier would own each agent's Chromium and pass `browser.cdp_url`                                     |
| Subagents                          | native          | `delegate_task` stays on: owner decision, Hermes may use invisible subagents for its work                                                                             |
| Control-plane security             | adapter, weaker | Loopback HTTP without TLS, tickets from the owner-only `gateway.sock`; any process of the OS user, including the agent's shell, can reach it. stdio avoids this       |
| Install and update                 | adapter         | Python 3.14 toolchain, frequent releases, no downgrade (snapshot restore), lazy extra installs at runtime                                                             |

## Conclusion

Parity is reachable for chat, sessions, approvals, routines, MCP, skills, memory, models
and Telegram. Two areas need AgentPier-owned work: browser live view/takeover (own the
Chromium, CDP screencast) and per-agent isolation of MCP and terminal env if several
agents share one process. The alternative is one Hermes process per agent at ≈ 150–180 MB
each.

Recommended shape (decided in [ADR 0006](../adr/0006-assistant-runtime-port.md)):

1. A runtime port in AgentPier (`host`, `sessions`, `events`, `approvals`, `routines`,
   `agentFiles`, `skills`, `mcp`, `browser`, `capabilities()`), OpenClaw first as the only
   adapter.
2. Hermes adapter: one supervised process per agent with its own `HERMES_HOME`, driven
   over stdio TUI-RPC (no network listener, no ticket socket reachable by agents). Cron
   and Telegram need the messaging gateway of that home, so either attach to it or let
   AgentPier own both processes. Disable Hermes self-spawned gateways.
3. AgentPier compiles `config.yaml`/`.env` per profile from its neutral model and treats
   Hermes-written keys as runtime state to preserve.
4. Practical defaults from the start: Hermes's own approval model (ask on dangerous
   commands) as the default shell mode, every-command approval via the guard plugin as
   the stricter option, full access as today.

## Owner decisions (2026-11-01)

- **One Hermes process per agent.** This removes the process-wide MCP and terminal-env
  limitation of the multiplexer at ≈ 150–180 MB per agent.
- **Invisible subagents are allowed.** Hermes may delegate internally; AgentPier's
  visible teams remain a separate, owner-facing feature.
- **Practical defaults from the start**, as listed in the recommended shape.

## Open questions

- Attaching to a running messaging gateway (control-socket ticket → `/api/ws`) versus
  running cron/Telegram in an AgentPier-owned process.
- Which Hermes command started the detached gateway, and the flag that prevents it.
- Real Telegram, Codex login, browser CDP handoff, Linux.
