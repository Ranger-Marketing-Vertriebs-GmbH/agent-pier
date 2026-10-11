# Native OpenClaw capabilities in AgentPier

Status: agreed design (umbrella). Each step below gets its own spec, plan and pull
request.

Date: 2026-10-11

## Goal

AgentPier runs a managed OpenClaw Gateway, but exposes only part of it: chat, agent
profiles, native memory, reminders and routines on native cron, model logins and
teams. Many native capabilities are switched off in `runtime-config.js`, and
Telegram is an AgentPier-built bot next to OpenClaw's own Telegram channel.

AgentPier should make OpenClaw's native capabilities usable instead of stripping or
rebuilding them. The owner can switch them on, configure them and use them from
AgentPier, including from an iPhone, without a terminal or config files.

AgentPier's guarantees stay in place: owner login, no credentials in the browser,
isolated accounts, and a pinned, qualified OpenClaw version.

### Stages

- **Stage 1 (this design):** only the owner uses the agents.
- **Stage 2 (later):** other people use agents, for example an agent the owner
  creates for a family member with chosen permissions and access over Telegram.
  Stage 1 must not prevent this: channels, agents and permissions are modelled
  separately from the start.

## Evidence

The capability inventory was taken from the OpenClaw 2026.9.8 package (docs and
shipped code; nothing was executed). Facts marked as unverified are checked live in
step 1.

- `config.schema` returns the full config schema with UI hints and channel and
  plugin schemas; `config.schema.lookup` reports per path whether a change is
  hot-applied or needs a restart. Writes use `config.patch` with `baseHash`.
- Telegram, A2A and Reef are bundled. WhatsApp, Signal, Discord, Slack and the
  other channels are official plugins that OpenClaw installs from npm or ClawHub on
  demand. WhatsApp logs in by QR via `web.login.start` and `web.login.wait`.
- Unknown senders get a pairing code (`dmPolicy: pairing`, the default); approvals
  use `channels.pairing.{list,approve,dismiss}`. `allowlist`, `open` and `disabled`
  are the other policies.
- Telegram voice notes are transcribed natively through the media pipeline
  (Deepgram is bundled).
- 51 skills are bundled; skills from ClawHub are untrusted code.
- Host `exec` defaults to full security with no approval prompts and no sandbox.
  Exec approvals (`tools.exec.mode`: `deny`, `allowlist`, `ask`, `auto`, `full`) and
  `exec.approvals.*` RPCs exist. A Docker sandbox exists and is off by default.
- The browser tool may attach to the user's real signed-in Chrome (`user` profile);
  the isolated `openclaw` profile does not.
- The operator terminal (`gateway.terminal.enabled`) defaults to on and gives
  admin-scoped clients a host shell. AgentPier does not set the key today.
- The Control UI is a full admin workbench (host terminal, raw config editor, RPC
  console, ClawHub installs, self-update, public session share links). It refuses
  framing (`X-Frame-Options: DENY`, not configurable).
- OpenClaw's multi-user layer (profiles, roles, per-person model accounts) is "not
  a security boundary"; OpenClaw recommends one Gateway per tenant.
  `tools.sessions.visibility` defaults to `all`, and agent-to-agent access is on.

## Approaches considered

- **Embed OpenClaw's Control UI behind AgentPier login.** Rejected. It would give
  every user full Gateway admin, including a host terminal, raw config edits that
  bypass AgentPier's settings, ClawHub installs and self-updates that bypass the
  pinned version. It also cannot be framed.
- **Generic settings generated from `config.schema`.** Adopted for everything that
  has no dedicated UI ("advanced settings").
- **Native first, capability by capability.** Adopted as the core: each capability
  gets an AgentPier UI that drives OpenClaw's native feature, with a safety rule
  and tests. AgentPier stops rebuilding features OpenClaw already provides.

## Capabilities and decisions (stage 1)

