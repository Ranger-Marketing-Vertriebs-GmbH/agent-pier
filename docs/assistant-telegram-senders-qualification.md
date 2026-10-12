# Agents' own Telegram bots: qualification

An agent can get its own Telegram bot for other people (AGENTPIER-26). OpenClaw
runs the bot natively inside the agents' Gateway; AgentPier stores the token and the
allowed people and compiles them at each Gateway start
(`server/features/assistants/openclaw-config/telegram-senders.js`). The owner's own
AgentPier bot (`server/features/assistant-channels/`) is unchanged and separate.

## Evidence

`tests/integration/assistant-telegram-senders-contract.test.js` drives AgentPier's
compiled path on OpenClaw 2026.9.8 (`AGENTPIER_TELEGRAM_SENDERS_CONTRACT_RUNTIME`).
Telegram is a loopback Bot API (`tests/helpers/assistant-telegram-fakes.js`) reached
through `channels.telegram.apiRoot`; Deepgram is a loopback `/listen` endpoint. No
request leaves the machine. The contract verifies:

- **One account per agent.** `channels.telegram.accounts.<runtime agent id>` with a
  top-level binding `{ agentId, match: { channel: "telegram", accountId } }` routes
  the bot's messages to that agent. A loopback `apiRoot` needs no private-network
  opt-in.
- **Allowlist.** `dmPolicy: "allowlist"` with numeric `allowFrom` admits only those
  senders; a sender allowed on another agent's bot is ignored without a reply and
  never reaches the model. The channel root stays `dmPolicy: "disabled"` and
  `groupPolicy: "disabled"`.
- **One conversation per sender.** `session.dmScope: "per-account-channel-peer"`
  gives `agent:<agent>:telegram:<account>:direct:<user id>` sessions.
- **No commands.** `commands.allowFrom: { telegram: [] }` refuses `/status`, `/new`,
  `/think` and `/model` before the model. Without it, an allowed sender got the
  status report (model, auth mode, session key), changed the thinking level and
  reset the session.
- **No AgentPier tools.** The team plugin's tools answer `FORBIDDEN` for these turns:
  their session keys belong to no AgentPier conversation (`team-bridge.js`).
- **Voice notes.** With `tools.media.models: [{ provider: "deepgram", ... }]`,
  `tools.media.audio.enabled: true` and the key in `models.providers.deepgram`
  (`apiKey`, `baseUrl` and `models: []` are required for a provider without a model
  catalog), OpenClaw uploads the note to Deepgram with `Token <key>` and the speech
  settings' language, and the model receives the transcript as untrusted text.
  Without a key, `tools.media.audio.enabled: false` keeps notes untranscribed (no
  local fallback).
- The owner's AgentPier conversations keep working, raising the shell level of an
  agent with a bot is refused, a removed bot is no longer polled after the restart,
  and neither the tokens nor the Deepgram key appear in the Gateway logs.

Facts found while qualifying:

- OpenClaw refuses the whole configuration (`bindings[0].agentId: Unknown agent id`)
  when a binding names an agent it does not define. The compiler therefore compiles
  a bot only for agents present in the configuration's agent entries; a bot saved for
  an agent before its first apply waits for the next start (the section offers
  "Apply now").
- The loopback Deepgram fake needs `models.providers.deepgram.request.
allowPrivateNetwork: true`; production compiles Deepgram's public base URL and
  never sets it. The test seams (`apiRoot`, Deepgram base URL) are constructor
  options of `TelegramSenders`, never stored settings.

## Boundaries

- Only personal agents without shell can own a bot; an agent with a bot cannot raise
  its shell level. Memory, web tools and MCP servers stay as the owner chose them.
- `tools.agentToAgent.enabled: false` while any bot is compiled; session visibility
  is owned by the proactivity work (`tools.sessions.visibility`).
- A bot id serves either the owner's AgentPier bot or one agent: both setups refuse
  the other's bot.
- Telegram sections exist only in the startup configuration. A save that changes
  what the running Gateway was started with restarts it after the owner confirmed,
  like the web search settings; a new speech key shows as pending until applied.
- Tokens live in `native_telegram_credentials` (sealed in update backups) and in the
  private `openclaw.json` (sealed copies). Replacing or removing a token destroys the
  backup keys. Answers, audit records and logs never carry a token, id or name.

## Release checklist

A release that changes the Telegram layer, `TelegramSenders`, the compiler's locked
paths or the pinned OpenClaw version must pass
`tests/integration/assistant-telegram-senders-contract.test.js` with no skips (it
runs in the `native-contracts` CI job), together with the team, native interface and
memory contracts, which share the compiled configuration.
