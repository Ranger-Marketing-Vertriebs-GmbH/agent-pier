import { boundPort, reachable } from "./hermes-connection.js";

/**
 * The channels sub-port (agent-runtime.js) of one Hermes agent. The owner's Telegram
 * chat reaches a Hermes agent through AgentPier's own channel layer
 * (assistant-channels/: pairing, ingress, voice transcription, outbox), which hands
 * each input to the agent's session like a web turn and sends the reply from its
 * history, as for OpenClaw agents. Hermes runs no channel account of its own: its
 * Telegram adapter stays off (no TELEGRAM_BOT_TOKEN in its home), so status() names
 * no account. An agent's own bot for other people needs that adapter and is the
 * `channelBots` capability, which Hermes does not offer yet.
 */
export const hermesChannels = (supervisor) => boundPort(channelsOver, supervisor);

function channelsOver(current) {
  return {
    async status() {
      reachable(current());
      return { channelAccounts: { telegram: [] } };
    },
  };
}
