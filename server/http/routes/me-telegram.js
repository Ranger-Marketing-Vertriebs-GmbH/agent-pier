import { Router } from "express";
import { canPairTelegram } from "../../features/users/user-access.js";
import { userProblem } from "../../features/users/user-errors.js";
import { mainConversation } from "../../features/assistants/routine-targets.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
// What she sees of her bot: never its token, nor anything of other chats.
export const telegramView = (channel) =>
  channel && {
    id: channel.id,
    username: channel.username,
    enabled: channel.enabled === true,
    // Whether the bot's token is stored: a disconnected bot needs a new one.
    connected: channel.hasSecret === true,
    // Paired and delivering: a bot paused or disconnected with its chat kept needs
    // pairing (or reconnecting) again, which her app then offers.
    paired: !!channel.chatId && channel.enabled === true,
    pairingExpiresAt: channel.pairingExpiresAt ?? null,
    language: channel.language,
    revision: channel.revision,
  };

/** Her agent's bot, the one delivering into her own main chat, or null. */
export function userChannel(assistants, channels, agentId, userId) {
  const chat = mainConversation(assistants.store, agentId, userId);
  return (
    (chat &&
      channels?.store
        .list()
        .find((c) => c.assistantId === agentId && c.conversationId === chat.id)) ||
    null
  );
}

/**
 * An Extended user connects her own agent's Telegram bot to her main chat. Shared
 * agents and lower levels are refused (USER_LEVEL); the bot token never leaves.
 */
export function meTelegramRoutes({ assistants, assistantChannels: channels, userScope }) {
  const router = Router();
  const mine = (req) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    if (!canPairTelegram(agent, req.principal.userId)) throw userProblem("USER_LEVEL");
    return agent;
  };
  const channelOf = (agent, userId) =>
    userChannel(assistants, channels, agent.id, userId);
  const body = (req) => (record(req.body) ? req.body : {});
  router.get("/me/agents/:id/telegram", (req, res) => {
    const agent = mine(req);
    res.json({ channel: telegramView(channelOf(agent, req.principal.userId)) });
  });
  router.put("/me/agents/:id/telegram", async (req, res) => {
    const agent = mine(req);
    const { token, language } = body(req);
    const current = channelOf(agent, req.principal.userId);
    const create = () =>
      channels.create(
        { assistantId: agent.id, token, ...(language && { language }) },
        { userId: req.principal.userId },
      );
    let channel;
    // A disconnected bot she replaces with another one (a different bot's token): the
    // new bot is checked first, then the old one is forgotten and the new one starts
    // unpaired. A connected bot is never replaced (update refuses another bot).
    if (current && !current.hasSecret && typeof token === "string") {
      const identity = await channels.identify(token);
      if (String(identity.id) !== current.botId) {
        channels.requireFreeBot(identity.id, current.id);
        await channels.forget(current.id);
        channel = await create();
      }
    }
    channel ??= current
      ? await channels.update(current.id, { token, revision: current.revision })
      : await create();
    // The same bot connected again after Disconnect delivers to her paired chat again.
    if (current && !current.hasSecret && channel.chatId && !channel.enabled)
      channel = await channels.update(channel.id, {
        enabled: true,
        revision: channel.revision,
      });
    res.json({ channel: telegramView(channels.store.get(channel.id)) });
  });
  router.post("/me/agents/:id/telegram/pair", async (req, res) => {
    const agent = mine(req);
    const current = channelOf(agent, req.principal.userId);
    if (!current) throw userScope.refusal();
    const { appUrl, language } = body(req);
    const { code, url, expiresAt } = await channels.pair(
      current.id,
      current.revision,
      appUrl,
      language,
    );
    res.json({ code, url, expiresAt });
  });
  router.delete("/me/agents/:id/telegram", async (req, res) => {
    const agent = mine(req);
    const current = channelOf(agent, req.principal.userId);
    if (!current) throw userScope.refusal();
    await channels.disconnect(current.id, current.revision);
    res.json({ channel: telegramView(channels.store.get(current.id)) });
  });
  return router;
}
