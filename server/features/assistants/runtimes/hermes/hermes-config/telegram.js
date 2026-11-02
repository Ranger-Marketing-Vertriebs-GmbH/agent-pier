import {
  deepgramDirectory,
  deepgramFiles,
  deepgramKeyEnv,
  deepgramPlugin,
} from "./deepgram-plugin.js";

// The agent's own Telegram bot for other people (the `channelBots` capability) as
// Hermes's own Telegram adapter runs it in the agent's messaging gateway
// (plugins/platforms/telegram at Hermes v0.22.5, website/docs/user-guide/messaging/
// telegram.md). One home, one bot token, one poller: the token is the agent's bot
// alone, never the owner's AgentPier bot (native-telegram-store.js requireFree).
//
// - The token goes to .env as TELEGRAM_BOT_TOKEN, which enables the adapter
//   (gateway_env.py ENV_ENABLE_CREDENTIALS) and which Hermes strips from every
//   command and process it starts (local_env_policy.py `_ALWAYS_STRIP_KEYS`).
// - `platforms.telegram.extra` holds the access rules: `allow_from` the allowed
//   people's numeric ids, `dm_policy: allowlist` (strangers get no reply and no
//   pairing code: run_inbound_unauthorized.py), `allowed_chats` with no real chat
//   (no group chats), and slash commands gated with an admin nobody is (gateway/
//   slash_access.py: only the read-only /help and /whoami floor stays).
// - Voice notes go to AgentPier's Deepgram plugin (deepgram-plugin.js) with the
//   speech settings' model and language; without a key `stt.enabled: false`, so no
//   local or other cloud transcription runs (as on OpenClaw).
//
// `apiRoot` and `deepgram` are test seams (TelegramSenders' options): a loopback Bot
// API (`base_url`) and Deepgram endpoint; production compiles neither.

export const telegramTokenEnv = "TELEGRAM_BOT_TOKEN";
// Every .env name this module owns: a home without a bot or key removes them.
export const channelBotEnvNames = Object.freeze([telegramTokenEnv, deepgramKeyEnv]);
// Toolsets an agent serving other people does not get, beside shell (which such an
// agent never has): recall of the owner's past conversations and remote connector
// accounts (toolsets.py `session_search`, `connections`), as OpenClaw's agents with a
// bot get no session tools.
export const senderLockedToolsets = Object.freeze(["connections", "session_search"]);
// Hermes's own seed IPv4 addresses for api.telegram.org (plugins/platforms/telegram/
// telegram_network.py SEED_FALLBACK_IPS). Without a configured list the adapter asks
// Google's and Cloudflare's DNS-over-HTTPS resolvers for the host at every connect
// (adapter.py, discover_fallback_ips): a lookup at a third party the owner did not
// choose. A fixed list skips it and keeps what the fallback is for: IPv4 literals
// tried before the dual-stack host name, so a blackholed IPv6 path cannot pin the
// adapter's start. The host name stays the last path, with the system's resolver.
export const telegramFallbackIps = Object.freeze(["149.154.166.110", "149.154.167.220"]);
// No Telegram user has this id: it turns command gating on with no admin.
const nobody = "0";

/** Whether the desired agent runs a bot for other people: allowed, with people. */
export function botActive(agent) {
  const bot = agent.channelBot;
  return !!bot?.token && !!agent.channels?.telegram?.eligible && bot.people?.length > 0;
}

/**
 * What the home needs for the agent's bot, when its desired state names one
 * (`agent.channelBot` known): `{ config, env, plugin, files, remove, senders }`.
 * `config` are config.yaml entries, `env` the .env values (owned:
 * channelBotEnvNames), `plugin` the plugin name to enable, `senders` whether the
 * sender lock applies. Pure.
 */
export function channelBotHome(agent) {
  const bot = agent.channelBot;
  const active = botActive(agent);
  const speech = active && bot.speech?.apiKey ? bot.speech : null;
  const telegram = active
    ? {
        enabled: true,
        // A home channel nobody's chat is: Hermes otherwise asks each person's first
        // message to type /sethome (gateway/run_turn_prepare.py), which they cannot.
        home_channel: { platform: "telegram", chat_id: nobody, name: "AgentPier" },
        extra: {
          allow_from: bot.people.map(String),
          dm_policy: "allowlist",
          unauthorized_dm_behavior: "ignore",
          // Group chats: `allow_from` admits a person in any chat type, so only a
          // chat list nobody's chat is on keeps groups out (adapter.py
          // `_should_process_message`; DMs are never filtered by it).
          allowed_chats: [nobody],
          guest_mode: false,
          gateway_restart_notification: false,
          allow_admin_from: [nobody],
          user_allowed_commands: [],
          group_allow_admin_from: [nobody],
          group_user_allowed_commands: [],
          // No DNS-over-HTTPS lookups at third parties (telegramFallbackIps); the
          // fallback applies to api.telegram.org only, so a test's loopback API too.
          fallback_ips: [...telegramFallbackIps],
          ...(bot.apiRoot && {
            base_url: `${bot.apiRoot}/bot`,
            base_file_url: `${bot.apiRoot}/file/bot`,
          }),
        },
      }
    : undefined;
  const stt = speech
    ? {
        enabled: true,
        provider: deepgramPlugin,
        [deepgramPlugin]: {
          model: speech.model,
          language: speech.language,
          keyterms: [...new Set(["AgentPier", agent.name].filter(Boolean))],
          ...(bot.deepgram && { base_url: bot.deepgram }),
        },
      }
    : { enabled: false };
  return {
    config: [
      [["platforms", "telegram"], telegram],
      [["stt"], stt],
    ],
    env: {
      ...(active && { [telegramTokenEnv]: bot.token }),
      ...(speech && { [deepgramKeyEnv]: speech.apiKey }),
    },
    plugin: speech ? deepgramPlugin : null,
    files: speech ? deepgramFiles : {},
    remove: speech ? [] : [deepgramDirectory],
    senders: active,
  };
}