| Capability                                                    | Decision                                                                                                                                                                                                                                                                                                      | Safety rule                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Telegram                                                      | Move the AgentPier-built bot to OpenClaw's native channel, including voice-note transcription                                                                                                                                                                                                                 | Pairing codes approved in AgentPier; by default only the owner may write |
| WhatsApp, Signal, Discord and others                          | Allowed only for channels that AgentPier adds to the qualified runtime lock; no on-demand installs. WhatsApp first, with QR login in AgentPier                                                                                                                                                                | As Telegram                                                              |
| Skills                                                        | The bundled skills can be switched on per agent; missing requirements (binaries, API keys) are shown                                                                                                                                                                                                          | No ClawHub installs                                                      |
| Web search and fetch                                          | Per agent                                                                                                                                                                                                                                                                                                     | Search provider keys live in AgentPier's central credentials             |
| Browser                                                       | Per agent                                                                                                                                                                                                                                                                                                     | Only the isolated `openclaw` profile, never the user's signed-in Chrome  |
| Shell (`exec`)                                                | Three levels per agent: **off** (default), **with approval** (each command becomes an approval request in AgentPier), **full** (no prompts; enabling requires a clear warning that the agent runs commands with the user's macOS rights, and an explicit confirmation). The agent shows its level permanently | Docker sandbox follows later                                             |
| MCP servers                                                   | Per agent                                                                                                                                                                                                                                                                                                     | Credentials stay in the backend                                          |
| Images, speech output, PDF                                    | Through the existing model providers                                                                                                                                                                                                                                                                          | —                                                                        |
| Proactivity: heartbeat, dreaming, recall across conversations | Opt-in per agent                                                                                                                                                                                                                                                                                              | Off by default, as today; token cost is shown                            |
| Mail and calendar                                             | No dedicated feature; through skills (for example `gog`, `himalaya`) or MCP                                                                                                                                                                                                                                   | —                                                                        |
| Advanced settings                                             | Schema-driven page for everything else, showing per setting whether it applies at once or needs a restart                                                                                                                                                                                                     | Locked paths are filtered out                                            |
| Operator terminal                                             | Explicitly off                                                                                                                                                                                                                                                                                                | —                                                                        |

**Always locked (owned by AgentPier):** Gateway, auth and TLS; Control UI and
terminal; updates (`update.*`); plugin install sources; discovery; the team plugin
and its tools.

**Later:** stage 2 multi-user; Docker sandbox; ClawHub skills with review;
third-party plugins; nodes and the OpenClaw mobile apps (they extend shell access to
more devices); Talk mode; canvas and widgets (they render in the Control UI);
inbound webhooks. **Not planned:** the Control UI.

## Architecture

### 1. AgentPier owns the configuration

AgentPier regenerates `openclaw.json` on every start, so changes sent straight to
the Gateway would be lost. AgentPier stores every setting itself and generates the
configuration from three layers:

1. **Locked core**, owned by AgentPier: Gateway, auth, TLS, terminal off, updates,
   plugin sources, and the team plugin. It cannot be changed and is applied last,
   so nothing can override it.
2. **Capability profiles per agent**: channels, skills, tools with the shell level,
   browser, MCP and proactivity, stored in AgentPier and compiled into native
   `agents.entries.<id>.tools`, `agents.entries.<id>.skills` and `channels.*`.
3. **Advanced settings**: owner overrides from the schema-driven page, stored in
   AgentPier, with locked paths filtered out.

Changes reach the running Gateway through `config.patch`; a restart need reported
by `config.schema.lookup` is shown to the owner. A later start produces the same
configuration from the stored layers.

### 2. One backend module per capability

Under `server/features/assistants/`, each with a narrow interface and its own tests:

- `channels`: token setup, WhatsApp QR (`web.login.start` and `web.login.wait`),
  start and stop, pairing requests.
- `skills`: catalog, requirements, assignment per agent.
- `tool-policy`: compiles a capability profile into native tool lists and the exec
  mode.
- `advanced-config`: loads the schema, filters locked paths, validates and applies
  overrides.

The web UI talks only to the AgentPier backend, never to the Gateway.

### 3. More Gateway events

AgentPier listens only to `chat` events today. It adds exec approval requests,
pairing requests and channel status. They appear in the existing approval UI and as
notifications, so the owner can approve a shell command or a new Telegram sender
from an iPhone. The event names are unverified and are checked in step 1.

### 4. Replacing the Telegram bot

The bot token and the Deepgram key move from `server/features/assistant-channels/`
into the native configuration; secrets stay in the backend. Existing pairings carry
over, so the owner's Telegram account lands on the allowlist. The migration runs
automatically on update for existing installations; the AgentPier-built bot is
removed afterwards.

### 5. The pinned version stays

Each capability gets contract tests against the pinned OpenClaw version, following
the existing qualification documents, and a version update requalifies them as it
does the write guard today. Channel plugins such as WhatsApp enter the qualified
runtime lock through `scripts/refresh-assistant-runtime-lock.mjs`.

### 6. Ready for stage 2

Channels, agents and permissions are modelled separately, so bindings and senders
per agent can be added later without reshaping the model.

### 7. Teams keep working

- The team plugin, its loading and its tools (`agentpier_team_*`,
  `agentpier_reminder`, `agentpier_routine`, `agentpier_workspace`) belong to the
  locked core. Neither a capability profile nor advanced settings can remove or
  override them.
- The tool module builds each agent's tool list as core plus profile; today's team
  and memory tools always remain.
- The team write guard covers `read`, `write` and `edit`. Shell and browser could
  bypass it, so team members get them only when the team model explicitly allows
  it; the default is off. Whether the guard extends to new tools or those tools stay
  locked for team members is decided in the team-related step.
- Heartbeat needs `cron.enabled`. Enabling cron for it must not change reminders,
  routines or team behaviour. Later cross-agent restrictions must not cut off team
  coordination.
- Every step runs the existing team contract and qualification tests; a step is
  done only when they pass.

## Steps

| #   | Step                                                                                                                                                                                                                                        | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0   | Switch off the operator terminal (`gateway.terminal.enabled: false`), with a test                                                                                                                                                           | —          |
| 1   | Foundation: three configuration layers (core including the team plugin, profiles, overrides), more Gateway events, live verification of the required interfaces against 2026.9.8 (`config.schema`, exec approvals, pairing, WhatsApp login) | 0          |
| 2   | Capability profile per agent: UI in the agent settings, web search and fetch, isolated browser, images, speech and PDF, team rules                                                                                                          | 1          |
| 3   | Shell in three levels, with exec approvals in AgentPier and the warning for full access                                                                                                                                                     | 2          |
| 4   | Native Telegram: migrate the AgentPier-built bot, pairing approvals, voice notes, then remove the bot                                                                                                                                       | 1          |
| 5   | WhatsApp: plugin in the qualified runtime lock, QR setup in AgentPier                                                                                                                                                                       | 4          |
| 6   | Skills: bundled skills per agent, requirements shown                                                                                                                                                                                        | 2          |
| 7   | MCP servers per agent                                                                                                                                                                                                                       | 2          |
| 8   | Proactivity: heartbeat, dreaming and recall across conversations as opt-ins, cron coordination with teams                                                                                                                                   | 2, 4       |
| 9   | Advanced settings: schema-driven page for everything else                                                                                                                                                                                   | 1          |

After step 1, two tracks can run in parallel: tools (2, then 3, 6, 7) and channels
(4, then 5). Step 9 runs alongside.

Backlog epics: stage 2 multi-user (bindings, senders per agent, separate
conversations, and whether other people need their own Gateway), Docker sandbox,
ClawHub skills with review, nodes, mobile apps, Talk mode and canvas.

## Testing

- Contract tests per capability against the pinned OpenClaw version, using the
  existing assistant test fixtures and isolated data directories.
- Locked-core tests: no profile or override can change a locked path or remove the
  team plugin.
- Browser tests for the new settings UI in German and English, including phone
  size.
- Migration tests for the Telegram move on an existing installation.
- The team contract and qualification tests on every step.
