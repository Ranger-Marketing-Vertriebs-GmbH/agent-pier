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
- **No session tools.** An agent with a bot is not offered `session_status` (or any
  other session tool), so a sender cannot get the status card or reach other
  sessions of the agent; the owner's other agents keep it.
- **No group chats.** A supergroup message, even from an allowed person, never
  reaches the agent and gets no reply.
- **Bad tokens never stop the Gateway.** A token Telegram rejects (401, for example
  after BotFather `/revoke`) and a second poller of a bot (409) leave the Gateway,
  the owner's agents and the other bots running; the section shows the bot's error.
- The owner's AgentPier conversations keep working, including a team proposal while
  bots are compiled; raising the shell level of an agent with a bot is refused, a
  removed bot is no longer polled after the restart, and neither the tokens nor the
  Deepgram key appear in the Gateway logs.

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

- Only personal agents without shell and without stdio MCP servers can own a bot;
  an agent with a bot cannot raise its shell level, bind a stdio server or have a
  bound server turned into one, and it cannot be archived until the bot is
  disconnected. Allowed people can read and use the agent's memory; web tools and
  remote MCP servers stay as the owner chose them.
- `tools.agentToAgent.enabled: false` while any bot is compiled; session visibility
  is owned by the proactivity work (`tools.sessions.visibility`).
- A bot id serves either the owner's AgentPier bot or one agent: both setups refuse
  the other's bot.
- Telegram sections exist only in the startup configuration. A save that changes
  what the running or starting Gateway compiled restarts it after the owner
  confirmed, like the web search settings. A revocation (a removed bot or person, a
  replaced token or speech key) that slipped past a start restarts the Gateway once
  it answers; additions stay "pending" until the owner applies them. Every
  comparison uses the agents the next start finds in `openclaw.json`, the same set
  the start compiles from, so a configured agent whose first apply never finished
  causes no restart. Each revocation gets at most one automatic restart; refusals
  (busy agents) back off from 30 seconds and stop after five attempts. A revocation
  that is still running then shows an error asking the owner to restart.
- States: `running`, `starting`, `error`, `stopped` (no Gateway), `pending` (saved,
  not in the running Gateway yet; "Apply now" restarts) and `inactive` (nobody
  allowed, the agent cannot own a bot, or the agent has no Gateway entry until its
  first apply). Only the agent concerned shows a pending change.
- Tokens live in `native_telegram_credentials` (sealed in update and host backups)
  and in the private `openclaw.json` (sealed copies in backups). Replacing or
  removing a token, and changing or removing the Deepgram key while a bot exists,
  destroys the backup keys first; a key change also asks to restart a Gateway that
  uses another key. OpenClaw's own local copies beside `openclaw.json` (`.bak*`,
  `.last-good`) can keep a removed token until they rotate; they stay in the private
  state directory. Update backups made while an earlier, since-removed bot ran keep
  that Deepgram key sealed until they expire: a later key change with no bot left
  does not destroy their keys. Answers, audit records and logs never carry a token,
  id or name.
- Deepgram's media model is global in OpenClaw: any audio reaching an agent session
  is transcribed with the owner's key while a bot with voice is compiled.
- Locking `models.providers.deepgram` also refuses overrides of the parents `models`
  and `models.providers`; such stored overrides are skipped at the next start.

## Release checklist

A release that changes the Telegram layer, `TelegramSenders`, the compiler's locked
paths or the pinned OpenClaw version must pass
`tests/integration/assistant-telegram-senders-contract.test.js` with no skips (it
runs in the `native-contracts` CI job), together with the team, native interface and
memory contracts, which share the compiled configuration.
