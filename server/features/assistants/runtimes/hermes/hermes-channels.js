import path from "node:path";
import { readJSON } from "../../../../lib/storage.js";
import { boundPort, reachable } from "./hermes-connection.js";

// Hermes's platform states (gateway/status.py `platform_state`) as a channel
// account's flags: connected polls, connecting and retrying are on their way, fatal
// gave up (a token Telegram refused, another poller), paused and disabled are off.
const states = {
  connected: { running: true, connected: true },
  connecting: { running: true, connected: false },
  retrying: { running: true, connected: false },
  paused: { running: false, connected: false },
  disabled: { running: false, connected: false },
};

/**
 * The channels sub-port (agent-runtime.js) of one Hermes agent. The owner's Telegram
 * chat reaches a Hermes agent through AgentPier's own channel layer
 * (assistant-channels/: pairing, ingress, voice transcription, outbox), which hands
 * each input to the agent's session like a web turn and sends the reply from its
 * history, as for OpenClaw agents. The agent's own bot for other people (the
 * `channelBots` capability) runs on Hermes's own Telegram adapter in the agent's
 * gateway (hermes-config/telegram.js); status() reports it as the one account
 * `{ accountId: <runtime agent id>, running, connected, lastError }`, read from the
 * gateway's runtime record (`gateway_state.json` in the home, `platforms.telegram`),
 * and no account while the home runs no bot.
 */
export const hermesChannels = (supervisor) =>
  boundPort(channelsOver(supervisor), supervisor);

const channelsOver = (supervisor) => (current) => ({
  async status() {
    reachable(current());
    let record = null;
    try {
      const home = supervisor.agentPaths?.().hermesHome;
      record = home ? readJSON(path.join(home, "gateway_state.json"), null) : null;
    } catch {
      record = null;
    }
    const platform = record?.platforms?.telegram;
    if (!platform || typeof platform !== "object")
      return { channelAccounts: { telegram: [] } };
    const flags = states[platform.state] || { running: false, connected: false };
    return {
      channelAccounts: {
        telegram: [
          {
            accountId: supervisor.agentId,
            ...flags,
            lastError:
              platform.state === "fatal" ? String(platform.error_code || "fatal") : null,
          },
        ],
      },
    };
  },
});
