import { readTelegramInputs, telegramEligible } from "./telegram-inputs.js";
import { ownProcess } from "../assistants/runtimes/runtime-for.js";

// Agents' own Telegram bots on a runtime that runs each agent in a process set of its
// own (Hermes, ADR 0006 decision 4): the bot runs on the runtime's own Telegram
// adapter inside that agent's set (runtimes/hermes/hermes-config/telegram.js), not
// in the shared OpenClaw Gateway. AgentPier keeps the token, the allowed people and
// the speech key as for OpenClaw (native-telegram-store.js); the agent's apply
// compiles them into its home (assistant-config.js applyOwnProcess `channelBot`), and
// a changed home restarts only that agent's set, so no Gateway restart is asked for.
// Other people's conversations stay in the runtime's own sessions, as on OpenClaw:
// they belong to no AgentPier chat.

/**
 * What the agent's apply compiles for its own bot (desiredAgent `channelBot`):
 * `{ token, people, tokenRevision, speech, apiRoot?, deepgram? }`, null without a bot,
 * undefined while the store cannot be read (the home keeps what it has).
 */
export function ownBotRead(senders, profile) {
  const inputs = readTelegramInputs(senders.store, senders.speech, {
    apiRoot: senders.apiRoot,
    deepgram: senders.deepgram,
  });
  if (inputs.unreadable) return undefined;
  const account = inputs.accounts.find((a) => a.assistantId === profile.id);
  if (!account) return null;
  return {
    token: account.token,
    tokenRevision: account.tokenRevision,
    people: account.people,
    speech: inputs.speech
      ? {
          apiKey: inputs.speech.apiKey,
          model: inputs.speech.model,
          language: inputs.speech.language,
        }
      : null,
    ...(inputs.apiRoot && { apiRoot: inputs.apiRoot }),
    ...(inputs.deepgram && { deepgram: inputs.deepgram }),
  };
}

/** Applies the agents `ids` that run in their own set; never rejects. */
export async function applyOwnBots(senders, ids) {
  const store = senders.assistants.store;
  const config = senders.assistants.config;
  await Promise.all(
    ids
      .map((id) => store.getAssistant(id))
      .filter((profile) => ownProcess(profile) && !profile.archivedAt)
      .map((profile) =>
        config
          .apply(profile.id)
          .catch((error) =>
            senders.warn(
              `The agent's own Telegram bot could not be applied (${error?.code || error?.key || "ERROR"}).`,
            ),
          ),
      ),
  );
}

/** The agents with a bot that run in their own set. */
export const ownBotAgents = (senders) =>
  senders.store
    .list()
    .map((bot) => bot.assistantId)
    .filter((id) => {
      try {
        return ownProcess(senders.assistants.store.getAssistant(id));
      } catch {
        return false;
      }
    });

/**
 * The state of an agent's own bot on its own set, as TelegramSenders.status names
 * them: `stopped` (the set does not run), `pending` (an apply is on its way),
 * `starting`, `running` or `error` (the adapter gave up: a refused token, another
 * poller), `inactive` (nobody allowed or the agent cannot own a bot).
 */
export async function ownBotStatus(senders, profile, bot) {
  if (
    !bot.people.length ||
    !telegramEligible(profile, senders.stdioAgents(), senders.sshAgents())
  )
    return { state: "inactive" };
  const runtime = senders.runtimeFor(profile);
  if (!runtime.host.ready()) return { state: "stopped" };
  if (senders.assistants.config?.applying?.(profile.id)) return { state: "pending" };
  let account;
  try {
    const status = await runtime.channels.status({ probe: false });
    account = status?.channelAccounts?.telegram?.[0];
  } catch {
    return { state: "stopped" };
  }
  if (!account) return { state: "starting" };
  if (account.lastError) return { state: "error" };
  return { state: account.running && account.connected ? "running" : "starting" };
}
